-- ===========================================================================
-- El padrón de liquidación devuelve también el ALIAS.
--
-- POR QUÉ
-- -------
-- El selector de vendedor pasa a ser un buscador: se teclea «merka» y aparece
-- MERKA EXPRESS. Para eso hace falta el alias en la lista, y
-- `fn_vendedores_liquidables` sólo devolvía el nombre registrado.
--
-- SE AÑADE, NO SE SUSTITUYE
-- -------------------------
-- `r_nombre` sigue siendo el nombre registrado y no se toca. La 0068 cambió
-- los INFORMES para que muestren el alias, pero aquí es distinto: el buscador
-- necesita los dos a la vez —busca en ambos, pinta el alias en grande y deja
-- el nombre en la línea gris— y eso es justo lo que permite comprobar que
-- «MERKA EXPRESS» es quien uno cree antes de cerrarle un pago.
--
-- En una pantalla donde se entrega dinero, esconder la identidad contable
-- detrás del rótulo comercial sería quitar precisamente el dato que sirve para
-- no equivocarse de persona.
--
-- La columna nueva va AL FINAL para no mover de sitio a las que ya estaban.
-- ===========================================================================

drop function if exists public.fn_vendedores_liquidables();

create function public.fn_vendedores_liquidables()
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
  order by v.codigo;
$$;

comment on function public.fn_vendedores_liquidables() is
  'Padrón del módulo de liquidación: los activos, más los de baja con sorteos sin pagar. Trae alias y nombre por separado para poder buscar por los dos.';

revoke execute on function public.fn_vendedores_liquidables()
  from public, anon;
