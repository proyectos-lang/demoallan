-- ===========================================================================
-- El tablero del día tampoco contaba la venta capturada por totales.
--
-- CÓMO APARECIÓ. Corregido el control (0088-0091), se revisó una por una el
-- resto de funciones que informan de venta, registrando una captura y mirando
-- cuáles se movían. La mayoría ya la veían —`fn_resumen_periodo`,
-- `fn_resumen_mensual`, `fn_reporte_totales` e `fn_informe_gerencia` leen de
-- `liquidacion`, donde la captura entra desde la 0048—. Dos no.
--
-- EL TAMAÑO DEL HUECO. Para el 07/09/2026 el tablero decía 27.185 de venta
-- cuando ese día se vendieron 156.805. Seis de cada siete lempiras no estaban
-- en la pantalla que se abre al entrar al sistema, y las cuatro cifras de la
-- cabecera —venta, comisión, premios y utilidad— salían de ahí.
--
-- LA CAUSA, Y POR QUÉ ES LA MISMA DE SIEMPRE. Las dos funciones leen la vista
-- `v_agregado_sorteo_vendedor`, cuyo comentario en la 0008 dice: «Todo
-- indicador del sistema sale de aquí, y esto sale de las líneas. Ningún total
-- se captura a mano.» Era verdad cuando se escribió. La 0047 introdujo la
-- captura por totales y con ella un total que sí se escribe a mano, y esa
-- frase pasó de describir el sistema a describir sólo una parte.
--
-- La vista NO se toca. La usan la bitácora y los agregados por número, donde
-- una captura —que no tiene números— no tiene nada que aportar. Lo que se
-- corrige es quien informa de dinero del día.
--
-- QUÉ CUENTA COMO QUÉ
-- -------------------
-- La captura suma a `venta` y a `comision` siempre, y a `premios` sólo cuando
-- el sorteo está liquidado, exactamente como hace `fn_liquidar_sorteo` desde
-- la 0048. La `utilidad` se resta de las tres, así que hereda esa regla sola.
--
-- Los TICKETS no cambian: una captura por totales no tiene ninguno, y fingir
-- que sí haría creer que existe un ticket que nadie podría abrir. Es la misma
-- decisión que en la 0088.
-- ===========================================================================

create or replace function public.fn_resumen_dia(p_fecha date)
returns table (
  sorteo_id      uuid,
  hora           public.hora_sorteo,
  estado         public.estado_sorteo,
  numero_ganador smallint,
  tickets        integer,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security definer
set search_path = public
as $resumen_dia$
  with
  -- Lo vendido por el portal, de la vista de siempre.
  por_linea as (
    select a.sorteo_id,
           sum(a.tickets)  as tickets,
           sum(a.venta)    as venta,
           sum(a.comision) as comision,
           sum(a.premios)  as premios
    from public.v_agregado_sorteo_vendedor a
    where a.fecha = p_fecha
    group by a.sorteo_id
  ),
  -- Y lo capturado por totales. Agregado aparte y no colgado del mismo join:
  -- unido a la vista, cada captura se repetiría una vez por vendedor con
  -- líneas en ese sorteo y la suma saldría inflada.
  por_total as (
    select vt.sorteo_id,
           sum(vt.venta)                            as venta,
           sum(vt.venta * vt.comision_congelada)    as comision,
           -- El premio de una captura sólo es un pago cuando el sorteo cerró;
           -- antes de eso es un dato en espera, igual que en la liquidación.
           sum(case when s.estado = 'liquidado' then vt.premios else 0 end) as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.id, s.hora, s.estado, s.numero_ganador,
         -- Sólo tickets de verdad: una captura no tiene ninguno.
         coalesce(a.tickets, 0)::integer,
         coalesce(a.venta, 0)    + coalesce(b.venta, 0),
         coalesce(a.comision, 0) + coalesce(b.comision, 0),
         coalesce(a.premios, 0)  + coalesce(b.premios, 0),
         (coalesce(a.venta, 0)    + coalesce(b.venta, 0))
       - (coalesce(a.comision, 0) + coalesce(b.comision, 0))
       - (coalesce(a.premios, 0)  + coalesce(b.premios, 0))
  from public.sorteo s
  left join por_linea a on a.sorteo_id = s.id
  left join por_total b on b.sorteo_id = s.id
  where s.fecha = p_fecha
  order by s.hora;
$resumen_dia$;

comment on function public.fn_resumen_dia(date) is
  'Un día, sorteo por sorteo: lo vendido por el portal MÁS lo capturado por totales. Los tickets son sólo tickets.';

revoke execute on function public.fn_resumen_dia(date) from public, anon;
