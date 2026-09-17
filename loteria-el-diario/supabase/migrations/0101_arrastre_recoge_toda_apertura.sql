-- ===========================================================================
-- El saldo de apertura entra en el arrastre aunque su semana no tenga ventas.
--
-- LO QUE REPORTÓ EL USUARIO, Y LO QUE HABÍA DETRÁS
-- ------------------------------------------------
-- V-047 debía 30.255,25 de apertura, la casa le quedó debiendo 9.177 esa
-- semana, y tras el cierre la impresión decía 21.078 pero la pestaña de saldos
-- seguía mostrando 30.255 como «saldo anterior», sin la rebaja.
--
-- Al reconstruirlo apareció el fallo de fondo, más ancho que el síntoma: la
-- hoja (`fn_liquidacion_por_semana`) arma la lista de semanas SÓLO a partir de
-- las que tienen ventas, más la semana en curso. Una semana cuyo único
-- movimiento es un saldo de apertura no entra en esa lista —`semana` no la
-- contiene— así que:
--
--   · su saldo no sale en ninguna fila, y
--   · como la ventana que calcula el arrastre recorre esas filas, tampoco se
--     propaga a las semanas siguientes.
--
-- La 0100 ya sumaba la apertura a `pendiente_total`, pero el `select` final
-- lee `from semana`, y si la semana de la apertura no está ahí, el trabajo de
-- `pendiente_total` se pierde. En V-047 «funcionaba» de casualidad: su fecha
-- caía en una semana que además tenía ventas, así que esa semana sí existía.
--
-- Y por eso la pestaña de saldos y la impresión no coincidían: `fn_saldos_por_
-- vendedor` calcula el «anterior» de otra forma —suma la apertura directa— y
-- daba la cifra sin rebajar, mientras la hoja, cuando lograba arrastrarla,
-- la compensaba con la semana negativa.
--
-- LA CORRECCIÓN
-- -------------
-- `semana` pasa a incluir también las semanas que sólo tienen apertura, con
-- sus contadores en cero. Así toda semana con movimiento —de ventas O de
-- apertura— tiene su fila, sale en la lista y participa en el arrastre. El
-- resto de la función no cambia: el arrastre y el acumulado ya sabían sumar la
-- apertura una vez la semana existía.
--
-- CÓMO QUEDAN LAS DOS PANTALLAS
-- -----------------------------
-- Con esto, «arrastre» de la hoja y «anterior» de saldos miran lo mismo. La
-- 0102 alinea la pestaña de saldos para que su «anterior» sea exactamente el
-- arrastre de la hoja; ésta arregla la fuente.
-- ===========================================================================

drop function if exists public.fn_liquidacion_por_semana(uuid);

create function public.fn_liquidacion_por_semana(
  p_vendedor_id uuid default null
) returns table (
  r_inicio        date,
  r_fin           date,
  r_semana        integer,
  r_anio          integer,
  r_sorteos       integer,
  r_liquidaciones integer,
  r_pagadas       integer,
  r_pendientes    integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_saldo         numeric,
  r_pagado        numeric,
  r_pendiente     numeric,
  r_por_cobrar    numeric,
  r_por_pagar     numeric,
  r_arrastre      numeric,
  r_acumulado     numeric
)
language sql
stable
security definer
set search_path = public
as $liq_semana$
  with base as (
    select date_trunc('week', s.fecha)::date as inicio,
           lq.vendedor_id,
           s.id as sorteo_id,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where p_vendedor_id is null or lq.vendedor_id = p_vendedor_id
  ),
  conVentas as (
    select inicio,
           count(distinct sorteo_id)::integer            as sorteos,
           count(*)::integer                             as liquidaciones,
           count(*) filter (where pagada)::integer       as pagadas,
           count(*) filter (where not pagada)::integer   as pendientes,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as pagado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from base
    group by inicio
  ),
  /*
   * El saldo de apertura, en la SEMANA de su fecha. Sólo el vivo y sin cobrar,
   * y sólo al preguntar por un vendedor concreto.
   */
  apertura as (
    select date_trunc('week', si.vigente_desde)::date as inicio,
           sum(si.monto) as monto
    from public.saldo_inicial si
    where p_vendedor_id is not null
      and si.vendedor_id = p_vendedor_id
      and si.anulado_en is null
      and si.saldado_en is null
    group by date_trunc('week', si.vigente_desde)::date
  ),
  /*
   * Las semanas que sólo tienen apertura, con los contadores en cero.
   *
   * ÉSTA ES LA CORRECCIÓN. Sin esto, una semana cuyo único movimiento es un
   * saldo de apertura no existía como fila, y su saldo no salía ni se
   * arrastraba a las siguientes. Ahora toda semana con apertura tiene su fila,
   * aunque no se haya vendido nada en ella.
   */
  soloApertura as (
    select ap.inicio,
           0::integer as sorteos, 0::integer as liquidaciones,
           0::integer as pagadas, 0::integer as pendientes,
           0::numeric as venta, 0::numeric as comision, 0::numeric as premios,
           0::numeric as saldo, 0::numeric as pagado, 0::numeric as pendiente
    from apertura ap
    where not exists (select 1 from conVentas cv where cv.inicio = ap.inicio)
  ),
  /*
   * La semana en curso, en blanco, si hace falta. Igual que antes: se añade
   * cuando queda algo pendiente de antes —sorteos impagos O una apertura de
   * una semana anterior— y esa semana no está ya en la lista.
   */
  enCurso as (
    select date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date as inicio,
           0::integer as sorteos, 0::integer as liquidaciones,
           0::integer as pagadas, 0::integer as pendientes,
           0::numeric as venta, 0::numeric as comision, 0::numeric as premios,
           0::numeric as saldo, 0::numeric as pagado, 0::numeric as pendiente
    where p_vendedor_id is not null
      and not exists (
        select 1 from conVentas cv
        where cv.inicio = date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date
      )
      and not exists (
        select 1 from soloApertura sa
        where sa.inicio = date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date
      )
      and (
        exists (
          select 1 from base b
          where not b.pagada
            and b.inicio < date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date
        )
        or exists (
          select 1 from apertura ap
          where ap.inicio < date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date
        )
      )
  ),
  semana as (
    select * from conVentas
    union all
    select * from soloApertura
    union all
    select * from enCurso
  ),
  por_vendedor as (
    select inicio,
           vendedor_id,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from base
    group by inicio, vendedor_id
  ),
  direccion as (
    select inicio,
           coalesce(sum(greatest(pendiente, 0)), 0) as por_cobrar,
           coalesce(sum(-least(pendiente, 0)), 0)   as por_pagar
    from por_vendedor
    group by inicio
  ),
  /*
   * Lo pendiente de cada semana MÁS su apertura. La ventana de abajo acumula
   * esto, así que la apertura se arrastra igual que un sorteo impago. Ahora
   * `semana` ya contiene todas las semanas con apertura, así que el `left
   * join` no pierde ninguna.
   */
  pendiente_total as (
    select s.inicio,
           coalesce(s.pendiente, 0) + coalesce(ap.monto, 0) as pendiente
    from semana s
    left join apertura ap on ap.inicio = s.inicio
  ),
  -- El arrastre: todo lo pendiente hasta la semana anterior, sin incluirla.
  corrido as (
    select inicio,
           coalesce(
             sum(pendiente) over (
               order by inicio
               rows between unbounded preceding and 1 preceding
             ),
             0
           ) as arrastre
    from pendiente_total
  )
  select s.inicio,
         (s.inicio + 6),
         extract(week    from s.inicio)::integer,
         extract(isoyear from s.inicio)::integer,
         s.sorteos,
         s.liquidaciones,
         s.pagadas,
         s.pendientes,
         s.venta,
         s.comision,
         s.premios,
         s.saldo,
         s.pagado,
         s.pendiente,
         coalesce(d.por_cobrar, 0),
         coalesce(d.por_pagar, 0),
         c.arrastre,
         c.arrastre + s.pendiente + coalesce(ap.monto, 0)
  from semana s
  left join direccion d  on d.inicio = s.inicio
  left join apertura  ap on ap.inicio = s.inicio
  join corrido        c  on c.inicio = s.inicio
  order by s.inicio desc;
$liq_semana$;

comment on function public.fn_liquidacion_por_semana(uuid) is
  'Las semanas de un vendedor, con arrastre y acumulado. Incluye las semanas que sólo tienen saldo de apertura, para que ese saldo salga y se arrastre.';

revoke execute on function public.fn_liquidacion_por_semana(uuid)
  from public, anon;
