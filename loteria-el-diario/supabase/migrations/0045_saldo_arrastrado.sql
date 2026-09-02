-- ===========================================================================
-- El saldo que viene de atrás.
--
-- Una semana rara vez se cierra entera el domingo: se cobra lo que el vendedor
-- alcanzó a entregar y el resto queda. Mirando sólo la semana en pantalla, ese
-- resto desaparece de la vista, y la cuenta que se le dice al vendedor por
-- teléfono no es la que él tiene en la cabeza.
--
-- Se añaden dos cifras:
--
--   r_arrastre    lo que quedó pendiente de TODAS las semanas anteriores
--   r_acumulado   r_arrastre + r_pendiente — la cuenta completa a esa fecha
--
-- ESTRICTAMENTE ANTERIORES. El arrastre no incluye la semana que se mira: para
-- eso está `r_pendiente`. Sumarlas es `r_acumulado`, y es la única de las tres
-- que contesta «¿cuánto debemos en total a día de hoy?».
--
-- SE CUENTA POR FECHA DEL SORTEO, no por la fecha del corte. Un cobro tardío
-- —el jueves siguiente se paga el lunes de la semana pasada— no mueve el
-- sorteo de semana: lo saca de `pendiente` y por tanto del arrastre de todas
-- las semanas posteriores, que es exactamente lo que debe pasar.
--
-- POR QUÉ EL ARRASTRE VA EN NETO Y NO PARTIDO EN DOS
-- --------------------------------------------------
-- La 0044 separó lo pendiente en «por cobrar» y «por pagar» porque sumarlas
-- escondía el trabajo del padrón entero. El arrastre es otra cosa: es la
-- cuenta corriente de UNA persona, y ahí el neto es la dirección. Con
-- `p_vendedor_id` en nulo el arrastre suma cuentas de gente distinta y no
-- significa gran cosa; por eso la pantalla sólo lo enseña cuando hay un
-- vendedor elegido.
--
-- La ventana se calcula en orden ascendente aunque la función devuelva de la
-- más reciente a la más vieja: un acumulado sólo existe hacia adelante.
--
-- Cambia el tipo de retorno, así que hay que soltar la función. Igual que la
-- 0037, la 0039, la 0042 y la 0044.
-- ===========================================================================

drop function if exists allan.fn_liquidacion_por_semana(uuid);

create function allan.fn_liquidacion_por_semana(
  p_vendedor_id uuid default null
) returns table (
  r_inicio        date,
  r_fin           date,
  r_semana        integer,
  r_anio          integer,
  r_sorteos       integer,   -- sorteos distintos de la semana
  r_liquidaciones integer,   -- filas de liquidación; con un vendedor, = sorteos
  r_pagadas       integer,
  r_pendientes    integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_saldo         numeric,   -- todo lo de la semana
  r_pagado        numeric,   -- lo que ya se cerró en un corte
  r_pendiente     numeric,   -- lo que falta de ESTA semana, en neto
  r_por_cobrar    numeric,   -- de lo pendiente, lo que entregan los vendedores
  r_por_pagar     numeric,   -- de lo pendiente, lo que entrega la casa
  r_arrastre      numeric,   -- lo pendiente de las semanas ANTERIORES
  r_acumulado     numeric    -- r_arrastre + r_pendiente
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with base as (
    select date_trunc('week', s.fecha)::date as inicio,
           lq.vendedor_id,
           s.id as sorteo_id,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where p_vendedor_id is null or lq.vendedor_id = p_vendedor_id
  ),
  semana as (
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
  -- Primer piso: lo que le queda pendiente a cada vendedor en cada semana.
  por_vendedor as (
    select inicio,
           vendedor_id,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from base
    group by inicio, vendedor_id
  ),
  -- Segundo piso: los que deben por un lado y los que cobran por el otro.
  direccion as (
    select inicio,
           coalesce(sum(greatest(pendiente, 0)), 0) as por_cobrar,
           coalesce(sum(-least(pendiente, 0)), 0)   as por_pagar
    from por_vendedor
    group by inicio
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
    from semana
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
         d.por_cobrar,
         d.por_pagar,
         c.arrastre,
         c.arrastre + s.pendiente
  from semana s
  join direccion d on d.inicio = s.inicio
  join corrido   c on c.inicio = s.inicio
  -- La más reciente primero: es la que se liquida.
  order by s.inicio desc;
$$;

comment on function allan.fn_liquidacion_por_semana(uuid) is
  'Liquidación semana a semana, con lo que se arrastra de las anteriores. Sin vendedor, el padrón entero.';

revoke execute on function allan.fn_liquidacion_por_semana(uuid) from public, anon;
