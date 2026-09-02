-- ===========================================================================
-- La liquidación tiene dos direcciones, y sumarlas las esconde.
--
-- Una semana puede acabar de dos maneras: el vendedor entrega dinero, o la
-- casa se lo entrega a él porque los premios que pagó de su bolsillo superaron
-- su venta. Las dos son liquidar; lo que cambia es quién saca la cartera.
--
-- El problema es de los TOTALES. `r_pendiente` es una resta, así que al mirar
-- el padrón entero un vendedor que debe 5.000 y otro al que se le deben 5.000
-- se cancelan y el resumen dice «pendiente: 0» — cuando lo que hay son diez
-- mil lempiras de movimiento por hacer en dos direcciones. Con ese cero nadie
-- sale a cobrar ni prepara efectivo para pagar.
--
-- Por eso se devuelven aparte:
--
--   r_por_cobrar  lo que hay que RECIBIR de los vendedores que deben
--   r_por_pagar   lo que hay que ENTREGAR a los vendedores a los que se debe
--
-- y sigue cumpliéndose `r_pendiente = r_por_cobrar − r_por_pagar`.
--
-- SE CLASIFICA POR VENDEDOR, NO POR SORTEO
-- ----------------------------------------
-- La dirección la decide el saldo de la SEMANA de cada vendedor, no el de cada
-- sorteo: dentro de una misma semana un vendedor puede tener un sorteo malo y
-- dos buenos, y no se le cobra y se le paga por separado — se cuadra una vez.
-- De ahí la agregación en dos pisos: primero por (semana, vendedor) y después
-- por semana.
--
-- Cambia el tipo de retorno, así que hay que soltar la función. Igual que la
-- 0037, la 0039 y la 0042.
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
  r_pendiente     numeric,   -- lo que falta, en neto
  r_por_cobrar    numeric,   -- de lo pendiente, lo que entregan los vendedores
  r_por_pagar     numeric    -- de lo pendiente, lo que entrega la casa
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
         d.por_pagar
  from semana s
  join direccion d on d.inicio = s.inicio
  -- La más reciente primero: es la que se liquida.
  order by s.inicio desc;
$$;

comment on function allan.fn_liquidacion_por_semana(uuid) is
  'Liquidación semana a semana: cuánto hay, cuánto se liquidó y cuánto falta, separando lo que se cobra de lo que se paga.';

revoke execute on function allan.fn_liquidacion_por_semana(uuid) from public, anon;
