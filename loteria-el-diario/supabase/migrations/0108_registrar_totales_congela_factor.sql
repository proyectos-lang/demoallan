-- ===========================================================================
-- Al capturar por totales se congela el factor de pago.
--
-- Mismo cambio que ya tenía la comisión: la captura guarda el factor vigente en
-- ese momento, para que el premiado se deduzca siempre con el factor real de la
-- captura y no con el que el vendedor tenga después. Ver la 0107 para el porqué.
--
-- La firma no cambia: `create or replace` basta.
-- ===========================================================================

create or replace function public.fn_registrar_venta_total(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_venta       numeric,
  p_premios     numeric,
  p_nota        text default null,
  p_usuario_id  uuid default null
) returns table (r_id uuid, r_comision numeric, r_saldo numeric)
language plpgsql
security definer
set search_path = allan, public
as $venta_total$
declare
  v_comision numeric(6,5);
  v_factor   numeric(6,2);
  v_id       uuid;
  v_estado   public.estado_sorteo;
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.';
  end if;

  select estado into v_estado from public.sorteo where id = p_sorteo_id;
  if v_estado is null then
    raise exception 'El sorteo no existe.';
  end if;

  -- El vendedor tiene que estar vivo: un dado de baja no genera venta nueva.
  perform 1 from public.vendedor
   where id = p_vendedor_id and activo and eliminado_en is null;
  if not found then
    raise exception 'El vendedor no está activo.';
  end if;

  -- La comisión Y el factor vigentes, congelados en la captura.
  select p.comision, p.factor_pago into v_comision, v_factor
  from public.parametro_vendedor p
  where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null
  order by p.vigente_desde desc
  limit 1;

  if v_comision is null then
    raise exception 'El vendedor no tiene comisión vigente configurada.';
  end if;

  insert into public.venta_total (
    sorteo_id, vendedor_id, venta, premios, comision_congelada, factor_congelado,
    nota, creado_por
  ) values (
    p_sorteo_id, p_vendedor_id, p_venta, p_premios, v_comision, v_factor,
    nullif(btrim(p_nota), ''), p_usuario_id
  )
  returning id into v_id;

  perform public.fn_auditar(
    'venta_total', v_id, 'registrar', 'venta', null, p_venta::text, p_usuario_id
  );

  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
  end if;

  return query
  select v_id,
         round(p_venta * v_comision, 2),
         round(p_venta - p_venta * v_comision - p_premios, 2);
end;
$venta_total$;

revoke execute on function public.fn_registrar_venta_total(uuid, uuid, numeric, numeric, text, uuid)
  from public, anon;
