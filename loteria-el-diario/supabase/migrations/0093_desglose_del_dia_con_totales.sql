-- ===========================================================================
-- El desglose por vendedor del tablero, con la venta capturada por totales.
--
-- Es la otra mitad de la 0092. La tabla «Desglose por vendedor y sorteo» del
-- tablero salía de `v_agregado_sorteo_vendedor`, que sólo sabe de líneas, así
-- que un vendedor que ese día no usó el teléfono no aparecía: ni con cero, ni
-- con su venta capturada. Desaparecía del día.
--
-- POR QUÉ UN `full join` Y NO UN `left join`
-- ------------------------------------------
-- Hay tres casos y los tres tienen que salir:
--   · el que sólo vendió por el portal      -> está en la vista
--   · el que sólo tiene captura por totales -> está sólo en `venta_total`
--   · el que tiene las dos cosas            -> está en las dos, y hay que
--     sumarlas en UNA fila, no pintar dos por el mismo vendedor y sorteo
--
-- Un `left join` desde la vista perdería el segundo caso, que es justo el que
-- motivó la captura por totales. El `full join` por (vendedor, sorteo) cubre
-- los tres, y el `coalesce` de las claves reconstruye la fila venga de donde
-- venga.
--
-- El ESTADO y la HORA se leen del sorteo y no de la vista: una fila que sólo
-- existe por una captura no tiene nada que heredar de las líneas.
--
-- La regla de los premios es la misma de la 0092 y la 0048: el premio de una
-- captura se cuenta cuando el sorteo está liquidado, no antes.
-- ===========================================================================

create or replace function public.fn_desglose_dia(p_fecha date)
returns table (
  vendedor_id uuid,
  nombre      text,
  hora        public.hora_sorteo,
  estado      public.estado_sorteo,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security definer
set search_path = public
as $desglose$
  with
  por_linea as (
    select a.vendedor_id, a.sorteo_id,
           a.venta, a.comision, a.premios
    from public.v_agregado_sorteo_vendedor a
    where a.fecha = p_fecha
  ),
  por_total as (
    select vt.vendedor_id, vt.sorteo_id,
           vt.venta                          as venta,
           vt.venta * vt.comision_congelada  as comision,
           case when s.estado = 'liquidado' then vt.premios else 0 end as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.anulado_en is null
  ),
  juntos as (
    select coalesce(a.vendedor_id, b.vendedor_id) as vendedor_id,
           coalesce(a.sorteo_id,   b.sorteo_id)   as sorteo_id,
           coalesce(a.venta,    0) + coalesce(b.venta,    0) as venta,
           coalesce(a.comision, 0) + coalesce(b.comision, 0) as comision,
           coalesce(a.premios,  0) + coalesce(b.premios,  0) as premios
    from por_linea a
    full join por_total b
      on b.vendedor_id = a.vendedor_id
     and b.sorteo_id   = a.sorteo_id
  )
  select j.vendedor_id,
         public.fn_rotulo(v.alias, v.nombre),
         s.hora, s.estado,
         j.venta, j.comision, j.premios,
         j.venta - j.comision - j.premios
  from juntos j
  join public.vendedor v on v.id = j.vendedor_id
  join public.sorteo   s on s.id = j.sorteo_id
  order by v.codigo, s.hora;
$desglose$;

comment on function public.fn_desglose_dia(date) is
  'Un día, desglose por vendedor y sorteo: líneas MÁS capturas por totales, sumadas en una sola fila por vendedor y sorteo.';

revoke execute on function public.fn_desglose_dia(date) from public, anon;
