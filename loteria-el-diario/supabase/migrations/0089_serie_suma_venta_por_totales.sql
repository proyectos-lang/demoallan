-- ===========================================================================
-- La barra de «Venta día a día» tampoco contaba las capturas por totales.
--
-- Es el mismo agujero que corrige la 0088, en la otra consulta del tablero.
-- `fn_control_serie` dibuja una barra por día leyendo `ticket` y `linea`, así
-- que un día vendido entero por totales salía como un hueco: la lectura era
-- «ese día no se vendió», cuando lo que pasó es que se capturó de otra forma.
--
-- Aquí NO se distingue entre liquidado y sin liquidar, y es a propósito: la
-- serie muestra VENTA, no utilidad. Se suman las dos fuentes en los dos casos.
--
-- DOS SUBCONSULTAS Y NO DOS JOINS
-- -------------------------------
-- Colgar `venta_total` del mismo `left join` que ya trae `ticket` multiplicaría
-- las filas: cada captura se repetiría una vez por cada línea de ticket de ese
-- día, y la suma saldría inflada. Agregando cada fuente por separado antes de
-- juntarlas, cada importe se cuenta una sola vez.
--
-- `generate_series` se conserva: un día sin venta sigue dibujándose, porque un
-- hueco también es información.
--
-- EL CONTEO DE TICKETS SIGUE SIENDO DE TICKETS
-- --------------------------------------------
-- Igual que en la 0088: una captura por totales no es un ticket y no se cuenta
-- como tal. La barra sube; el rótulo de tickets dice la verdad.
-- ===========================================================================

create or replace function public.fn_control_serie(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       public.hora_sorteo default null
)
returns table (r_fecha date, r_venta numeric, r_tickets integer)
language sql
stable
security definer
set search_path = public
as $control_serie$
  with dias as (
    select d::date as fecha
    from generate_series(p_desde, p_hasta, interval '1 day') d
  ),
  -- Lo vendido en tickets, ya agregado por día.
  por_ticket as (
    select s.fecha,
           coalesce(sum(l.monto), 0)   as venta,
           count(distinct t.id)        as tickets
    from public.sorteo s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by s.fecha
  ),
  -- Y lo capturado por totales, también por día.
  por_total as (
    select s.fecha, coalesce(sum(vt.venta), 0) as venta
    from public.sorteo s
    join public.venta_total vt on vt.sorteo_id = s.id and vt.anulado_en is null
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or vt.vendedor_id = any (p_vendedores))
    group by s.fecha
  )
  select d.fecha,
         coalesce(a.venta, 0) + coalesce(b.venta, 0),
         coalesce(a.tickets, 0)::integer
  from dias d
  left join por_ticket a on a.fecha = d.fecha
  left join por_total  b on b.fecha = d.fecha
  order by d.fecha;
$control_serie$;

comment on function public.fn_control_serie(date, date, uuid[], public.hora_sorteo) is
  'Venta día a día del tablero: tickets MÁS capturas por totales. Los días sin venta salen en cero, no se omiten.';

revoke execute on function public.fn_control_serie(date, date, uuid[], public.hora_sorteo)
  from public, anon;
