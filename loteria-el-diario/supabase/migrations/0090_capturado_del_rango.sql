-- ===========================================================================
-- Cuánto de la venta del tablero se capturó por totales.
--
-- POR QUÉ HACE FALTA
-- ------------------
-- Desde la 0088 y la 0089 el tablero suma las capturas por totales, que es lo
-- que se pidió. Pero el conteo que acompaña a la cifra de VENTA sigue siendo
-- de TICKETS, y no puede dejar de serlo: una captura por totales no tiene
-- ticket que contar.
--
-- Eso deja una trampa de lectura. Junto a «VENTA 1.4M» se lee «264 tickets», y
-- quien divida una cosa entre otra concluirá que el ticket promedio es de
-- 5.300 lempiras, que es falso. El tablero necesita poder decir qué parte de
-- esa venta no pasó por el portal.
--
-- Va en su propia función y no como una columna más de `fn_control_vendedores`
-- para no volver a cambiarle la firma: esa función la llaman la página y dos
-- pruebas, y cada cambio de firma obliga a `drop function` —la lección de la
-- 0083, que dejó dos `fn_auditar` y bloqueó las ventas.
-- ===========================================================================

create or replace function public.fn_control_capturado(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       public.hora_sorteo default null
)
returns numeric
language sql
stable
security definer
set search_path = public
as $control_capturado$
  select coalesce(sum(vt.venta), 0)
  from public.sorteo s
  join public.venta_total vt on vt.sorteo_id = s.id and vt.anulado_en is null
  where s.fecha between p_desde and p_hasta
    and (p_hora is null or s.hora = p_hora)
    and (p_vendedores is null or vt.vendedor_id = any (p_vendedores));
$control_capturado$;

comment on function public.fn_control_capturado(date, date, uuid[], public.hora_sorteo) is
  'Parte de la venta del rango que se registró por totales, para poder decirlo junto al conteo de tickets.';

revoke execute on function public.fn_control_capturado(date, date, uuid[], public.hora_sorteo)
  from public, anon;
