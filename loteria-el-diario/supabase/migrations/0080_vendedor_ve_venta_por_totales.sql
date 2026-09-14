-- ===========================================================================
-- El vendedor ve también lo que administración capturó por él.
--
-- EL CASO QUE LO MOTIVA
-- ---------------------
-- V-011 MEXICOL, 12/09/2026, sorteo de las 21:00. El administrador veía 7.285
-- de venta y 130 de premiado; el vendedor, en su teléfono, 3.940 y 110.
--
-- Ninguna de las dos cifras estaba mal. La diferencia era una captura por
-- totales de 3.345 que administración registró por él —su hoja de papel— y que
-- su panel no miraba: `fn_mi_dia` y `fn_mi_periodo` sólo sumaban `ticket` y
-- `linea`, las ventas que pasaron por su teléfono.
--
-- El resultado práctico es el peor posible: el vendedor cuadra su cuenta con
-- una cifra y administración le cobra con otra. La conversación siguiente es
-- «el sistema está mal», y no lo estaba: estaba contestando una pregunta más
-- estrecha que la que él creía estar haciendo.
--
-- QUÉ CAMBIA
-- ----------
-- Las dos funciones del panel del vendedor suman ahora las MISMAS dos fuentes
-- que el informe de gerencia (0070): los tickets con números y las capturas
-- por totales. Las cifras de las dos pantallas coinciden porque cuentan lo
-- mismo.
--
-- EL PREMIADO DE LAS CAPTURAS SE DEDUCE, igual que en la 0070: la captura
-- guarda el premio en lempiras, no lo apostado, así que se divide entre el
-- factor del vendedor. Y sólo de sorteos ya liquidados — antes de saber el
-- número ganador, un premio en cero significa «todavía no se sabe», no «no
-- acertó nada».
--
-- SE DICE CUÁNTO VIENE DE ADMINISTRACIÓN
-- --------------------------------------
-- Dos columnas nuevas: `r_venta_admin` y `r_tickets_admin`. Sin ellas el
-- vendedor vería su venta crecer sin explicación y no podría cuadrar contra su
-- libreta, que es justo lo que se estaba intentando arreglar. Con ellas la
-- pantalla puede decir «de estos 7.285, 3.345 los registró administración».
--
-- La comisión de la captura se cuenta con la que quedó congelada en ella, no
-- con la vigente: es la que administración aplicó ese día y la que entró en su
-- liquidación.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- El día del vendedor, sorteo por sorteo.
-- ---------------------------------------------------------------------------
drop function if exists public.fn_mi_dia(uuid, date);

create function public.fn_mi_dia(p_vendedor_id uuid, p_fecha date)
returns table (
  r_sorteo_id     uuid,
  r_hora          public.hora_sorteo,
  r_estado        public.estado_sorteo,
  r_ganador       smallint,
  r_tickets       integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  /* La parte que registró administración por él, ya incluida en las de
     arriba. Se devuelve aparte para que la pantalla pueda decirlo. */
  r_venta_admin   numeric,
  r_capturas      integer
)
language sql
stable
security definer
set search_path = public
as $dia$
  with propio as (
    select s.id as sorteo_id,
           count(distinct t.id)::integer            as tickets,
           coalesce(sum(l.monto), 0)                as venta,
           coalesce(sum(l.monto * l.comision_congelada), 0) as comision,
           coalesce(sum(l.premio), 0)               as premios
    from public.sorteo s
    left join public.ticket t
      on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
    left join public.linea l on l.ticket_id = t.id
    where s.fecha = p_fecha
    group by s.id
  ),
  -- Lo capturado por administración en nombre de este vendedor.
  admin as (
    select vt.sorteo_id,
           count(*)::integer                                  as capturas,
           coalesce(sum(vt.venta), 0)                         as venta,
           coalesce(sum(vt.venta * vt.comision_congelada), 0)  as comision,
           coalesce(sum(vt.premios), 0)                        as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.id, s.hora, s.estado, s.numero_ganador,
         p.tickets,
         p.venta    + coalesce(a.venta, 0),
         p.comision + coalesce(a.comision, 0),
         p.premios  + coalesce(a.premios, 0),
         coalesce(a.venta, 0),
         coalesce(a.capturas, 0)
  from public.sorteo s
  join propio p on p.sorteo_id = s.id
  left join admin a on a.sorteo_id = s.id
  where s.fecha = p_fecha
  order by s.hora;
$dia$;

comment on function public.fn_mi_dia(uuid, date) is
  'El día de un vendedor. Suma sus tickets y lo que administración capturó por él, y dice cuánto viene de ahí.';

revoke execute on function public.fn_mi_dia(uuid, date) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- El período del vendedor, día por día y sorteo por sorteo.
-- ---------------------------------------------------------------------------
drop function if exists public.fn_mi_periodo(uuid, date, date);

create function public.fn_mi_periodo(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_fecha         date,
  r_hora          public.hora_sorteo,
  r_estado        public.estado_sorteo,
  r_ganador       smallint,
  r_tickets       integer,
  r_venta         numeric,
  r_premiado      numeric,   -- lo APOSTADO al número que salió
  r_comision      numeric,
  r_premios       numeric,   -- lo que costó pagarlo
  r_pagado        boolean,
  /* Lo registrado por administración, ya sumado en las de arriba. */
  r_venta_admin   numeric,
  r_capturas      integer
)
language sql
stable
security definer
set search_path = public
as $periodo$
  with propio as (
    select s.id as sorteo_id,
           count(distinct t.id)::integer                        as tickets,
           coalesce(sum(l.monto), 0)                            as venta,
           coalesce(sum(l.monto) filter (where l.gana), 0)       as premiado,
           coalesce(sum(l.monto * l.comision_congelada), 0)      as comision,
           coalesce(sum(l.premio), 0)                            as premios
    from public.sorteo s
    left join public.ticket t
      on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
    left join public.linea l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
    group by s.id
  ),
  admin as (
    select vt.sorteo_id,
           count(*)::integer                                   as capturas,
           coalesce(sum(vt.venta), 0)                          as venta,
           coalesce(sum(vt.venta * vt.comision_congelada), 0)   as comision,
           coalesce(sum(vt.premios), 0)                         as premios,
           /*
            * El premiado DEDUCIDO, igual que en la 0070.
            *
            * La captura guarda lo pagado en lempiras, no lo apostado. Para
            * mostrarlo en la misma columna que el de los números hay que
            * dividirlo entre el factor del vendedor.
            *
            * Sólo de sorteos ya liquidados: antes de saber el número ganador
            * un premio de cero significa «todavía no se sabe», no «no acertó».
            * Y con factor cero o sin parámetros no se divide — cero antes que
            * inventar una cifra.
            */
           coalesce(sum(
             case when s.estado = 'liquidado' and coalesce(pv.factor_pago, 0) > 0
                  then round(vt.premios / pv.factor_pago, 2)
                  else 0 end
           ), 0) as premiado
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id
          and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         p.tickets,
         p.venta    + coalesce(a.venta, 0),
         p.premiado + coalesce(a.premiado, 0),
         p.comision + coalesce(a.comision, 0),
         p.premios  + coalesce(a.premios, 0),
         exists (
           select 1
           from public.liquidacion lq
           join public.corte_detalle d on d.liquidacion_id = lq.id
           where lq.sorteo_id = s.id and lq.vendedor_id = p_vendedor_id
         ),
         coalesce(a.venta, 0),
         coalesce(a.capturas, 0)
  from public.sorteo s
  join propio p on p.sorteo_id = s.id
  left join admin a on a.sorteo_id = s.id
  where s.fecha between p_desde and p_hasta
  order by s.fecha, s.hora;
$periodo$;

comment on function public.fn_mi_periodo(uuid, date, date) is
  'El período de un vendedor. Suma sus tickets y lo capturado por administración, con el premiado de las capturas deducido del factor.';

revoke execute on function public.fn_mi_periodo(uuid, date, date) from public, anon;
