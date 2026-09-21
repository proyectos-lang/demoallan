-- ===========================================================================
-- Al liquidar, el ajuste por corrección se salda con el corte.
--
-- El ajuste (0114) es un saldo pendiente signado que suma a lo que el vendedor
-- debe. Al registrar un corte hay que marcarlo con ese corte —igual que los
-- abonos— o seguiría sumando por su cuenta y se contaría dos veces. Se cierran
-- TODOS los ajustes vivos del vendedor: el corte salda la cuenta de la semana,
-- y el ajuste es parte de esa cuenta.
--
-- Se reproduce entera —una función es indivisible— con el bloque nuevo tras el
-- de los abonos. La firma no cambia: `create or replace`.
-- ===========================================================================

create or replace function public.fn_registrar_corte(
  p_vendedor_id     uuid,
  p_liquidacion_ids uuid[],
  p_desde           date,
  p_hasta           date,
  p_nota            text default null,
  p_usuario_id      uuid default null
) returns table (
  r_corte_id uuid,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_saldo    numeric,
  r_abonado  numeric,   -- lo que ya había entregado a cuenta
  r_resta    numeric    -- lo que le queda por entregar al cerrar: saldo − abonado
)
language plpgsql
security definer
set search_path = public
as $corte$
declare
  v_corte_id uuid := gen_random_uuid();
  v_ajenas   integer;
  v_sorteos  integer;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
  v_abonado  numeric(14,2);
begin
  -- Inerte bajo `service_role` (0024): la guarda real vive en la Server
  -- Action. Se conserva por coherencia con el resto de funciones.
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if p_liquidacion_ids is null or array_length(p_liquidacion_ids, 1) is null then
    raise exception 'No se eligió ningún sorteo para pagar.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se bloquean antes de sumarlas: si otra transacción está registrando un
  -- corte con alguna de ellas, ésta espera y luego choca contra el índice
  -- único, en vez de sumar sobre un dato que ya cambió debajo.
  perform 1
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
  order by lq.id
  for update;

  -- Ninguna liquidación ajena se cuela en el corte de otro vendedor.
  select count(*) into v_ajenas
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
    and lq.vendedor_id is distinct from p_vendedor_id;

  if v_ajenas > 0 then
    raise exception 'El corte incluye % liquidaciones de otro vendedor.', v_ajenas
      using errcode = 'invalid_parameter_value';
  end if;

  -- Los totales SIEMPRE se recalculan aquí. Lo que manda el navegador es una
  -- vista previa, no un dato: si llegara alterado, el corte guardaría una
  -- cifra que no corresponde a ningún sorteo.
  select count(*),
         coalesce(sum(lq.venta), 0),
         coalesce(sum(lq.comision), 0),
         coalesce(sum(lq.premios), 0)
    into v_sorteos, v_venta, v_comision, v_premios
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids);

  if v_sorteos <> array_length(p_liquidacion_ids, 1) then
    raise exception 'Alguna de las liquidaciones elegidas ya no existe.'
      using errcode = 'no_data_found';
  end if;

  insert into public.corte_vendedor (
    id, vendedor_id, desde, hasta, sorteos, venta, comision, premios, saldo,
    nota, usuario_id
  ) values (
    v_corte_id, p_vendedor_id, p_desde, p_hasta, v_sorteos,
    v_venta, v_comision, v_premios, v_venta - v_comision - v_premios,
    nullif(trim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  begin
    insert into public.corte_detalle (corte_id, liquidacion_id)
    select v_corte_id, unnest(p_liquidacion_ids);
  exception when unique_violation then
    raise exception 'Uno de los sorteos elegidos ya se había pagado. Vuelva a cargar el informe.'
      using errcode = 'check_violation';
  end;

  /*
   * LOS ABONOS VIVOS SE ABSORBEN EN ESTE CORTE.
   *
   * El vendedor ya entregó parte de esta deuda a cuenta. Ese dinero está
   * dentro del saldo que el corte da por cobrado, así que si los abonos
   * siguieran vivos se contarían dos veces: una en el corte y otra
   * descontando del pendiente.
   *
   * Se marcan con el corte y dejan de sumar por su cuenta. El apunte no se
   * borra —la fecha en que entregó cada parte es historia de caja— pero pasa
   * a estar contado aquí dentro.
   */
  select coalesce(sum(a.monto), 0) into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  update public.abono_vendedor
  set corte_id = v_corte_id
  where vendedor_id = p_vendedor_id and corte_id is null;

  /*
   * Y LOS AJUSTES VIVOS TAMBIÉN se absorben en este corte, con el mismo
   * motivo: son parte de la cuenta que se está cerrando. Con signo, así que
   * un ajuste a favor del vendedor baja lo que entrega y uno en contra lo
   * sube. Una vez marcados dejan de sumar en el pendiente.
   */
  update public.ajuste_liquidacion
  set saldado_corte_id = v_corte_id
  where vendedor_id = p_vendedor_id and saldado_corte_id is null;

  perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'saldo',
                           null, (v_venta - v_comision - v_premios)::text, p_usuario_id);

  if v_abonado > 0 then
    perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'abonado',
                             null, v_abonado::text, p_usuario_id);
  end if;

  return query
    select v_corte_id, v_sorteos, v_venta, v_comision, v_premios,
           v_venta - v_comision - v_premios,
           v_abonado,
           v_venta - v_comision - v_premios - v_abonado;
end;
$corte$;

revoke execute on function public.fn_registrar_corte(uuid, uuid[], date, date, text, uuid)
  from public, anon;
