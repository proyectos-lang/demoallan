-- ===========================================================================
-- El control de vendedores dejaba de responder: 746.524 líneas para 30 filas.
--
-- SÍNTOMA. Al abrir «Control de vendedores» con el histórico completo cargado,
-- la pantalla devolvía «No se pudo cargar». El error real de la base era
-- `canceling statement due to statement timeout`: la consulta pasaba de ocho
-- segundos y el servidor la cancelaba. Se veía sobre todo al volver a esa
-- pantalla después de otra acción, que es cuando el usuario lo encontró.
--
-- CAUSA. `fn_control_vendedores` sumaba venta, comisión y premios recorriendo
-- `linea` — hoy 746.524 filas — para producir una fila por vendedor. Esa misma
-- cuenta ya está agregada en `allan.liquidacion`, que tiene 20.703 filas: una
-- por sorteo y vendedor, escrita al liquidar.
--
-- Es la misma corrección que la 0029 hizo con los reportes. Aquella no llegó a
-- esta función porque la 0026 y la 0027 —que son las que la escribieron— son
-- posteriores y volvieron a bajar a `linea`.
--
-- LO QUE NO ESTÁ EN `liquidacion` Y HAY QUE SEGUIR CONTANDO
-- ---------------------------------------------------------
--   · tickets y líneas: son conteos, no importes, y ahí no se guardan. Se
--     cuentan aparte, pero contar es mucho más barato que sumar con `join`:
--     `ticket_sorteo_vigente` cubre el filtro y no hace falta tocar `linea`
--     salvo para su propio conteo.
--
--   · `pendiente`: es la venta de sorteos que AÚN NO se han liquidado, y por
--     definición ésos no tienen fila en `liquidacion`. Sigue saliendo de las
--     líneas, pero acotado a los sorteos no liquidados del rango, que son a lo
--     sumo los tres de hoy — no treinta días.
--
-- El resultado es idéntico al de la versión anterior; lo que cambia es de
-- dónde se leen las tres sumas.
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
  with
  -- Los sorteos del rango, una sola vez: los demás bloques se enganchan aquí.
  sorteos as (
    select s.id, s.estado
    from allan.sorteo s
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
  ),
  -- Los importes de lo YA liquidado, del agregado y no de las líneas.
  liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)     as venta,
           sum(lq.comision)  as comision,
           sum(lq.premios)   as premios,
           -- Restado de lo que se enseña, no leído de `utilidad`: las cuatro
           -- columnas se redondean por separado al liquidar. Ver la 0036.
           sum(lq.venta) - sum(lq.comision) - sum(lq.premios) as utilidad
    from allan.liquidacion lq
    join sorteos s on s.id = lq.sorteo_id
    where p_vendedores is null or lq.vendedor_id = any (p_vendedores)
    group by lq.vendedor_id
  ),
  -- La venta de los sorteos del rango que todavía no se liquidaron. Ésos no
  -- tienen fila en `liquidacion`, así que aquí no hay atajo; pero son pocos.
  sin_liquidar as (
    select t.vendedor_id, sum(l.monto) as pendiente
    from sorteos s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.estado <> 'liquidado'
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by t.vendedor_id
  ),
  -- Conteos. Contar no obliga a sumar importes ni a ordenar nada.
  conteos as (
    select t.vendedor_id,
           count(distinct t.id) as tickets,
           count(l.id)          as lineas
    from sorteos s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where p_vendedores is null or t.vendedor_id = any (p_vendedores)
    group by t.vendedor_id
  )
  select v.id, v.codigo, v.nombre, v.zona, v.color,
         coalesce(c.tickets, 0)::integer,
         coalesce(c.lineas, 0)::integer,
         -- La venta del período es la liquidada MÁS la que espera resultado:
         -- el vendedor ya la hizo, aunque todavía no genere utilidad.
         coalesce(q.venta, 0) + coalesce(p.pendiente, 0),
         coalesce(q.comision, 0),
         coalesce(q.premios, 0),
         coalesce(q.utilidad, 0),
         coalesce(p.pendiente, 0)
  from allan.vendedor v
  -- Externos: un vendedor sin ventas en el rango debe aparecer con ceros, no
  -- desaparecer de la comparación. Es justo lo que hay que ver de él.
  left join liquidado    q on q.vendedor_id = v.id
  left join sin_liquidar p on p.vendedor_id = v.id
  left join conteos      c on c.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(q.venta, 0) + coalesce(p.pendiente, 0) desc, v.codigo;
$$;

comment on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo) is
  'Control por vendedor. Los importes salen de allan.liquidacion; sólo lo no liquidado baja a las líneas.';

revoke execute on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
