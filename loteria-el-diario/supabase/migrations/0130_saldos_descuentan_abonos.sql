-- ===========================================================================
-- Las pantallas de cobro descuentan los abonos a cuenta.
--
-- EL FALLO QUE CORRIGE
-- --------------------
-- Un abono a cuenta (dinero que el vendedor entrega sin cerrar sorteos) bajaba
-- el pendiente en `fn_deuda_vendedor` y en la cobranza, pero NO en las dos
-- pantallas donde se mira el saldo para cobrar:
--
--   · la HOJA del vendedor —`fn_liquidacion_por_semana`, KPI «TOTAL ACUMULADO»—;
--   · la TABLA de saldos del padrón —`fn_saldos_por_vendedor`, «SALDO ACTUAL»—.
--
-- Las dos calculaban el saldo sólo desde `liquidacion` (sorteos sin cerrar) y
-- la apertura, sin restar `abono_vendedor`. Resultado: el cobrador registraba
-- un abono parcial, el dinero entraba, y el acumulado seguía idéntico. El
-- usuario lo reportó como «hago abonos y no veo diferencia ni impacto».
--
-- LA DECISIÓN DEL USUARIO
-- -----------------------
-- Que el saldo baje directo: el acumulado de la hoja y el saldo actual de la
-- tabla bajan por lo abonado, y el abono se enseña como una línea aparte («ya
-- abonó X») para que la resta cierre y el vendedor la pueda seguir.
--
-- CÓMO SE REPARTE EL ABONO ENTRE LAS SEMANAS
-- ------------------------------------------
-- Un abono es un total por vendedor, no pertenece a una semana. Así que:
--
--   · `r_abonado` se reporta en CADA fila como el total de abonos vivos (los que
--     todavía no absorbió un corte). La pantalla lo enseña.
--   · pero el acumulado sólo lo RESTA en la semana más reciente —la que se está
--     cobrando hoy—. En una semana pasada el abono de hoy no existía, así que su
--     acumulado histórico no se toca: restarlo ahí falsearía el pasado.
--
-- Esto mantiene `r_acumulado` de la semana vigente igual que el pendiente de
-- `fn_deuda_vendedor` (deuda − abonado + ajuste), que es con lo que cuadra la
-- cobranza. El ajuste por corrección ya se cuenta en el pendiente de los
-- sorteos; aquí sólo faltaban los abonos.
--
-- NO SE CIERRA NINGÚN SORTEO. El abono sigue sin tocar `corte_detalle`, así que
-- el informe de venta y el detalle sorteo a sorteo no cambian: lo que baja es
-- el total a entregar, no la venta.
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
  r_abonado       numeric,   -- abonos vivos del vendedor (los que no cerró un corte)
  r_acumulado     numeric    -- arrastre + pendiente − abonado (abonado sólo en la semana vigente)
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
  soloApertura as (
    select ap.inicio,
           0::integer as sorteos, 0::integer as liquidaciones,
           0::integer as pagadas, 0::integer as pendientes,
           0::numeric as venta, 0::numeric as comision, 0::numeric as premios,
           0::numeric as saldo, 0::numeric as pagado, 0::numeric as pendiente
    from apertura ap
    where not exists (select 1 from conVentas cv where cv.inicio = ap.inicio)
  ),
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
  pendiente_total as (
    select s.inicio,
           coalesce(s.pendiente, 0) + coalesce(ap.monto, 0) as pendiente
    from semana s
    left join apertura ap on ap.inicio = s.inicio
  ),
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
  ),
  /*
   * Los abonos vivos del vendedor: lo entregado a cuenta que todavía no absorbió
   * un corte. Es un total, no va por semana. Sólo se calcula al preguntar por un
   * vendedor concreto —el agregado de la casa (p_vendedor_id nulo) no tiene un
   * «acumulado a cobrar» que restar—.
   */
  abonos as (
    select coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where p_vendedor_id is not null
      and a.vendedor_id = p_vendedor_id
      and a.corte_id is null
  ),
  -- La semana más reciente de la lista: es la que se cobra hoy, y de la que se
  -- descuenta el abono. En las pasadas el abono de hoy no existía.
  vigente as (
    select max(inicio) as inicio from semana
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
         (select abonado from abonos),
         -- Acumulado neto: arrastre + pendiente de la semana + apertura, menos
         -- lo abonado SÓLO en la semana vigente (la de arriba del riel).
         c.arrastre + s.pendiente + coalesce(ap.monto, 0)
           - case when s.inicio = (select inicio from vigente)
                  then (select abonado from abonos) else 0 end
  from semana s
  left join direccion d  on d.inicio = s.inicio
  left join apertura  ap on ap.inicio = s.inicio
  join corrido        c  on c.inicio = s.inicio
  order by s.inicio desc;
$liq_semana$;

comment on function public.fn_liquidacion_por_semana(uuid) is
  'Las semanas de un vendedor, con arrastre y acumulado. El acumulado de la semana vigente descuenta los abonos a cuenta vivos (r_abonado), que se enseñan aparte. No cierra sorteos.';

revoke execute on function public.fn_liquidacion_por_semana(uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- La tabla de saldos del padrón: el «saldo actual» descuenta los abonos.
--
-- Misma idea en una sola semana: `r_abonado` por vendedor, y `r_actual` =
-- anterior + pendiente de la semana − abonado. Aquí no hay varias semanas entre
-- las que repartir: la tabla mira una, así que el abono entero baja su actual.
--
-- Se SUELTA antes de recrearla: gana la columna `r_abonado`, y `create or
-- replace` no puede cambiar el tipo de salida de una función que ya existe.
-- Soltarla y recrearla en la misma transacción no deja hueco.
-- ---------------------------------------------------------------------------
drop function if exists public.fn_saldos_por_vendedor(date, date);

create function public.fn_saldos_por_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_activo       boolean,
  r_anterior     numeric,
  r_venta        numeric,
  r_comision     numeric,
  r_premios      numeric,
  r_semana       numeric,
  r_liquidado    numeric,
  r_pendiente    numeric,
  r_abonado      numeric,   -- abonos vivos del vendedor
  r_actual       numeric    -- anterior + pendiente − abonado
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
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  apertura_antes as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null and saldado_en is null
      and vigente_desde < p_desde
    group by vendedor_id
  ),
  apertura_semana as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null and saldado_en is null
      and vigente_desde >= p_desde
      and vigente_desde <= p_hasta
    group by vendedor_id
  ),
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
  ),
  -- Los abonos vivos por vendedor: lo entregado a cuenta sin cerrar en un corte.
  abonos as (
    select a.vendedor_id, coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where a.corte_id is null
    group by a.vendedor_id
  ),
  /*
   * ¿La semana que se está mirando es la vigente —la más reciente con
   * movimiento—? El abono sólo baja el «actual» en esa, igual que en la hoja
   * (`fn_liquidacion_por_semana` lo resta sólo en la fila de arriba del riel).
   * Mirar una semana pasada y restarle el abono de hoy falsearía su saldo y la
   * descuadraría contra la hoja de esa misma semana. `date_trunc` porque las
   * semanas empiezan en lunes y p_desde ya es un lunes.
   */
  es_vigente as (
    select p_desde >= coalesce(
             (select max(date_trunc('week', s.fecha)::date)
              from public.liquidacion lq
              join public.sorteo s on s.id = lq.sorteo_id),
             p_desde
           ) as vigente
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         coalesce(a.anterior, 0) + coalesce(apa.monto, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0) + coalesce(aps.monto, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0) + coalesce(aps.monto, 0),
         coalesce(ab.abonado, 0),
         -- Actual: anterior + pendiente de la semana − abonos vivos, pero sólo
         -- se restan en la semana vigente (ver es_vigente).
         coalesce(a.anterior, 0) + coalesce(apa.monto, 0)
           + coalesce(s.pendiente, 0) + coalesce(aps.monto, 0)
           - case when (select vigente from es_vigente)
                  then coalesce(ab.abonado, 0) else 0 end
  from public.vendedor v
  left join antes           a   on a.vendedor_id = v.id
  left join apertura_antes  apa on apa.vendedor_id = v.id
  left join apertura_semana aps on aps.vendedor_id = v.id
  left join semana          s   on s.vendedor_id = v.id
  left join abonos          ab  on ab.vendedor_id = v.id
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(apa.monto, 0) <> 0
     or coalesce(aps.monto, 0) <> 0
     or coalesce(s.venta, 0) <> 0
     or coalesce(ab.abonado, 0) <> 0
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$saldos$;

revoke execute on function public.fn_saldos_por_vendedor(date, date) from public, anon;
