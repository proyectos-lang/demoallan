-- ===========================================================================
-- La hoja del vendedor también cuenta el saldo de apertura.
--
-- LO QUE REPORTÓ EL USUARIO
-- -------------------------
-- Le cargó a V-002 un saldo inicial de 1, y en la HOJA del vendedor no aparece
-- ni la tarjeta de «arrastre de semanas anteriores» ni ese 1 en el botón de
-- pagar. La tarjeta de apertura sí sale —«entró al sistema debiendo L 1»—
-- porque lee `saldo_inicial` directo; pero el arrastre no lo cuenta.
--
-- LA CAUSA, QUE ES UNA FUNCIÓN QUE SE ME QUEDÓ SIN CORREGIR
-- --------------------------------------------------------
-- El saldo de apertura se metió en la liquidación por tres puertas: la 0096
-- (la pestaña de saldos), la 0097 (cobrar) y la 0098/0099 (la fecha). Todas
-- tocan `fn_saldos_por_vendedor` y `fn_saldar_arrastre`.
--
-- Pero la HOJA no usa ninguna de esas: usa `fn_liquidacion_por_semana`, que
-- calcula el arrastre como la suma acumulada de lo pendiente de las semanas
-- anteriores. Esa función nunca miró `saldo_inicial`, así que para la hoja el
-- arrastre seguía siendo cero. Medido: V-002 daba `r_arrastre 0` teniendo el
-- saldo de 1 guardado y visible en la otra pestaña.
--
-- CÓMO ENTRA SIN ROMPER LA ACUMULACIÓN
-- ------------------------------------
-- El arrastre de aquí no es un `select` suelto: es una ventana que va sumando
-- lo pendiente semana a semana. Meter el saldo como una resta al final no
-- serviría —aparecería sólo en una semana, no arrastrado hacia adelante—.
--
-- Se trata como lo que es: una fila más de «pendiente», en la semana de su
-- `vigente_desde`. Así la misma ventana que arrastra los sorteos impagos lo
-- arrastra a él, y aparece en su semana y en todas las siguientes hasta que se
-- cobre. Es el mismo criterio de la 0099: cuenta desde la semana en que se
-- cargó, no antes.
--
-- SÓLO EL VIVO Y SIN COBRAR, y sólo cuando se pregunta por UN vendedor —que es
-- como la hoja llama siempre—: sumar aperturas al riel general del padrón no
-- tiene sentido, ahí no hay una columna de arrastre por persona.
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
   * El saldo de apertura, colocado en la SEMANA de su fecha.
   *
   * `date_trunc('week', …)` lo lleva al lunes de esa semana, que es la clave
   * con la que se agrupan todas las demás. Sólo el vivo y sin cobrar, y sólo
   * al preguntar por un vendedor concreto.
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
   * La semana en curso, en blanco, si hace falta.
   *
   * Se añade cuando se pregunta por un vendedor, esa semana no está ya en la
   * lista, y queda algo pendiente de antes —sorteos impagos O un saldo de
   * apertura de una semana anterior—. Sin esa condición se colaría una fila
   * vacía en el riel de cualquiera que no haya vendido hoy.
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
   * Lo pendiente de cada semana, sumándole el saldo de apertura de esa semana.
   *
   * Es lo que hace que el arrastre lo recoja: la ventana de más abajo acumula
   * ESTA cifra, no sólo la de los sorteos. Un saldo de apertura pasa a
   * arrastrarse igual que un sorteo impago.
   *
   * Se toman las semanas de las DOS fuentes: puede haber una apertura en una
   * semana sin ventas, y esa semana tiene que existir para que su saldo entre
   * en el arrastre de las siguientes.
   */
  pendiente_total as (
    select sem.inicio,
           coalesce(cv.pendiente, 0) + coalesce(ap.monto, 0) as pendiente
    from (
      select inicio from semana
      union
      select inicio from apertura
    ) sem
    left join semana   cv on cv.inicio = sem.inicio
    left join apertura ap on ap.inicio = sem.inicio
  ),
  -- El arrastre: todo lo pendiente hasta la semana anterior, sin incluirla.
  -- `1 preceding` es lo que deja fuera la fila actual.
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
         -- El acumulado incluye la apertura de ESTA semana, si la hay: es lo
         -- que se cuadra de verdad cuando administración llame.
         c.arrastre + s.pendiente + coalesce(ap.monto, 0)
  from semana s
  left join direccion d  on d.inicio = s.inicio
  left join apertura  ap on ap.inicio = s.inicio
  join corrido        c  on c.inicio = s.inicio
  -- La más reciente primero: es la que se liquida.
  order by s.inicio desc;
$liq_semana$;

comment on function public.fn_liquidacion_por_semana(uuid) is
  'Las semanas de un vendedor, con el arrastre y el acumulado. El arrastre incluye el saldo de apertura, colocado en la semana de su fecha.';

revoke execute on function public.fn_liquidacion_por_semana(uuid)
  from public, anon;
