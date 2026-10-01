-- ===========================================================================
-- El abono puede cubrir también el ajuste por corrección.
--
-- EL FALLO QUE CORRIGE
-- --------------------
-- Desde la 0116, lo que un vendedor debe —y lo que la pantalla enseña— es
--
--     deuda (sorteos sin cerrar) − abonado + ajuste por corrección
--
-- pero `fn_registrar_abono` (0079) seguía topando el abono contra sólo
--
--     deuda − abonado
--
-- es decir, SIN el ajuste. En cuanto un vendedor tiene un ajuste vivo —porque
-- se corrigió un sorteo que ya estaba pagado (modelo 0114–0118)— los dos
-- números dejan de coincidir, y pasa esto:
--
--   · La hoja dice que debe 1.800 (900 de un sorteo abierto + 900 de ajuste).
--   · El cobrador teclea un abono parcial de 1.200.
--   · La base lo RECHAZA: «El abono (1200.00) pasa de lo que debe (900.00)».
--
-- El caso más desconcertante es el vendedor cuyos sorteos están todos pagados y
-- sólo arrastra un ajuste: la pantalla dice que debe 900, y CUALQUIER abono se
-- rechaza con «pasa de lo que debe (0.00)». Es lo que el usuario final reportó
-- como «el abono parcial no está haciendo nada».
--
-- EL ARREGLO
-- ----------
-- El tope pasa a ser el mismo pendiente que calcula `fn_deuda_vendedor`:
-- deuda − abonado + ajuste. Se reusa `fn_ajuste_pendiente` para que no haya dos
-- fórmulas del pendiente que puedan volver a separarse. El ajuste va con su
-- signo: uno a favor del vendedor (negativo) baja el tope, igual que baja el
-- pendiente en la hoja.
--
-- Lo demás de la función no cambia: el bloqueo de los abonos vivos, el rechazo
-- de monto ≤ 0 y de fecha futura, y que devuelva el pendiente ya recalculado.
-- Firma idéntica: `create or replace`.
-- ===========================================================================

create or replace function public.fn_registrar_abono(
  p_vendedor_id uuid,
  p_monto       numeric,
  p_fecha_pago  date default null,
  p_nota        text default null,
  p_usuario_id  uuid default null
)
returns table (
  r_abono_id  uuid,
  r_monto     numeric,
  r_pendiente numeric   -- lo que le queda debiendo DESPUÉS de este abono
)
language plpgsql
security definer
set search_path = public
as $abono$
declare
  v_id      uuid := gen_random_uuid();
  v_fecha   date := coalesce(p_fecha_pago, (now() at time zone 'America/Tegucigalpa')::date);
  v_deuda   numeric(14,2);
  v_abonado numeric(14,2);
  v_ajuste  numeric(14,2);
  v_debe    numeric(14,2);   -- lo que debe de verdad: deuda − abonado + ajuste
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El abono tiene que ser mayor que cero.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago que todavía no ocurrió no se registra: casi siempre es un dedazo
  -- en el año, y una fecha futura descuadra cualquier corte por período.
  if v_fecha > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha de pago no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor where id = p_vendedor_id;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  /*
   * Lo que debe AHORA MISMO, recalculado aquí.
   *
   * Se bloquean los abonos vivos del vendedor para que dos personas cobrando a
   * la vez no lean el mismo pendiente y acepten cada una un abono que junto
   * con el otro se pasa de la deuda.
   */
  perform 1 from public.abono_vendedor
  where vendedor_id = p_vendedor_id and corte_id is null
  for update;

  select coalesce(sum(lq.venta - lq.comision - lq.premios), 0)
  into v_deuda
  from public.liquidacion lq
  where lq.vendedor_id = p_vendedor_id
    and not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    );

  select coalesce(sum(a.monto), 0)
  into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  -- El ajuste por corrección de sorteos ya pagados (0114), con su signo. Es
  -- tan pendiente como un sorteo sin cerrar, y la hoja ya lo cuenta: el abono
  -- tiene que poder cubrirlo, o un vendedor cuya deuda es sólo un ajuste nunca
  -- podría abonar nada.
  v_ajuste := public.fn_ajuste_pendiente(p_vendedor_id);

  v_debe := v_deuda - v_abonado + v_ajuste;

  /*
   * No se acepta más de lo que debe.
   *
   * Un abono mayor que la deuda deja al vendedor con saldo a favor, y este
   * módulo no sabe qué hacer con eso: lo arrastraría como un pendiente
   * negativo que nadie sabría leer. Si de verdad entregó de más, es un corte
   * con su ajuste y su motivo, que sí deja constancia de por qué.
   *
   * El tope es el pendiente COMPLETO —deuda − abonado + ajuste—, el mismo que
   * enseña `fn_deuda_vendedor`. Antes topaba sólo contra deuda − abonado, y un
   * ajuste vivo hacía rechazar abonos parciales legítimos.
   */
  if round(p_monto, 2) > v_debe then
    raise exception 'El abono (%) pasa de lo que debe (%). Registre un corte si quiere cerrar con ajuste.',
      round(p_monto, 2), greatest(v_debe, 0)
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.abono_vendedor (
    id, vendedor_id, monto, fecha_pago, nota, usuario_id
  ) values (
    v_id, p_vendedor_id, round(p_monto, 2), v_fecha,
    nullif(btrim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  perform public.fn_auditar('abono_vendedor', v_id, 'crear', 'monto',
                            null, round(p_monto, 2)::text);

  return query
  select v_id,
         round(p_monto, 2),
         round(v_debe - p_monto, 2);
end;
$abono$;

comment on function public.fn_registrar_abono(uuid, numeric, date, text, uuid) is
  'Registra dinero entregado a cuenta. No cierra sorteos: descuenta del pendiente (deuda − abonado + ajuste) y el resto sigue debiéndose.';

revoke execute on function public.fn_registrar_abono(uuid, numeric, date, text, uuid)
  from public, anon;
