-- ===========================================================================
-- Utilidad por número, y marcha atrás de una liquidación de demostración.
--
-- POR QUÉ HACE FALTA LA PRIMERA
-- -----------------------------
-- `fn_peor_escenario` devuelve UNA fila: el número que más pagaría. Hace
-- exactamente lo que su nombre dice, y para el panel de exposición es lo
-- correcto. Pero el sembrado del histórico la usó como si devolviera los cien,
-- y con noventa y nueve casillas en cero eligió los ganadores a ciegas: los
-- meses salían en cero salvo cuando el azar caía en la única con dato.
--
-- NOMBRES DE SALIDA CON PREFIJO
-- -----------------------------
-- Las columnas de salida se llaman `r_numero`, `r_pago`, `r_utilidad` y no
-- `numero`, `pago`, `utilidad`. En una función `returns table (…)` esos nombres
-- son también variables, y chocan con las columnas homónimas de `allan.linea`
-- en cuanto aparecen sin cualificar —o donde no se PUEDE cualificar—. Es el
-- mismo choque que ya obligó a la 0004 (`fn_registrar_ticket`) y a la 0016
-- (`on conflict (fecha, hora)`). Con prefijo, la clase entera de error
-- desaparece en lugar de esquivarse caso por caso.
-- ===========================================================================

create or replace function allan.fn_utilidad_por_numero(p_sorteo_id uuid)
returns table (r_numero smallint, r_pago numeric, r_utilidad numeric)
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_venta    numeric(14,2) := 0;
  v_comision numeric(14,2) := 0;
begin
  perform allan.fn_exige(array['administrador', 'auditor']::allan.rol_usuario[]);

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0)
  into v_venta, v_comision
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  -- Los cien números, incluidos los que nadie jugó: que un número no tenga
  -- apuestas es información —ahí la casa se queda con la venta entera— y
  -- omitirlo dejaría huecos que quien consuma esto tendría que rellenar.
  return query
  with jugado as (
    select l.numero                             as num,
           sum(l.monto * l.factor_congelado)    as pgo
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id and t.anulado_en is null
    group by l.numero
  )
  select g.i::smallint,
         coalesce(j.pgo, 0)::numeric,
         (v_venta - v_comision - coalesce(j.pgo, 0))::numeric
  from generate_series(0, 99) as g(i)
  left join jugado j on j.num = g.i
  order by g.i;
end;
$$;

comment on function allan.fn_utilidad_por_numero(uuid) is
  'Utilidad del sorteo para cada uno de los 100 números posibles. A diferencia de fn_peor_escenario, que devuelve sólo el peor, aquí están todos.';

-- ===========================================================================
-- Marcha atrás de una liquidación. SÓLO SOBRE DATOS DE DEMOSTRACIÓN.
--
-- Un sorteo liquidado es terminal por diseño (§2): tiene número ganador,
-- premios calculados y liquidación por vendedor, y nada de eso debe poder
-- reescribirse. Esa regla es la que impide que un tablero contradiga a un
-- reporte, y no se toca.
--
-- Esta función existe porque el histórico sintético se liquidó con números
-- elegidos por un guion defectuoso y hay que rehacerlo. Se protege de dos
-- maneras: sólo actúa sobre sorteos cuyas ventas son ÍNTEGRAMENTE de vendedores
-- de demostración (V-101 en adelante), y deja constancia en la bitácora. Un
-- sorteo con una sola venta real queda fuera de su alcance.
-- ===========================================================================

create or replace function allan.fn_desliquidar_demo(p_sorteo_id uuid)
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_total  integer := 0;
  v_reales integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select count(*),
         count(*) filter (where v.codigo !~ '^V-1[0-9]{2}$')
  into v_total, v_reales
  from allan.ticket t
  join allan.vendedor v on v.id = t.vendedor_id
  where t.sorteo_id = p_sorteo_id;

  if v_total = 0 then
    return 'sin ventas: nada que deshacer';
  end if;

  if v_reales > 0 then
    raise exception
      'El sorteo tiene % ventas de vendedores reales. Deshacer una liquidación sólo se permite sobre datos de demostración.',
      v_reales
      using errcode = 'insufficient_privilege';
  end if;

  update allan.linea l
  set gana = false, premio = 0
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and l.gana;

  delete from allan.liquidacion lq where lq.sorteo_id = p_sorteo_id;

  update allan.sorteo s
  set estado = 'cerrado',
      numero_ganador = null,
      liquidado_en = null,
      liquidado_por = null
  where s.id = p_sorteo_id
    and s.estado = 'liquidado';

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'desliquidar_demo', 'estado',
                           'liquidado', 'cerrado');

  return 'deshecho';
end;
$$;

revoke execute on function allan.fn_utilidad_por_numero(uuid) from public, anon;
revoke execute on function allan.fn_desliquidar_demo(uuid) from public, anon, authenticated;
