-- ===========================================================================
-- La liquidación suma las dos formas de vender.
--
-- La 0047 abrió la puerta a la venta por totales, pero mientras la liquidación
-- se construya sólo desde `linea`, esa captura no existe para nadie: ni para
-- el corte semanal, ni para el informe de gerencia, ni para el tablero.
--
-- Aquí se cambian las DOS funciones que escriben en `allan.liquidacion`, que
-- son las únicas, y con eso el resto del sistema se entera sin tocar una línea
-- más: veinticuatro migraciones leen de esa tabla ya agregada.
--
-- LO QUE SE SUMA
-- --------------
--   venta     = Σ líneas + Σ capturas por totales
--   comisión  = Σ (monto × comisión congelada de la línea)
--               + Σ (venta × comisión congelada de la captura)
--   premios   = Σ premios de líneas ganadoras + Σ premios de las capturas
--
-- Cada parte conserva SU comisión congelada, la de la línea o la de la
-- captura. No se recalcula ninguna con la tasa de hoy: eso reescribiría el
-- pasado cada vez que a alguien se le cambia la comisión.
--
-- EL `full join` NO ES ADORNO. Un vendedor puede tener sólo líneas, sólo una
-- captura por totales, o las dos —vendió por el portal media jornada y el
-- resto en papel—. Con un `join` normal, el que tuviera sólo una de las dos
-- desaparecería de la liquidación, que es exactamente el error que esta
-- migración viene a evitar.
--
-- TODO LO DEMÁS DE `fn_liquidar_sorteo` SE CONSERVA LETRA POR LETRA: el nombre
-- del parámetro —`p_numero_ganador`, no `p_numero`, o Postgres crearía una
-- segunda función por sobrecarga y quedarían las dos vivas—, la guarda de que
-- el sorteo esté `cerrado` y no meramente abierto, los `errcode`, el
-- `liquidado_por` y el formato de la auditoría con `lpad`. Lo único que cambia
-- es de dónde salen las cifras.
-- ===========================================================================

create or replace function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (
  total_vendedores       integer,
  total_lineas_ganadoras integer,
  total_premios          numeric
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado     allan.estado_sorteo;
  v_ganadoras  integer;
  v_premios    numeric(14,2);
  v_vendedores integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select p_sorteo_id,
         coalesce(d.vendedor_id, v.vendedor_id),
         coalesce(d.venta, 0)    + coalesce(v.venta, 0),
         coalesce(d.comision, 0) + coalesce(v.comision, 0),
         coalesce(d.premios, 0)  + coalesce(v.premios, 0),
         (coalesce(d.venta, 0)    + coalesce(v.venta, 0))
       - (coalesce(d.comision, 0) + coalesce(v.comision, 0))
       - (coalesce(d.premios, 0)  + coalesce(v.premios, 0)),
         auth.uid()
  from (
    -- Lo vendido número a número.
    select t.vendedor_id,
           sum(l.monto)                        as venta,
           sum(l.monto * l.comision_congelada) as comision,
           sum(l.premio)                       as premios
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
    group by t.vendedor_id
  ) d
  full join (
    -- Lo capturado por totales.
    select vt.vendedor_id,
           sum(vt.venta)                         as venta,
           sum(vt.venta * vt.comision_congelada) as comision,
           sum(vt.premios)                       as premios
    from allan.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.anulado_en is null
    group by vt.vendedor_id
  ) v on v.vendedor_id = d.vendedor_id;

  get diagnostics v_vendedores = row_count;

  -- Los premios del sorteo salen ahora de la liquidación recién escrita, que es
  -- la que ya tiene las dos fuentes sumadas. Leerlos otra vez de `linea` dejaría
  -- fuera los de las capturas por totales.
  select coalesce(sum(lq.premios), 0) into v_premios
  from allan.liquidacion lq
  where lq.sorteo_id = p_sorteo_id;

  update allan.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$$;

comment on function allan.fn_liquidar_sorteo(uuid, smallint) is
  'Liquida un sorteo sumando la venta por líneas y la capturada por totales.';

revoke execute on function allan.fn_liquidar_sorteo(uuid, smallint) from public, anon;


-- --------------------------------------------------------------------------
-- El recálculo de un vendedor, con las dos fuentes.
--
-- Se usa al vender sobre un sorteo ya liquidado y al registrar o anular una
-- captura por totales. Misma cuenta que arriba, acotada a un vendedor.
-- --------------------------------------------------------------------------
create or replace function allan.fn_recalcular_liquidacion(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo   record;
  v_venta    numeric;
  v_comision numeric;
  v_premios  numeric;
  v_pagada   boolean;
begin
  select id, numero_ganador, estado into v_sorteo
  from allan.sorteo where id = p_sorteo_id;

  if v_sorteo.id is null or v_sorteo.estado <> 'liquidado' then
    return;
  end if;

  -- Lo ya pagado no se toca. Si se admitiera, el corte que el vendedor firmó
  -- dejaría de coincidir con lo que dice la liquidación, y no hay manera
  -- honesta de arreglarlo después.
  select exists (
    select 1
    from allan.liquidacion lq
    join allan.corte_detalle d on d.liquidacion_id = lq.id
    where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id
  ) into v_pagada;

  if v_pagada then
    raise exception 'Ese sorteo ya se le pagó al vendedor; no admite más venta.'
      using errcode = 'check_violation';
  end if;

  -- Las líneas nuevas que acertaron, con el factor congelado de cada una.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null
    and l.numero = v_sorteo.numero_ganador
    and not l.gana;

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
    into v_venta, v_comision, v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null;

  -- Y lo capturado por totales para ese mismo vendedor y sorteo.
  select v_venta    + coalesce(sum(vt.venta), 0),
         v_comision + coalesce(sum(vt.venta * vt.comision_congelada), 0),
         v_premios  + coalesce(sum(vt.premios), 0)
    into v_venta, v_comision, v_premios
  from allan.venta_total vt
  where vt.sorteo_id = p_sorteo_id
    and vt.vendedor_id = p_vendedor_id
    and vt.anulado_en is null;

  -- Sin nada de ninguna de las dos fuentes, la fila sobra.
  if v_venta = 0 and v_premios = 0 then
    delete from allan.liquidacion
     where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id;
    return;
  end if;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios,
    v_venta - v_comision - v_premios
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;
end;
$$;

revoke execute on function allan.fn_recalcular_liquidacion(uuid, uuid) from public, anon;
