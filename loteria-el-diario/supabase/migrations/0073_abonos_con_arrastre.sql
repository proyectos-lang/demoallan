-- ===========================================================================
-- La hoja de una semana también deja constancia del pago del ARRASTRE.
--
-- EL HUECO
-- --------
-- `fn_abonos_semana` lista los cortes que tocaron una semana, y decide cuáles
-- mirando la FECHA DE LOS SORTEOS que se pagaron. Para un corte normal está
-- bien: paga sorteos de esa semana y sale en esa hoja.
--
-- Pero saldar el arrastre (0069) cierra sorteos de semanas ANTERIORES. Con ese
-- criterio el pago aparece en la hoja de la semana vieja —la que ya nadie mira—
-- y no en la que se tenía delante al cobrarlo. Se imprime la hoja del vendedor
-- y no hay ni rastro de que acaba de pagar.
--
-- QUÉ CAMBIA
-- ----------
-- Se añaden los cortes cuya FECHA DE PAGO cae en la semana consultada, aunque
-- lo que saldaron sea de antes. Son las dos preguntas que una hoja semanal
-- tiene que contestar:
--
--   · qué sorteos DE ESTA SEMANA ya se cerraron —el criterio de siempre—;
--   · y qué se PAGÓ esta semana, venga de donde venga.
--
-- Un corte puede cumplir las dos: se paga la semana en curso dentro de la
-- misma semana. Por eso la unión agrupa por corte y no los suma dos veces.
--
-- `r_saldo` SIGUE SIENDO LA PARTE DE ESTA SEMANA
-- ----------------------------------------------
-- Para un corte de arrastre eso es CERO —ninguno de sus sorteos cae aquí— y
-- así debe quedarse: esa columna alimenta el descuento de «ya liquidado» de la
-- hoja, y meterle el importe del arrastre restaría dos veces lo mismo.
--
-- Lo que se paga de atrás va en `r_arrastre`, una columna nueva. Separadas, la
-- hoja puede decir «se abonaron L 4,419 de semanas anteriores el viernes» sin
-- que esa cifra se cuele en la aritmética de los siete días que muestra.
-- ===========================================================================

drop function if exists public.fn_abonos_semana(uuid, date, date);

create function public.fn_abonos_semana(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_corte_id  uuid,
  r_pagado_en timestamptz,
  r_sorteos   integer,
  r_saldo     numeric,   -- la parte de ese corte que cae en esta semana
  r_nota      text,
  r_arrastre  numeric    -- lo que ese corte pagó de semanas anteriores
)
language sql
stable
security definer
set search_path = public
as $$
  with tocan as (
    /*
     * Los cortes que entran en esta hoja, por cualquiera de las dos vías:
     * pagaron sorteos de la semana, o se cobraron durante la semana.
     *
     * `distinct` porque un corte puede cumplir las dos y no debe salir dos
     * veces — es el caso corriente de pagar lo de la semana dentro de ella.
     */
    select distinct cv.id
    from public.corte_vendedor cv
    where cv.vendedor_id = p_vendedor_id
      and (
        exists (
          select 1
          from public.corte_detalle d
          join public.liquidacion lq on lq.id = d.liquidacion_id
          join public.sorteo s on s.id = lq.sorteo_id
          where d.corte_id = cv.id
            and s.fecha between p_desde and p_hasta
        )
        or (cv.pagado_en at time zone 'America/Tegucigalpa')::date
              between p_desde and p_hasta
      )
  )
  select cv.id,
         cv.pagado_en,
         count(*)::integer,
         -- Lo de ESTA semana: es lo que la hoja descuenta como ya liquidado.
         coalesce(sum(lq.venta - lq.comision - lq.premios)
                  filter (where s.fecha between p_desde and p_hasta), 0),
         cv.nota,
         -- Y lo de ANTES, aparte: se muestra como constancia del pago sin
         -- entrar en la aritmética de los siete días.
         coalesce(sum(lq.venta - lq.comision - lq.premios)
                  filter (where s.fecha < p_desde), 0)
  from tocan t
  join public.corte_vendedor cv on cv.id = t.id
  join public.corte_detalle d on d.corte_id = cv.id
  join public.liquidacion lq on lq.id = d.liquidacion_id
  join public.sorteo s on s.id = lq.sorteo_id
  group by cv.id, cv.pagado_en, cv.nota
  order by cv.pagado_en;
$$;

comment on function public.fn_abonos_semana(uuid, date, date) is
  'Los cortes que tocaron una semana: los que pagaron sus sorteos y los que se cobraron durante ella. r_saldo es la parte de esta semana; r_arrastre lo que se pagó de anteriores.';

revoke execute on function public.fn_abonos_semana(uuid, date, date)
  from public, anon;
