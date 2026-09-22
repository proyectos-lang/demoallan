-- ===========================================================================
-- El simulador incluye la venta registrada POR TOTALES.
--
-- `fn_simular` y `fn_parametros_ponderados` sumaban sólo de `linea` —los
-- tickets con números—. La venta por totales (`venta_total`, desde la 0047) no
-- entraba, así que el escenario dejaba fuera buena parte del volumen real: en
-- la operación de hoy, la mayoría de la venta es por totales. Ahora las dos
-- fuentes se suman.
--
-- CÓMO APORTA CADA FUENTE
-- -----------------------
-- De una LÍNEA sale directo: venta, comisión congelada, premio pagado, y lo
-- apostado al ganador (`l.monto` cuando `l.gana`).
--
-- De una CAPTURA por totales, la venta, la comisión y el premio pagado están
-- guardados. Lo apostado al ganador —que el premio SIMULADO necesita para
-- multiplicarlo por otro factor— NO se captura; se DEDUCE dividiendo el premio
-- entre el factor de la captura: apostado = premios / factor. Es la misma
-- deducción que hacen el informe y la hoja. Se usa `factor_congelado` (0107); si
-- una captura vieja no lo tiene, se cae al factor vigente del vendedor.
--
-- Las dos fuentes se normalizan a las mismas cuatro cifras —venta, comisión
-- real, premio real, apostado al ganador— y se agregan juntas por mes. El resto
-- del cálculo (comisión y premio SIMULADOS con los parámetros del escenario) es
-- idéntico al de antes; sólo cambió de dónde salen las cifras base.
-- ===========================================================================

create or replace function public.fn_simular(
  p_desde    date,
  p_hasta    date,
  p_comision numeric,   -- fracción: 0.13 para 13 %
  p_factor   numeric
) returns table (
  anio           integer,
  mes            integer,
  dias           integer,
  venta          numeric,
  comision_real  numeric,
  premios_real   numeric,
  utilidad_real  numeric,
  comision_sim   numeric,
  premios_sim    numeric,
  utilidad_sim   numeric
)
language sql
stable
security invoker
set search_path = public
as $simular$
  with base as (
    -- Los tickets con números.
    select s.fecha,
           l.monto                                as venta,
           l.monto * l.comision_congelada         as comision_real,
           l.premio                               as premios_real,
           case when l.gana then l.monto else 0 end as apostado_ganador
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and t.anulado_en is null

    union all

    -- La venta por totales. El apostado al ganador se deduce del premio y el
    -- factor de la captura (o el vigente, si aquélla no lo guardó).
    select s.fecha,
           vt.venta,
           vt.venta * vt.comision_congelada,
           vt.premios,
           case
             when coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
             then vt.premios / coalesce(vt.factor_congelado, pv.factor_pago)
             else 0
           end
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and vt.anulado_en is null
  )
  select extract(year  from fecha)::integer,
         extract(month from fecha)::integer - 1,   -- 0–11, como espera la interfaz
         count(distinct fecha)::integer,
         sum(venta),
         sum(comision_real),
         sum(premios_real),
         sum(venta) - sum(comision_real) - sum(premios_real),
         -- Comisión alterna sobre la misma venta.
         sum(venta) * p_comision,
         -- Premio alterno: lo mismo apostado al ganador, con otro factor.
         sum(apostado_ganador) * p_factor,
         sum(venta) - sum(venta) * p_comision - sum(apostado_ganador) * p_factor
  from base
  group by 1, 2
  order by 1, 2;
$simular$;

comment on function public.fn_simular(date, date, numeric, numeric) is
  'Simula comisión/premio con parámetros alternos, mes a mes. Suma las dos fuentes: tickets con números y venta por totales (con el apostado al ganador deducido del factor).';

revoke execute on function public.fn_simular(date, date, numeric, numeric) from public, anon;


-- --- Los parámetros reales del rango, ponderados por venta -----------------
-- Igual: la referencia contra la que se compara el escenario tiene que incluir
-- la venta por totales, o el promedio ponderado se calcularía sobre una parte
-- del volumen.

create or replace function public.fn_parametros_ponderados(
  p_desde date,
  p_hasta date
) returns table (
  comision_ponderada numeric,
  factor_ponderado   numeric,
  venta              numeric
)
language sql
stable
security invoker
set search_path = public
as $ponderados$
  with base as (
    select l.monto                                as venta,
           l.monto * l.comision_congelada         as comision_real,
           l.premio                               as premios_real,
           case when l.gana then l.monto else 0 end as apostado_ganador
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and t.anulado_en is null

    union all

    select vt.venta,
           vt.venta * vt.comision_congelada,
           vt.premios,
           case
             when coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
             then vt.premios / coalesce(vt.factor_congelado, pv.factor_pago)
             else 0
           end
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and vt.anulado_en is null
  )
  select case when sum(venta) > 0
              then sum(comision_real) / sum(venta) else 0 end,
         case when sum(apostado_ganador) > 0
              then sum(premios_real) / sum(apostado_ganador) else 0 end,
         coalesce(sum(venta), 0)
  from base;
$ponderados$;

comment on function public.fn_parametros_ponderados(date, date) is
  'Comisión y factor reales del rango, ponderados por venta, incluyendo la venta por totales.';

revoke execute on function public.fn_parametros_ponderados(date, date) from public, anon;
