-- ===========================================================================
-- Un saldo de apertura ya cobrado deja de sumar al arrastre.
--
-- EL FALLO, Y CÓMO APARECIÓ
-- -------------------------
-- La 0096 hizo que el saldo de apertura entrara en la columna «anterior» de la
-- liquidación, filtrando por `anulado_en is null`. La 0097 añadió DESPUÉS las
-- columnas de cierre —`saldado_en`, `saldado_corte_id`— para poder cobrarlo,
-- pero la 0096 ya estaba escrita y no las mira.
--
-- Resultado: se le cobra al vendedor, el corte se registra, el saldo queda
-- marcado como saldado… y el arrastre sigue diciendo que debe 4.500. Para
-- siempre. Se le cobraría otra vez, y otra, y el sistema seguiría dándole la
-- razón a quien cobra.
--
-- Lo encontró la prueba —«tras cobrar, el arrastre vuelve a cero» daba 4500—,
-- que es exactamente el tipo de fallo que no se ve mirando el código: las dos
-- migraciones son correctas por separado y el orden en que se escribieron es
-- lo que las descuadra.
--
-- POR QUÉ UNA MIGRACIÓN NUEVA Y NO CORREGIR LA 0096
-- -------------------------------------------------
-- Porque la 0096 ya está aplicada. Editarla dejaría el archivo diciendo una
-- cosa y la base otra, y la próxima instalación desde cero se comportaría
-- distinto de la que está corriendo. La corrección va delante, con su fecha.
--
-- Es el cuerpo de la 0096 con una línea más: `and saldado_en is null`.
-- ===========================================================================

create or replace function public.fn_saldos_por_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_activo       boolean,
  r_anterior     numeric,   -- pendiente de las semanas anteriores a p_desde
  r_venta        numeric,   -- lo que movió en la semana
  r_comision     numeric,
  r_premios      numeric,
  r_semana       numeric,   -- saldo de la semana: venta − comisión − premios
  r_liquidado    numeric,   -- la parte de la semana ya cerrada en un corte
  r_pendiente    numeric,   -- lo que falta de la semana
  r_actual       numeric    -- r_anterior + r_pendiente
)
language sql
stable
security definer
set search_path = public
as $saldos$
  with fila as (
    select lq.vendedor_id,
           s.fecha,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
  ),
  -- Lo que quedó sin cerrar ANTES de la semana pedida.
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  /*
   * El saldo con el que entró al sistema, si lo hay y NO se ha cobrado.
   *
   * Las tres condiciones hacen falta:
   *   · `anulado_en is null` — uno cargado por error no cuenta.
   *   · `saldado_en is null` — uno ya cobrado tampoco, o se cobraría dos veces.
   *   · `vigente_desde < p_desde` — mirando una semana anterior a la apertura,
   *     ese dinero todavía no se le había cargado.
   */
  apertura as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null
      and saldado_en is null
      and vigente_desde < p_desde
    group by vendedor_id
  ),
  -- Lo de la semana, separando lo ya cerrado de lo que falta.
  semana as (
    select vendedor_id,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as liquidado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from fila
    where fecha between p_desde and p_hasta
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         -- Lo viejo sin cobrar MÁS lo que traía de la libreta anterior.
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0),
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0) + coalesce(s.pendiente, 0)
  from public.vendedor v
  left join antes    a  on a.vendedor_id = v.id
  left join apertura ap on ap.vendedor_id = v.id
  left join semana   s  on s.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera dado de baja que siga debiendo o a
  -- quien se le siga debiendo: si tiene saldo, tiene que salir hasta saldarlo.
  -- El saldo de apertura cuenta para esto: un vendedor nuevo al que se le
  -- acaba de cargar su deuda no tiene ni venta ni sorteos viejos, y sin esto
  -- desaparecería justo de la pantalla donde hay que cobrarle.
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(ap.monto, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by v.codigo;
$saldos$;

comment on function public.fn_saldos_por_vendedor(date, date) is
  'Saldo anterior y actual de cada vendedor para una semana. El anterior incluye el saldo de apertura que siga sin cobrar.';

revoke execute on function public.fn_saldos_por_vendedor(date, date)
  from public, anon;
