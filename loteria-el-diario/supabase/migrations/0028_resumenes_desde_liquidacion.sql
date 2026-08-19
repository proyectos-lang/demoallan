-- ===========================================================================
-- Los resúmenes leen de `liquidacion`, no de las 746 mil líneas.
--
-- El consolidado mensual acabó fallando con
--
--     canceling statement due to statement timeout
--
-- Recorrer todas las líneas y agruparlas por mes son varios segundos, y bajo
-- carga supera el máximo que la base permite.
--
-- POR QUÉ ESTO NO ROMPE EL PRINCIPIO §2
-- -------------------------------------
-- `allan.liquidacion` no es un total capturado a mano: lo escribe
-- `fn_liquidar_sorteo` sumando las líneas, en la misma transacción en que el
-- sorteo pasa a `liquidado`. Es una fila por sorteo y vendedor —20.700 en vez
-- de 746.245, treinta y seis veces menos— y sigue derivando de la línea, que
-- es la unidad atómica. Leerla no es capturar un total: es leer el mismo
-- cálculo, ya hecho, sobre datos que por definición ya no cambian.
--
-- Un sorteo liquidado es terminal: ni entran tickets ni se recalculan premios.
-- Por eso su agregado no puede quedar obsoleto.
--
-- LO PENDIENTE SÍ SE CUENTA DESDE LAS LÍNEAS
-- ------------------------------------------
-- Un sorteo sin liquidar no tiene fila en `liquidacion` —no la puede tener, su
-- premio aún no existe— así que su venta se suma desde las líneas. Son los
-- sorteos del día: unos miles de filas, no cientos de miles.
-- ===========================================================================

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select extract(year  from s.fecha)::integer                as a,
           extract(month from s.fecha)::integer - 1            as m,  -- 0–11
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios,
           sum(lq.utilidad) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by 1, 2
  ),
  pend as (
    select extract(year  from s.fecha)::integer     as a,
           extract(month from s.fecha)::integer - 1 as m,
           sum(l.monto)                             as venta
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
    group by 1, 2
  )
  -- FULL JOIN: un mes puede tener sólo liquidado, sólo pendiente, o ambos.
  select coalesce(liq.a, pend.a),
         coalesce(liq.m, pend.m),
         coalesce(liq.venta, 0) + coalesce(pend.venta, 0),
         coalesce(liq.comision, 0),
         coalesce(liq.premios, 0),
         coalesce(liq.utilidad, 0),
         coalesce(pend.venta, 0)
  from liq
  full join pend on liq.a = pend.a and liq.m = pend.m
  order by 1, 2;
$$;

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select coalesce(sum(lq.venta), 0)    as venta,
           coalesce(sum(lq.comision), 0) as comision,
           coalesce(sum(lq.premios), 0)  as premios,
           coalesce(sum(lq.utilidad), 0) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
  ),
  pend as (
    select coalesce(sum(l.monto), 0)                     as venta,
           coalesce(sum(l.monto * l.comision_congelada), 0) as comision
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
  ),
  conteos as (
    select
      (select count(*)
       from allan.ticket t
       join allan.sorteo s on s.id = t.sorteo_id
       where s.fecha between p_desde and p_hasta
         and t.anulado_en is null)::integer as tickets,
      (select count(distinct lq.sorteo_id)
       from allan.liquidacion lq
       join allan.sorteo s on s.id = lq.sorteo_id
       where s.fecha between p_desde and p_hasta)::integer as liquidados,
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado <> 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as pendientes
  )
  select liq.venta + pend.venta,
         liq.comision + pend.comision,
         c.tickets,
         liq.venta,
         liq.comision,
         liq.premios,
         liq.utilidad,
         pend.venta,
         c.liquidados,
         c.pendientes
  from liq, pend, conteos c;
$$;

create or replace function allan.fn_resumen_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  vendedor_id uuid,
  codigo      text,
  nombre      text,
  color       text,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios,
           sum(lq.utilidad) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  pend as (
    select t.vendedor_id, sum(l.monto) as venta
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
    group by t.vendedor_id
  )
  select v.id, v.codigo, v.nombre, v.color,
         -- La venta incluye lo pendiente; comisión, premios y utilidad no,
         -- porque de un sorteo sin liquidar aún no se conocen.
         coalesce(liq.venta, 0) + coalesce(pend.venta, 0),
         coalesce(liq.comision, 0),
         coalesce(liq.premios, 0),
         coalesce(liq.utilidad, 0)
  from allan.vendedor v
  left join liq  on liq.vendedor_id = v.id
  left join pend on pend.vendedor_id = v.id
  where v.activo
  order by 5 desc, v.codigo;
$$;

-- El índice que hace barata la unión con el rango de fechas.
create index if not exists liquidacion_sorteo on allan.liquidacion (sorteo_id);

analyze allan.liquidacion;
