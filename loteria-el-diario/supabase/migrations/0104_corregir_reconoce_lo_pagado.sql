-- ===========================================================================
-- La corrección de un sorteo ya pagado reconoce lo pagado DONDE SÍ SE VE.
--
-- LO QUE FALLABA EN LA 0103
-- -------------------------
-- La 0103 desligaba del corte el sorteo corregido —bien— y reconocía lo ya
-- pagado ajustando el `saldo`/`ajuste`/`entrega` del propio corte. El problema:
-- NINGUNA pantalla de saldo lee esas columnas del corte. `fn_deuda_vendedor`,
-- la cobranza, los saldos por vendedor y la hoja semanal calculan lo pendiente
-- como «liquidaciones sin corte MENOS abonos», y de ahí sólo el ABONO está a su
-- alcance. Así que el reconocimiento quedaba invisible: el sorteo volvía a
-- pendiente por su valor NUEVO ENTERO, no por la diferencia. Exactamente lo que
-- NO se quería.
--
-- LA CORRECCIÓN
-- -------------
-- El reconocimiento tiene que ir por un ABONO, que es lo único que las pantallas
-- restan del pendiente. Un abono representa dinero ya entregado a cuenta, que es
-- justo lo que `viejo` es: lo que el corte ya le pagó por ese sorteo.
--
--   pendiente tras corregir = nuevo (el sorteo vuelto a pendiente)
--                             − viejo (el abono que reconoce lo pagado)
--                           = nuevo − viejo = LA DIFERENCIA. ✓
--
-- EL CASO DE SIGNO
-- ----------------
-- Un abono no puede ser negativo (`check (monto > 0)`: devolver dinero al
-- vendedor no es un abono). Por eso:
--
--   · Si `viejo > 0` —el vendedor debía ese sorteo y lo pagó, el caso común—
--     se registra un abono de `viejo`. Las pantallas lo restan y queda la
--     diferencia, exacta y automática.
--
--   · Si `viejo <= 0` —la casa le había pagado a él ese sorteo, raro— no hay
--     abono que valga. Se desliga igual y se deja constancia en el corte y en
--     la auditoría, con un aviso de que ese reconocimiento se cierra a mano.
--     Es la decisión tomada: automático donde se puede, trazado donde no.
--
-- El abono nace SIN corte (`corte_id null`): está vivo, descuenta del pendiente,
-- y cuando se cierre la cuenta de nuevo se marca con el corte que lo absorba,
-- como cualquier otro abono. Se inserta directo, sin pasar por
-- `fn_registrar_abono`, porque esa función rechaza un abono mayor que la deuda
-- viva —y este reconoce algo que ya se pagó, no que se deba ahora—.
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
  v_hoy       date := (now() at time zone 'America/Tegucigalpa')::date;
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
     * corte_detalle»— y su valor NUEVO reaparece entero. El reconocimiento de
     * lo ya pagado va por el abono de abajo, no por el corte.
     */
    delete from public.corte_detalle
     where corte_id = v_liq.corte_id and liquidacion_id = v_liq.id;

    if v_viejo > 0 then
      /*
       * El vendedor debía ese sorteo y lo pagó: se le reconoce con un abono
       * vivo de `viejo`. Las pantallas lo restan del pendiente, así que lo que
       * queda es nuevo − viejo, la diferencia. Se inserta directo: no pasa por
       * `fn_registrar_abono` porque reconoce algo YA pagado, no una deuda viva,
       * y aquella función lo rechazaría por «pasa de lo que debe».
       */
      insert into public.abono_vendedor (vendedor_id, monto, fecha_pago, nota)
      values (
        p_vendedor_id, round(v_viejo, 2), v_hoy,
        'Reconocimiento por corrección de un sorteo ya pagado ('
          || p_sorteo_id::text || ')'
      );

      perform public.fn_auditar(
        'corte_vendedor', v_liq.corte_id, 'ajustar', 'saldo',
        v_viejo::text,
        'sorteo desligado por corrección · ' || p_sorteo_id::text ||
        ' · reconocido con abono ' || round(v_viejo, 2)::text
      );
    else
      /*
       * La casa le había pagado ese sorteo a ÉL (saldo del sorteo negativo o
       * cero). No hay abono negativo que reconozca eso, así que se deja
       * constancia en el corte y en la auditoría, y el cierre de esa parte se
       * hace a mano. Es el caso raro y trazado de la decisión.
       */
      update public.corte_vendedor c
      set saldo   = c.saldo - v_viejo,
          entrega = coalesce(c.entrega, c.saldo),
          ajuste  = coalesce(c.entrega, c.saldo) - (c.saldo - v_viejo),
          motivo_ajuste = btrim(
            coalesce(c.motivo_ajuste || ' · ', '') ||
            'Corrección posterior de un sorteo a favor del vendedor ('
              || v_sorteo.id::text || ') — reconocer a mano'
          )
      where c.id = v_liq.corte_id;

      perform public.fn_auditar(
        'corte_vendedor', v_liq.corte_id, 'ajustar', 'saldo',
        v_viejo::text,
        'sorteo desligado por corrección · ' || p_sorteo_id::text ||
        ' · a favor del vendedor, reconocer a mano'
      );
    end if;
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
  'Rehace la liquidación de un vendedor en un sorteo. Si el sorteo ya se pagó en un corte, lo desliga y reconoce lo ya pagado con un abono (cuando el vendedor debía), de modo que sólo la diferencia queda pendiente; si el sorteo era a favor del vendedor, lo deja trazado para cierre a mano.';

revoke execute on function public.fn_recalcular_liquidacion(uuid, uuid) from public, anon;
