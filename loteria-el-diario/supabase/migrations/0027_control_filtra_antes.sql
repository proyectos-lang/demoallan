-- ===========================================================================
-- `fn_control_vendedores` ignoraba el rango al recorrer.
--
-- Pedir catorce días tardaba lo mismo que pedir ocho meses: 3,1 s. La causa
-- estaba en el orden de los enlaces:
--
--     from allan.vendedor v
--     left join allan.ticket t on t.vendedor_id = v.id and t.anulado_en is null
--     left join allan.sorteo s on s.id = t.sorteo_id
--                             and s.fecha between p_desde and p_hasta
--     left join allan.linea  l on l.ticket_id = t.id and s.id is not null
--
-- El enlace con `ticket` no lleva ninguna condición de fecha —la fecha vive en
-- `sorteo`, un enlace más allá—, así que arranca tomando los 166 mil tickets de
-- todo el histórico y sus 746 mil líneas, y recorta al final. Con LEFT JOIN el
-- planificador no puede adelantar el filtro: las filas sin pareja tienen que
-- conservarse, y adelantarlo cambiaría el resultado.
--
-- El arreglo es invertir el orden: primero los sorteos del rango, y de ahí a
-- los tickets y a las líneas con enlaces internos. Los vendedores se añaden
-- después con un LEFT JOIN, que es lo único que de verdad necesita serlo — para
-- que un vendedor sin ventas en el rango siga apareciendo con sus ceros.
-- ===========================================================================

create or replace function allan.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
)
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_zona        text,
  r_color       text,
  r_tickets     integer,
  r_lineas      integer,
  r_venta       numeric,
  r_comision    numeric,
  r_premios     numeric,
  r_utilidad    numeric,
  r_pendiente   numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with datos as (
    -- Se empieza por el sorteo, que es donde vive la fecha. Todo lo que sigue
    -- son enlaces internos, así que el rango recorta antes de recorrer nada.
    select t.vendedor_id                                   as vendedor_id,
           count(distinct t.id)                            as tickets,
           count(l.id)                                     as lineas,
           sum(l.monto)                                    as venta,
           sum(l.monto * l.comision_congelada)             as comision,
           sum(l.premio) filter (where s.estado = 'liquidado')  as premios,
           sum(l.monto - l.monto * l.comision_congelada - l.premio)
             filter (where s.estado = 'liquidado')         as utilidad,
           sum(l.monto) filter (where s.estado <> 'liquidado')  as pendiente
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by t.vendedor_id
  )
  select v.id, v.codigo, v.nombre, v.zona, v.color,
         coalesce(d.tickets, 0)::integer,
         coalesce(d.lineas, 0)::integer,
         coalesce(d.venta, 0),
         coalesce(d.comision, 0),
         coalesce(d.premios, 0),
         coalesce(d.utilidad, 0),
         coalesce(d.pendiente, 0)
  from allan.vendedor v
  -- Éste sí tiene que ser externo: un vendedor sin ventas en el rango debe
  -- aparecer con ceros, no desaparecer de la comparación.
  left join datos d on d.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(d.venta, 0) desc, v.codigo;
$$;

revoke execute on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
