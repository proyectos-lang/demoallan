-- ===========================================================================
-- La cobranza se ordena por ALIAS (alfabético), no por lo que más deben.
-- Por decisión: todas las listas de clientes van por alias. Sólo el `order by`.
-- Ver la 0119. La deuda (fn_deuda_vendedor) no lista: no cambia.
-- ===========================================================================

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
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$cobranza$;

revoke execute on function public.fn_cobranza() from public, anon;
