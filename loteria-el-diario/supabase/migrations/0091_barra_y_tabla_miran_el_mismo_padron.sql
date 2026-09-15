-- ===========================================================================
-- La barra del día y la tabla de vendedores contaban padrones distintos.
--
-- CÓMO SALIÓ A LA LUZ. Al arreglar la 0089 quedó un descuadre dentro del mismo
-- tablero: el 07/09 la barra decía 156.805 y la suma de la tabla 133.180. La
-- diferencia son 23.625 exactos de vendedores dados de baja: 21.825 en
-- capturas por totales y 1.800 en tickets.
--
-- NO ES CULPA DE LA 0089. `fn_control_vendedores` filtra por `v.activo` desde
-- que existe; `fn_control_serie` nunca miró si el vendedor seguía vivo, ni en
-- su versión original de la 0026. La incoherencia llevaba ahí desde entonces,
-- tapada por el otro defecto: como la barra tampoco contaba las capturas, los
-- dos errores se restaban y el descuadre quedaba pequeño. Arreglado uno, el
-- otro se hizo visible.
--
-- Es el mejor argumento a favor de haber escrito la prueba: el descuadre lo
-- encontró una comprobación cruzada entre las dos consultas, no la pantalla.
--
-- QUÉ SE ELIGE, Y POR QUÉ ASÍ
-- ---------------------------
-- Manda la tabla: la barra pasa a mirar sólo vendedores activos. Las dos
-- cifras del mismo tablero tienen que poder sumarse una a otra, y la tabla es
-- la que el usuario lee fila por fila cuando algo no le cuadra.
--
-- Lo que se pierde es venta real de gente dada de baja, y conviene decirlo:
-- para cobrar un saldo pendiente de alguien inactivo está la liquidación, que
-- a propósito NO filtra por `activo` —un vendedor de baja con saldo tiene que
-- seguir apareciendo hasta cobrarlo—. El control compara vendedores entre sí
-- y ahí un inactivo no compite con nadie.
--
-- `eliminado_en` se comprueba además de `activo`, como hace el resto del
-- sistema desde la 0031: un eliminado siempre está inactivo, pero pedirlo
-- explícito evita que un `activo` mal puesto lo resucite en un informe.
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
    join public.ticket   t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea    l on l.ticket_id = t.id
    join public.vendedor v on v.id = t.vendedor_id
                          and v.activo and v.eliminado_en is null
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
    join public.vendedor    v  on v.id = vt.vendedor_id
                              and v.activo and v.eliminado_en is null
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
  'Venta día a día del tablero: tickets MÁS capturas por totales, del mismo padrón activo que la tabla de vendedores.';

revoke execute on function public.fn_control_serie(date, date, uuid[], public.hora_sorteo)
  from public, anon;


-- --------------------------------------------------------------------------
-- Y lo mismo para el rótulo de «cuánto vino por totales», que acompaña a una
-- cifra de VENTA que sí está filtrada. Si contara a los inactivos podría
-- llegar a anunciar más venta por totales que venta total.
-- --------------------------------------------------------------------------

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
  join public.vendedor    v  on v.id = vt.vendedor_id
                            and v.activo and v.eliminado_en is null
  where s.fecha between p_desde and p_hasta
    and (p_hora is null or s.hora = p_hora)
    and (p_vendedores is null or vt.vendedor_id = any (p_vendedores));
$control_capturado$;

comment on function public.fn_control_capturado(date, date, uuid[], public.hora_sorteo) is
  'Parte de la venta del rango que se registró por totales, del mismo padrón activo que el resto del tablero.';

revoke execute on function public.fn_control_capturado(date, date, uuid[], public.hora_sorteo)
  from public, anon;
