-- ===========================================================================
-- La hoja de liquidación también deduce el premiado de las capturas.
--
-- LO QUE PASABA
-- -------------
-- En el imprimible de V-011 MEXICOL del 07/09/2026 aparecían venta y premios,
-- pero el valor premiado salía vacío, con una raya. Y eso no puede ser: si se
-- pagaron 11.550 de premio, alguien acertó y hubo algo apostado al número que
-- salió. Las dos cosas no pueden coexistir.
--
-- La causa es la misma que arreglaron la 0070 para el informe y la 0080 para
-- el panel del vendedor: `fn_semana_completa` calculaba el premiado mirando
-- sólo `linea` —las ventas con números—. Ese día MEXICOL no vendió nada por su
-- teléfono: sus tres sorteos son capturas por totales, y una captura guarda el
-- premio PAGADO en lempiras, no lo apostado.
--
-- Con cero apostado la hoja escribía una raya, y además el factor se calcula
-- dividiendo premios entre premiado, así que también salía en cero: el papel
-- quedaba diciendo que se pagaron 11.550 por nada.
--
-- QUÉ CAMBIA
-- ----------
-- El premiado de las capturas se DEDUCE dividiendo el premio entre el factor
-- del vendedor, exactamente como en la 0070 y la 0080. Así las tres pantallas
-- —informe, panel del vendedor y hoja de liquidación— cuentan lo mismo, que es
-- lo único que permite cuadrar por teléfono sin discutir de dónde sale cada
-- cifra.
--
-- Sólo de sorteos ya liquidados: antes de saber el número ganador, un premio
-- en cero significa «todavía no se sabe», no «no acertó nada». Y con factor
-- cero o sin parámetros no se divide — mejor un cero que una cifra inventada.
--
-- ALCANCE: 26 sorteos de 7 vendedores tenían una captura liquidada con premio,
-- así que no era un caso aislado de MEXICOL.
-- ===========================================================================

create or replace function public.fn_semana_completa(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_liquidacion_id uuid,
  r_fecha          date,
  r_hora           public.hora_sorteo,
  r_numero_ganador smallint,
  r_venta          numeric,
  r_premiado       numeric,   -- lo apostado al número que salió
  r_factor         numeric,   -- multiplicador efectivo del sorteo
  r_comision       numeric,
  r_premios        numeric,   -- lo que costó pagarlo
  r_saldo          numeric,   -- venta − comisión − premios
  r_corte_id       uuid,      -- nulo si sigue pendiente
  r_pagado_en      timestamptz
)
language sql
stable
security definer
set search_path = public
as $semana$
  with acertado as (
    -- Lo apostado al número ganador en las ventas CON NÚMEROS.
    select t.sorteo_id, sum(l.monto) as premiado
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana
      and s.fecha between p_desde and p_hasta
    group by t.sorteo_id
  ),
  /*
   * Y el DEDUCIDO de las capturas por totales.
   *
   * La captura guarda lo pagado, no lo apostado. Dividirlo entre el factor del
   * vendedor devuelve la cifra que iría en esa columna si la venta hubiera
   * pasado por el teléfono. Es la misma deducción que hacen la 0070 y la 0080;
   * escrita aquí otra vez porque las tres consultas son independientes, y lo
   * que no puede pasar es que una de ellas deje de hacerla.
   */
  capturado as (
    select vt.sorteo_id,
           sum(
             case when s.estado = 'liquidado' and coalesce(pv.factor_pago, 0) > 0
                  then round(vt.premios / pv.factor_pago, 2)
                  else 0 end
           ) as premiado
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id
          and pv.vigente_hasta is null
    where vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
      and s.fecha between p_desde and p_hasta
    group by vt.sorteo_id
  ),
  premiado as (
    select sorteo_id, sum(premiado) as premiado
    from (
      select sorteo_id, premiado from acertado
      union all
      select sorteo_id, premiado from capturado
    ) u
    group by sorteo_id
  )
  select lq.id,
         s.fecha,
         s.hora,
         s.numero_ganador,
         lq.venta,
         coalesce(p.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada. Misma regla que la 0036.
         case when coalesce(p.premiado, 0) > 0
              then round(lq.premios / p.premiado, 2) else 0 end,
         lq.comision,
         lq.premios,
         lq.venta - lq.comision - lq.premios,
         d.corte_id,
         cv.pagado_en
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  left join premiado p on p.sorteo_id = s.id
  left join public.corte_detalle d on d.liquidacion_id = lq.id
  left join public.corte_vendedor cv on cv.id = d.corte_id
  where lq.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
  order by s.fecha, s.hora;
$semana$;

comment on function public.fn_semana_completa(uuid, date, date) is
  'La semana entera de un vendedor, sorteo a sorteo. El premiado suma lo apostado con números y lo deducido de las capturas por totales.';

revoke execute on function public.fn_semana_completa(uuid, date, date) from public, anon;
