-- ===========================================================================
-- Reportes también leen de `liquidacion`, por dos razones.
--
-- 1. COHERENCIA. Desde la 0028 el tablero suma `liquidacion` y los reportes
--    seguían sumando líneas. Las cifras no coincidían:
--
--       enero, tablero  utilidad  1.981.759,69
--       enero, reportes utilidad  1.981.759,14
--
--    Cincuenta y cinco centavos sobre casi dos millones — nada que nadie note,
--    y exactamente lo que el §2 prohíbe: que un tablero contradiga a un
--    reporte. La diferencia no es un error de cálculo: `liquidacion` guarda
--    numeric(14,2) por sorteo y vendedor, así que sumar veinte mil filas ya
--    redondeadas no da lo mismo que redondear la suma de setecientas mil.
--
--    Con las dos pantallas leyendo lo mismo, la pregunta de cuál tiene razón
--    deja de existir.
--
-- 2. VELOCIDAD. `fn_reporte_totales` tardaba 2,4 s por el mismo motivo que el
--    consolidado: recorría todas las líneas.
--
-- El detalle por sorteo y vendedor de un sorteo liquidado ES la fila de
-- `liquidacion`: la escribe `fn_liquidar_sorteo` desde las líneas y no puede
-- quedar obsoleta, porque un sorteo liquidado ya no admite cambios.
-- ===========================================================================

create or replace function allan.fn_reporte_filas(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null,
  p_limite      integer  default 80,
  p_desde_fila  integer  default 0
) returns table (
  fecha          date,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  numero_ganador smallint,
  vendedor_id    uuid,
  vendedor       text,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  -- Liquidado: la fila ya existe, calculada desde las líneas.
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         lq.vendedor_id, v.nombre,
         lq.venta, lq.comision, lq.premios, lq.utilidad
  from allan.liquidacion lq
  join allan.sorteo s   on s.id = lq.sorteo_id
  join allan.vendedor v on v.id = lq.vendedor_id
  where s.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora         = p_hora)
    and (p_numero      is null or s.numero_ganador = p_numero)

  union all

  -- Sin liquidar: se suma desde las líneas, que es lo único que hay. Comisión,
  -- premios y utilidad van en cero a propósito: de un sorteo abierto no se
  -- conocen, y ponerlos sería proyectar (§2).
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         t.vendedor_id, v.nombre,
         sum(l.monto), 0::numeric, 0::numeric, 0::numeric
  from allan.sorteo s
  join allan.ticket t   on t.sorteo_id = s.id and t.anulado_en is null
  join allan.linea  l   on l.ticket_id = t.id
  join allan.vendedor v on v.id = t.vendedor_id
  where s.fecha between p_desde and p_hasta
    and s.estado <> 'liquidado'
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora        = p_hora)
    -- Un sorteo sin liquidar no tiene número ganador: si se filtra por número,
    -- por definición no puede aparecer.
    and p_numero is null
  group by s.fecha, s.hora, s.estado, s.numero_ganador, t.vendedor_id, v.nombre

  -- Fecha descendente pero hora ascendente dentro del día: lo más reciente
  -- arriba, y dentro de la jornada en el orden en que ocurrió.
  order by 1 desc, 2 asc, 6 asc
  limit p_limite offset p_desde_fila;
$$;

create or replace function allan.fn_reporte_totales(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null
) returns table (
  registros            integer,
  dias                 integer,
  venta                numeric,
  comision             numeric,
  premios              numeric,
  utilidad             numeric,
  venta_pendiente      numeric,
  registros_pendientes integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select count(*)                         as registros,
           count(distinct s.fecha)          as dias,
           coalesce(sum(lq.venta), 0)       as venta,
           coalesce(sum(lq.comision), 0)    as comision,
           coalesce(sum(lq.premios), 0)     as premios,
           coalesce(sum(lq.utilidad), 0)    as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
      and (p_hora        is null or s.hora         = p_hora)
      and (p_numero      is null or s.numero_ganador = p_numero)
  ),
  pend as (
    select count(*)                    as registros,
           count(distinct x.fecha)     as dias,
           coalesce(sum(x.venta), 0)   as venta
    from (
      select s.fecha, s.id, t.vendedor_id, sum(l.monto) as venta
      from allan.sorteo s
      join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
      join allan.linea  l on l.ticket_id = t.id
      where s.fecha between p_desde and p_hasta
        and s.estado <> 'liquidado'
        and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
        and (p_hora        is null or s.hora        = p_hora)
        and p_numero is null
      group by s.fecha, s.id, t.vendedor_id
    ) x
  )
  select (liq.registros + pend.registros)::integer,
         -- Los días se cuentan sobre el conjunto, no sumando los dos: un mismo
         -- día puede tener sorteos liquidados y pendientes a la vez.
         (select count(distinct d)::integer from (
            select s.fecha as d
            from allan.sorteo s
            where s.fecha between p_desde and p_hasta
              and (p_hora is null or s.hora = p_hora)
              and exists (select 1 from allan.ticket t
                          where t.sorteo_id = s.id and t.anulado_en is null
                            and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id))
          ) q),
         liq.venta + pend.venta,
         liq.comision,
         liq.premios,
         liq.utilidad,
         pend.venta,
         pend.registros::integer
  from liq, pend;
$$;
