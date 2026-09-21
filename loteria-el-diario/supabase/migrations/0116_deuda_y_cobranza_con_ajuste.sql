-- ===========================================================================
-- La deuda y la cobranza incluyen el ajuste por corrección.
--
-- El ajuste (0114) es un saldo pendiente signado que deja corregir un sorteo ya
-- pagado. Estas dos funciones —lo que un vendedor debe hoy, y la lista de
-- cobranza— pasan a sumarlo, para que ese pendiente por liquidar aparezca en la
-- cuenta. Con signo: positivo sube lo que debe, negativo lo baja.
--
-- Firmas iguales: `create or replace`.
-- ===========================================================================

create or replace function public.fn_deuda_vendedor(p_vendedor_id uuid)
returns table (
  r_sorteos   integer,
  r_desde     date,
  r_hasta     date,
  r_deuda     numeric,
  r_abonado   numeric,
  r_pendiente numeric
)
language sql
stable
security definer
set search_path = public
as $deuda$
  with sin_cerrar as (
    select count(*)::integer                                   as sorteos,
           min(s.fecha)                                        as desde,
           max(s.fecha)                                        as hasta,
           coalesce(sum(lq.venta - lq.comision - lq.premios), 0) as deuda
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
      and not exists (
        select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
      )
  ),
  abonos as (
    select coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where a.vendedor_id = p_vendedor_id and a.corte_id is null
  )
  -- El pendiente ahora es deuda − abonado + ajuste. El ajuste va con su signo:
  -- lo dejó una corrección de un sorteo ya pagado, y es tan pendiente como un
  -- sorteo sin cerrar.
  select c.sorteos, c.desde, c.hasta, c.deuda, b.abonado,
         c.deuda - b.abonado + public.fn_ajuste_pendiente(p_vendedor_id)
  from sin_cerrar c cross join abonos b;
$deuda$;

comment on function public.fn_deuda_vendedor(uuid) is
  'Lo que un vendedor debe de sorteos sin cerrar, menos lo entregado a cuenta, más el ajuste por corrección de sorteos ya pagados.';

revoke execute on function public.fn_deuda_vendedor(uuid) from public, anon;


create or replace function public.fn_cobranza()
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_vendedor    text,
  r_activo      boolean,
  r_sorteos     integer,
  r_desde       date,
  r_hasta       date,
  r_deuda       numeric,
  r_abonado     numeric,
  r_pendiente   numeric,
  r_ultimo_pago date
)
language sql
stable
security definer
set search_path = public
as $cobranza$
  with sin_cerrar as (
    select lq.vendedor_id,
           count(*)::integer                                   as sorteos,
           min(s.fecha)                                        as desde,
           max(s.fecha)                                        as hasta,
           coalesce(sum(lq.venta - lq.comision - lq.premios), 0) as deuda
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    )
    group by lq.vendedor_id
  ),
  abonos as (
    select a.vendedor_id, coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where a.corte_id is null
    group by a.vendedor_id
  ),
  -- El ajuste vivo por vendedor, con signo.
  ajustes as (
    select a.vendedor_id, coalesce(sum(a.monto), 0) as ajuste
    from public.ajuste_liquidacion a
    where a.saldado_corte_id is null
    group by a.vendedor_id
  ),
  -- Todos los vendedores con algo pendiente: sorteos sin cerrar O sólo un
  -- ajuste vivo (un vendedor sin sorteos abiertos pero con un ajuste también
  -- hay que cobrarlo).
  base as (
    select vendedor_id from sin_cerrar
    union
    select vendedor_id from ajustes
  ),
  ultimo as (
    select vendedor_id, max(fecha) as fecha from (
      select vendedor_id, fecha_pago as fecha from public.abono_vendedor
      union all
      select vendedor_id, (pagado_en at time zone 'America/Tegucigalpa')::date
        from public.corte_vendedor
    ) t
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         coalesce(c.sorteos, 0),
         c.desde,
         c.hasta,
         coalesce(c.deuda, 0),
         coalesce(b.abonado, 0),
         coalesce(c.deuda, 0) - coalesce(b.abonado, 0) + coalesce(aj.ajuste, 0),
         u.fecha
  from base
  join public.vendedor v on v.id = base.vendedor_id
  left join sin_cerrar c on c.vendedor_id = base.vendedor_id
  left join abonos b on b.vendedor_id = base.vendedor_id
  left join ajustes aj on aj.vendedor_id = base.vendedor_id
  left join ultimo u on u.vendedor_id = base.vendedor_id
  where coalesce(c.deuda, 0) - coalesce(b.abonado, 0) + coalesce(aj.ajuste, 0) > 0
  order by coalesce(c.deuda, 0) - coalesce(b.abonado, 0) + coalesce(aj.ajuste, 0) desc;
$cobranza$;

comment on function public.fn_cobranza() is
  'Quiénes deben, del que más al que menos, con abonos y ajustes por corrección ya descontados. Incluye a quien sólo trae un ajuste vivo.';

revoke execute on function public.fn_cobranza() from public, anon;
