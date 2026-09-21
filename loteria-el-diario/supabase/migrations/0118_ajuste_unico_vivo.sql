-- ===========================================================================
-- El ajuste vivo por sorteo y vendedor es ÚNICO de verdad.
--
-- LO QUE FALLABA
-- --------------
-- La 0114 puso `unique (sorteo_id, vendedor_id, saldado_corte_id)` para que una
-- corrección sucesiva acumulara sobre la misma fila. Pero en un índice único,
-- NULL nunca es igual a NULL: dos filas vivas —ambas con `saldado_corte_id`
-- nulo— NO chocan, así que el `on conflict` de la 0115 no disparaba y cada
-- corrección insertaba un ajuste nuevo. La cuenta acababa con varios ajustes
-- vivos del mismo sorteo, y el pendiente sumaba de más.
--
-- LA CORRECCIÓN
-- -------------
--   · Se cambia el unique por un ÍNDICE ÚNICO PARCIAL sobre (sorteo, vendedor)
--     WHERE saldado_corte_id is null: garantiza una sola fila VIVA, y deja
--     libres las ya saldadas (que sí pueden repetirse a lo largo del tiempo).
--   · `fn_recalcular_liquidacion` deja de usar `on conflict` —que no puede
--     apuntar a un índice parcial— y hace update-si-existe / insert-si-no sobre
--     la fila viva.
--
-- Antes de crear el índice se consolida cualquier duplicado vivo que la versión
-- anterior haya dejado: se suma en una fila y se borran las demás.
-- ===========================================================================

-- 1) Quitar el unique viejo (no servía) y consolidar duplicados vivos.
alter table public.ajuste_liquidacion
  drop constraint if exists ajuste_liquidacion_sorteo_id_vendedor_id_saldado_corte_id_key;

-- Se conserva la fila viva más antigua de cada (sorteo, vendedor) —desempatada
-- por id, que no admite min() en Postgres, así que se ordena y se toma la
-- primera— y se le suma el total de sus duplicados. `min(id)` no existe para
-- uuid; por eso el rank por (creado_en, id) en vez de un agregado sobre el id.
with ranked as (
  select id, sorteo_id, vendedor_id, monto,
         row_number() over (
           partition by sorteo_id, vendedor_id
           order by creado_en, id
         ) as rn,
         sum(monto) over (partition by sorteo_id, vendedor_id) as total,
         count(*)   over (partition by sorteo_id, vendedor_id) as n
  from public.ajuste_liquidacion
  where saldado_corte_id is null
)
update public.ajuste_liquidacion a
set monto = r.total
from ranked r
where a.id = r.id and r.rn = 1 and r.n > 1;

delete from public.ajuste_liquidacion a
using (
  select id,
         row_number() over (
           partition by sorteo_id, vendedor_id
           order by creado_en, id
         ) as rn
  from public.ajuste_liquidacion
  where saldado_corte_id is null
) r
where a.id = r.id and r.rn > 1;

-- 2) Índice único parcial: una sola fila VIVA por sorteo y vendedor.
create unique index if not exists ajuste_liquidacion_vivo_unico
  on public.ajuste_liquidacion (sorteo_id, vendedor_id)
  where saldado_corte_id is null;

-- 3) fn_recalcular_liquidacion: upsert explícito sobre la fila viva.
create or replace function public.fn_recalcular_liquidacion(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $recalc$
declare
  v_sorteo    record;
  v_venta     numeric;
  v_comision  numeric;
  v_premios   numeric;
  v_liq       record;
  v_viejo     numeric;
  v_nuevo     numeric;
  v_delta     numeric;
  v_ajuste_id uuid;
begin
  select id, numero_ganador, estado into v_sorteo
  from public.sorteo where id = p_sorteo_id;

  if v_sorteo.id is null or v_sorteo.estado <> 'liquidado' then
    return;
  end if;

  update public.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from public.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null
    and l.numero = v_sorteo.numero_ganador
    and not l.gana;

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
    into v_venta, v_comision, v_premios
  from public.linea l
  join public.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null;

  select v_venta    + coalesce(sum(vt.venta), 0),
         v_comision + coalesce(sum(vt.venta * vt.comision_congelada), 0),
         v_premios  + coalesce(sum(vt.premios), 0)
    into v_venta, v_comision, v_premios
  from public.venta_total vt
  where vt.sorteo_id = p_sorteo_id
    and vt.vendedor_id = p_vendedor_id
    and vt.anulado_en is null;

  v_nuevo := v_venta - v_comision - v_premios;

  select lq.id,
         lq.venta - lq.comision - lq.premios as utilidad
    into v_liq
  from public.liquidacion lq
  join public.corte_detalle d on d.liquidacion_id = lq.id
  where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id;

  if found then
    -- YA PAGADA: la liquidación no se toca. La diferencia va al ajuste VIVO,
    -- que es único por el índice parcial. Se actualiza si existe, se crea si no,
    -- y se retira cuando queda en cero.
    v_viejo := v_liq.utilidad;
    v_delta := round(v_nuevo - v_viejo, 2);

    select id into v_ajuste_id
    from public.ajuste_liquidacion
    where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id
      and saldado_corte_id is null;

    if v_delta = 0 then
      if v_ajuste_id is not null then
        delete from public.ajuste_liquidacion where id = v_ajuste_id;
      end if;
    elsif v_ajuste_id is not null then
      update public.ajuste_liquidacion
      set monto = v_delta, motivo = 'Corrección de un sorteo ya liquidado', creado_en = now()
      where id = v_ajuste_id;
    else
      insert into public.ajuste_liquidacion (vendedor_id, sorteo_id, monto, motivo)
      values (p_vendedor_id, p_sorteo_id, v_delta, 'Corrección de un sorteo ya liquidado');
    end if;

    if v_delta <> 0 then
      perform public.fn_auditar('ajuste_liquidacion', v_liq.id, 'ajustar', 'monto',
                                v_viejo::text, v_nuevo::text);
    end if;
    return;
  end if;

  -- SIN pagar: la liquidación se rehace como siempre.
  if v_venta = 0 and v_premios = 0 then
    delete from public.liquidacion
     where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id;
    return;
  end if;

  insert into public.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios, v_nuevo
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;
end;
$recalc$;

revoke execute on function public.fn_recalcular_liquidacion(uuid, uuid) from public, anon;
