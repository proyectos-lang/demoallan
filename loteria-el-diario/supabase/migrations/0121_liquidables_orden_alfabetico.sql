-- ===========================================================================
-- El padrón para liquidar (combobox y selectores) se ordena por ALIAS.
-- Es la lista que alimenta el selector de vendedor de la liquidación. Sólo el
-- `order by` cambia. Ver la 0119.
-- ===========================================================================

create or replace function public.fn_vendedores_liquidables()
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_activo      boolean,
  r_eliminado   boolean,
  r_pendientes  integer,
  r_alias       text
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id,
         v.codigo,
         v.nombre,
         v.activo,
         v.eliminado_en is not null,
         coalesce(p.pendientes, 0)::integer,
         v.alias
  from public.vendedor v
  left join (
    select lq.vendedor_id, count(*) as pendientes
    from public.liquidacion lq
    where not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    )
    group by lq.vendedor_id
  ) p on p.vendedor_id = v.id
  -- Los activos, MÁS los de baja que todavía tienen sorteos sin pagar: a quien
  -- se le debe o debe, hay que poder seguir viéndolo hasta saldarlo.
  where v.activo or coalesce(p.pendientes, 0) > 0
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$$;

revoke execute on function public.fn_vendedores_liquidables() from public, anon;
