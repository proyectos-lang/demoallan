-- ===========================================================================
-- La matriz de captura por totales se ordena por ALIAS. Sólo el `order by`.
-- Ver la 0119.
-- ===========================================================================

create or replace function public.fn_matriz_totales(p_sorteo_id uuid)
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_vendedor    text,
  r_factor      numeric,
  r_comision    numeric,
  /* Lo ya capturado por totales, si lo hay. */
  r_venta       numeric,
  /* Lo APOSTADO, deducido del premio pagado: es lo que se teclea. */
  r_premiado    numeric,
  r_captura_id  uuid,
  /* Lo que vendió por su teléfono en este sorteo. Cero si no vendió. */
  r_venta_propia numeric,
  r_tickets      integer
)
language sql
stable
security definer
set search_path = public
as $matriz$
  with propio as (
    select t.vendedor_id,
           count(distinct t.id)::integer as tickets,
           coalesce(sum(l.monto), 0)     as venta
    from public.ticket t
    left join public.linea l on l.ticket_id = t.id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
    group by t.vendedor_id
  ),
  capturado as (
    select vt.vendedor_id, vt.id, vt.venta, vt.premios, vt.factor_congelado
    from public.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.anulado_en is null
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         p.factor_pago,
         p.comision,
         c.venta,
         -- Se devuelve lo APOSTADO, no lo pagado: es lo que se teclea, y la
         -- casilla tiene que abrir con la misma cifra que se escribió.
         case when c.id is not null and coalesce(c.factor_congelado, p.factor_pago, 0) > 0
              then round(c.premios / coalesce(c.factor_congelado, p.factor_pago), 2) end,
         c.id,
         coalesce(pr.venta, 0),
         coalesce(pr.tickets, 0)
  from public.vendedor v
  join public.parametro_vendedor p
    on p.vendedor_id = v.id and p.vigente_hasta is null
  left join capturado c on c.vendedor_id = v.id
  left join propio pr on pr.vendedor_id = v.id
  where v.activo and v.eliminado_en is null
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$matriz$;

revoke execute on function public.fn_matriz_totales(uuid) from public, anon;
