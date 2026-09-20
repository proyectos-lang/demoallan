-- ===========================================================================
-- El período del vendedor deduce el premiado con el factor CONGELADO.
--
-- Es la vista que ve el propio vendedor. Mismo cambio que el informe y la hoja:
-- el premiado de las capturas por totales usa `venta_total.factor_congelado`,
-- con caída al factor vigente si la fila no lo tiene. Ver la 0107.
--
-- `fn_mi_dia` no deduce premiado, así que no cambia.
-- ===========================================================================

create or replace function public.fn_mi_periodo(
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
             case when s.estado = 'liquidado' and coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
                  then round(vt.premios / coalesce(vt.factor_congelado, pv.factor_pago), 2)
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

revoke execute on function public.fn_mi_periodo(uuid, date, date) from public, anon;
