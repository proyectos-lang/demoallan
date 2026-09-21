-- ===========================================================================
-- Corregir un sorteo ya pagado NO reabre la liquidación: deja un ajuste.
--
-- CAMBIO DE MODELO (decisión del gerente)
-- ---------------------------------------
-- Antes, si se corregía un sorteo ya pagado, `fn_recalcular_liquidacion`
-- DESLIGABA la liquidación de su corte (reaparecía «abierta») y compensaba con
-- un abono. Ahora NO: la liquidación pagada se queda intacta en su corte, para
-- siempre. La diferencia entre la cifra nueva y la pagada se registra como un
-- AJUSTE signado (ver la 0114), que aparece como saldo pendiente por liquidar.
--
--   · Sorteo SIN pagar → se rehace la liquidación como siempre.
--   · Sorteo YA pagado → la liquidación no se toca; la diferencia va al ajuste.
--
-- Así una liquidación hecha nunca se anula, se quita ni se reabre. El corte
-- firmado queda congelado y siempre cuadra consigo mismo.
--
-- Se retira el desligue y el abono de reconocimiento de la 0104: ese mecanismo
-- ya no se usa. (Los abonos que la 0104 dejó en cortes viejos se conservan;
-- esos cinco cortes se dejaron como estaban, por decisión, y su cuenta cuadra.)
-- ===========================================================================

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
  v_liq       record;      -- la liquidación pagada, si la hay
  v_viejo     numeric;     -- lo que el corte pagó por este sorteo (utilidad)
  v_nuevo     numeric;     -- la utilidad recalculada de verdad
begin
  select id, numero_ganador, estado into v_sorteo
  from public.sorteo where id = p_sorteo_id;

  if v_sorteo.id is null or v_sorteo.estado <> 'liquidado' then
    return;
  end if;

  -- Las líneas nuevas que acertaron, con el factor congelado de cada una.
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

  -- Lo recalculado de verdad, de las dos fuentes.
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

  -- ¿La liquidación de este sorteo ya está pagada en un corte?
  select lq.id,
         lq.venta - lq.comision - lq.premios as utilidad
    into v_liq
  from public.liquidacion lq
  join public.corte_detalle d on d.liquidacion_id = lq.id
  where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id;

  if found then
    /*
     * YA PAGADA: la liquidación NO se toca —queda en su corte con su valor
     * histórico—. La diferencia entre lo recalculado y lo pagado va al ajuste
     * VIVO de este sorteo, acumulándose sobre la misma fila. Si el ajuste queda
     * en cero, se retira: no ensucia la cuenta con un pendiente de nada.
     */
    v_viejo := v_liq.utilidad;

    if round(v_nuevo - v_viejo, 2) = 0 then
      delete from public.ajuste_liquidacion
       where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id
         and saldado_corte_id is null;
    else
      insert into public.ajuste_liquidacion (vendedor_id, sorteo_id, monto, motivo)
      values (
        p_vendedor_id, p_sorteo_id, round(v_nuevo - v_viejo, 2),
        'Corrección de un sorteo ya liquidado'
      )
      on conflict (sorteo_id, vendedor_id, saldado_corte_id) do update
      set monto  = round(v_nuevo - v_viejo, 2),
          motivo = 'Corrección de un sorteo ya liquidado',
          creado_en = now();

      perform public.fn_auditar(
        'ajuste_liquidacion', v_liq.id, 'ajustar', 'monto',
        v_viejo::text, v_nuevo::text
      );
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

comment on function public.fn_recalcular_liquidacion(uuid, uuid) is
  'Rehace la liquidación de un vendedor en un sorteo. Si el sorteo NO está pagado, la reescribe. Si YA está pagado en un corte, no la toca: la diferencia queda como ajuste pendiente (0114), sin reabrir ni desligar nada.';

revoke execute on function public.fn_recalcular_liquidacion(uuid, uuid) from public, anon;
