-- ===========================================================================
-- El administrador corrige un sorteo aunque ya se le haya pagado al vendedor.
--
-- LO QUE PEDÍA EL USUARIO
-- -----------------------
-- «Tengo que poder reversar los datos de cualquier vendedor aún cuando yo le
--  haya ya cerrado cuenta.» El cliente que se ingresa a mano a veces reclama
-- una venta o un premio DESPUÉS de que ya se cerró la cuenta, y toca corregir
-- y reenviarla. Hasta ahora el sistema lo prohibía en seco:
--
--     «Ese sorteo ya se le pagó al vendedor; no admite más venta.»
--
-- Ese rechazo vivía en `fn_recalcular_liquidacion`, el punto único por el que
-- pasan TODAS las correcciones —editar venta, editar venta por totales, anular
-- un ticket, captura masiva—. Mientras estuvo ahí, ninguna de esas vías podía
-- tocar un sorteo ya liquidado en un corte.
--
-- LA DECISIÓN
-- -----------
-- Control total para administración: se corrige y el sistema se adapta. El
-- corte firmado NO se falsea —lo que se le pagó al vendedor se pagó— pero el
-- sorteo corregido vuelve a estar pendiente por su valor NUEVO, y lo que ya se
-- le había pagado por él se le reconoce, de modo que lo que queda pendiente es
-- exactamente LA DIFERENCIA: un saldo a favor o en contra según se agregó o se
-- quitó venta.
--
-- CÓMO, SIN TOCAR EL NÚCLEO DE SALDOS
-- -----------------------------------
-- Todas las pantallas de saldo —arrastre, cobranza, saldos por vendedor, hoja
-- semanal— calculan lo pendiente como «las liquidaciones que NO están en
-- `corte_detalle`». Así que basta con desligar del corte la liquidación
-- corregida: reaparece como pendiente sola, con su cifra nueva, y las siete
-- funciones la recogen sin cambiar una línea.
--
-- El paso que hace que el neto sea la DIFERENCIA y no el sorteo entero: al
-- desligarla, lo que el corte había pagado por ella —`viejo`— se le reconoce
-- al vendedor. Se hace ajustando el propio corte:
--
--   · su `saldo` baja en `viejo` (deja de contar un sorteo que ya no lista),
--     así el corte sigue cuadrando consigo mismo: saldo == suma de su detalle;
--   · su `entrega` NO se toca: el vendedor entregó lo que entregó, y eso es
--     historia que no se reescribe;
--   · la diferencia entre entrega y el nuevo saldo cae en `ajuste`, con un
--     motivo que dice que fue por una corrección posterior.
--
-- Neto para el vendedor:
--   antes  → el sorteo estaba pagado por `viejo`, no pendiente.
--   ahora  → el sorteo está pendiente por `nuevo`, y el corte le reconoció
--            `viejo`. Pendiente real = nuevo − viejo. La diferencia, y sólo la
--            diferencia.
--
-- Si el sorteo estaba en VARIOS cortes es imposible por diseño: `corte_detalle`
-- tiene `unique (liquidacion_id)`. Una liquidación se paga una sola vez.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action —la base habla
-- como `service_role` desde la 0024, así que la guarda de rol va arriba, no
-- aquí—.
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
  v_liq       record;      -- la liquidación pagada, tal como está antes de tocarla
  v_viejo     numeric;     -- lo que el corte contó por este sorteo (utilidad vieja)
begin
  select id, numero_ganador, estado into v_sorteo
  from public.sorteo where id = p_sorteo_id;

  if v_sorteo.id is null or v_sorteo.estado <> 'liquidado' then
    return;
  end if;

  -- ¿Esta liquidación ya está pagada en un corte? Si lo está, hay que
  -- desligarla ANTES de reescribir sus cifras, porque necesito la utilidad
  -- vieja —lo que el corte pagó por ella— para reconocérsela al vendedor.
  select lq.id,
         lq.venta - lq.comision - lq.premios as utilidad,
         d.corte_id
    into v_liq
  from public.liquidacion lq
  join public.corte_detalle d on d.liquidacion_id = lq.id
  where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id;

  if found then
    v_viejo := v_liq.utilidad;

    /*
     * Se desliga del corte: se borra su fila de detalle. Con eso el sorteo
     * vuelve a estar pendiente —la hoja lo busca por «no existe en
     * corte_detalle»— y su valor NUEVO reaparece entero.
     */
    delete from public.corte_detalle
     where corte_id = v_liq.corte_id and liquidacion_id = v_liq.id;

    /*
     * El corte se reequilibra para que siga cuadrando consigo mismo y para
     * reconocerle al vendedor lo que ya se le pagó por este sorteo:
     *
     *   · `saldo` baja en `viejo`: ya no cuenta un sorteo que dejó de listar,
     *     así saldo vuelve a ser la suma de su detalle vivo;
     *   · `entrega` NO se toca: lo entregado es historia;
     *   · `ajuste` = entrega − nuevo saldo, que es lo que ahora le sobra o le
     *     falta al corte respecto de lo que se entregó.
     *
     * `entrega` puede ser nula en cortes viejos (antes de la 0069 se asumía
     * igual al saldo): en ese caso se materializa con el saldo de entonces,
     * que es justo lo que aquellos cortes daban por entregado.
     */
    update public.corte_vendedor c
    set saldo   = c.saldo - v_viejo,
        entrega = coalesce(c.entrega, c.saldo),
        ajuste  = coalesce(c.entrega, c.saldo) - (c.saldo - v_viejo),
        motivo_ajuste = btrim(
          coalesce(c.motivo_ajuste || ' · ', '') ||
          'Corrección posterior de un sorteo (' || v_sorteo.id::text || ')'
        )
    where c.id = v_liq.corte_id;

    perform public.fn_auditar(
      'corte_vendedor', v_liq.corte_id, 'ajustar', 'saldo',
      (v_liq.utilidad)::text,
      'sorteo desligado por corrección · ' || p_sorteo_id::text ||
      ' · reconocido ' || v_viejo::text
    );
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

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
    into v_venta, v_comision, v_premios
  from public.linea l
  join public.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null;

  -- Y lo capturado por totales para ese mismo vendedor y sorteo.
  select v_venta    + coalesce(sum(vt.venta), 0),
         v_comision + coalesce(sum(vt.venta * vt.comision_congelada), 0),
         v_premios  + coalesce(sum(vt.premios), 0)
    into v_venta, v_comision, v_premios
  from public.venta_total vt
  where vt.sorteo_id = p_sorteo_id
    and vt.vendedor_id = p_vendedor_id
    and vt.anulado_en is null;

  -- Sin nada de ninguna de las dos fuentes, la fila sobra.
  if v_venta = 0 and v_premios = 0 then
    delete from public.liquidacion
     where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id;
    return;
  end if;

  insert into public.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios,
    v_venta - v_comision - v_premios
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;
end;
$recalc$;

comment on function public.fn_recalcular_liquidacion(uuid, uuid) is
  'Rehace la liquidación de un vendedor en un sorteo. Si el sorteo ya se pagó en un corte, lo desliga del corte —vuelve a pendiente por su valor nuevo— y reequilibra el corte reconociéndole al vendedor lo ya pagado, de modo que sólo la diferencia queda pendiente.';

revoke execute on function public.fn_recalcular_liquidacion(uuid, uuid) from public, anon;
