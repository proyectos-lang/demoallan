-- ===========================================================================
-- La semana EN CURSO existe aunque el vendedor no haya vendido todavía.
--
-- EL SÍNTOMA
-- ----------
-- La tarjeta de «arrastre de semanas anteriores» —y con ella el botón de
-- saldarlo— no aparecía NUNCA en la hoja del vendedor. Se comprobó vendedor a
-- vendedor: de ochenta y cinco, ninguno tenía una sola semana con arrastre
-- distinto de cero.
--
-- LA CAUSA
-- --------
-- `fn_liquidacion_por_semana` construye la lista de semanas a partir de
-- `liquidacion`: sólo existe una semana si en ella hubo ventas liquidadas.
--
-- Y el arrastre, por definición, se muestra en la semana SIGUIENTE a la que lo
-- generó. Un vendedor que dejó saldo el 31 de agosto y no ha vuelto a vender
-- arrastra 460 lempiras que no tienen dónde verse: la semana que los mostraría
-- no existe, porque no hubo ventas en ella.
--
-- Es decir: el arrastre sólo era visible para quien siguiera vendiendo, y
-- justo al que deja de vender es a quien hay que ir a cobrarle.
--
-- QUÉ CAMBIA
-- ----------
-- Se añade la SEMANA EN CURSO a la lista, aunque esté vacía, cuando el
-- vendedor arrastra algo. Sale con sus cifras en cero —no vendió— y con el
-- arrastre que trae, que es justo lo que hay que cobrar.
--
-- SÓLO CUANDO HAY ALGO QUE ARRASTRAR. Una semana vacía y sin deuda es ruido:
-- alarga el riel de semanas con una fila que no dice nada. Y sólo la EN CURSO,
-- no todas las que hayan pasado en medio: la hoja sirve para cobrar hoy, no
-- para inventariar los meses en que alguien no vendió.
--
-- SÓLO CON UN VENDEDOR CONCRETO. Con `p_vendedor_id` nulo la función devuelve
-- el agregado de toda la casa, donde una semana sin ventas de nadie no
-- significa lo mismo y nadie la está esperando.
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
   * La semana en curso, en blanco, si hace falta.
   *
   * Se añade sólo cuando se pregunta por UN vendedor, esa semana no está ya en
   * la lista, y queda algo pendiente de antes. Sin esa última condición se
   * colaría una fila vacía en el riel de cualquiera que no haya vendido hoy.
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
      and exists (
        select 1 from base b
        where not b.pagada
          and b.inicio < date_trunc('week', (now() at time zone 'America/Tegucigalpa')::date)::date
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
         -- La semana añadida no tiene fila en `direccion`, que se construye
         -- desde las ventas: sin ventas no hay nadie que cobre ni que pague.
         coalesce(d.por_cobrar, 0),
         coalesce(d.por_pagar, 0),
         c.arrastre,
         c.arrastre + s.pendiente
  from semana s
  left join direccion d on d.inicio = s.inicio
  join corrido   c on c.inicio = s.inicio
  -- La más reciente primero: es la que se liquida.
  order by s.inicio desc;
$$;

comment on function public.fn_liquidacion_por_semana(uuid) is
  'Las semanas de un vendedor. Añade la semana en curso aunque esté vacía cuando arrastra saldo de antes: si no, lo que se le debe cobrar no tiene dónde verse.';

revoke execute on function public.fn_liquidacion_por_semana(uuid)
  from public, anon;
