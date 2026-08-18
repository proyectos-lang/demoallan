-- ===========================================================================
-- Impacto económico de un sorteo.
--
-- Sirve a la pantalla de captura del número ganador: antes de liquidar hay que
-- poder ver cuánto se pagaría con ese número. Se agrega en el servidor porque
-- traer todas las líneas del sorteo al navegador para sumarlas no escala, y
-- porque el cálculo debe salir de un único sitio: si el tablero y esta
-- pantalla sumaran por su cuenta, acabarían discrepando.
--
-- Ambas funciones son de LECTURA. No mutan nada y no liquidan: la liquidación
-- sigue siendo fn_liquidar_sorteo.
-- ===========================================================================

-- --- Impacto de un número candidato ---------------------------------------
-- Con `p_numero` nulo devuelve sólo venta, comisión y tickets — que es el
-- resumen de cabecera del sorteo, sin premios, porque un sorteo no liquidado
-- no tiene premios sino proyecciones.

create or replace function allan.fn_impacto_numero(
  p_sorteo_id uuid,
  p_numero    smallint default null
) returns table (
  venta            numeric,
  comision         numeric,
  tickets          integer,
  lineas_ganadoras integer,
  pago             numeric,
  utilidad         numeric
)
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_venta    numeric(14,2) := 0;
  v_comision numeric(14,2) := 0;
  v_tickets  integer := 0;
  v_ganan    integer := 0;
  v_pago     numeric(14,2) := 0;
begin
  perform allan.fn_exige(array['administrador', 'auditor']::allan.rol_usuario[]);

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         count(distinct t.id)
  into v_venta, v_comision, v_tickets
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null;

  if p_numero is not null then
    -- El pago usa el factor congelado DE CADA LÍNEA, no un factor único: dos
    -- líneas del mismo número pueden llevar factores distintos si el vendedor
    -- cambió de parámetros entre una venta y otra.
    select count(*), coalesce(sum(l.monto * l.factor_congelado), 0)
    into v_ganan, v_pago
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
      and l.numero = p_numero;
  end if;

  return query
    select v_venta, v_comision, v_tickets, v_ganan, v_pago,
           v_venta - v_comision - v_pago;
end;
$$;

-- --- Peor escenario --------------------------------------------------------
-- El número que más costaría si saliera. Es la regla de §5:
--     peor escenario = venta − comisión − máx(premio potencial de cada número)
-- Sirve para vigilar la exposición mientras el sorteo sigue abierto.

create or replace function allan.fn_peor_escenario(p_sorteo_id uuid)
returns table (
  numero        smallint,
  pago          numeric,
  utilidad_peor numeric
)
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

  return query
    select p.numero,
           p.pago,
           v_venta - v_comision - p.pago
    from (
      select l.numero as numero,
             sum(l.monto * l.factor_congelado) as pago
      from allan.linea l
      join allan.ticket t on t.id = l.ticket_id
      where t.sorteo_id = p_sorteo_id and t.anulado_en is null
      group by l.numero
      order by 2 desc
      limit 1
    ) p;
end;
$$;
