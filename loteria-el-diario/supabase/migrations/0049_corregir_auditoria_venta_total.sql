-- ===========================================================================
-- Arreglo: `fn_auditar` toma seis argumentos, no siete.
--
-- La 0047 llamaba a `allan.fn_auditar(...)` pasándole el usuario como séptimo
-- parámetro. Esa firma no existe —la de la 0002 termina en `p_valor_nuevo`— y
-- Postgres no lo detecta al crear la función: falla en tiempo de EJECUCIÓN,
-- así que `fn_registrar_venta_total` se creaba sin quejarse y reventaba al
-- primer registro con «function allan.fn_auditar(...) does not exist».
--
-- Quien registra queda guardado igualmente: va en `venta_total.creado_por`,
-- que es donde tiene que estar. La auditoría anota la acción, no el actor,
-- porque bajo `service_role` `auth.uid()` es nulo y el actor real lo pone la
-- capa de aplicación en la propia fila.
-- ===========================================================================

create or replace function allan.fn_registrar_venta_total(
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
as $$
declare
  v_comision numeric(6,5);
  v_id       uuid;
  v_estado   allan.estado_sorteo;
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.';
  end if;

  select estado into v_estado from allan.sorteo where id = p_sorteo_id;
  if v_estado is null then
    raise exception 'El sorteo no existe.';
  end if;

  -- El vendedor tiene que estar vivo: un dado de baja no genera venta nueva.
  perform 1 from allan.vendedor
   where id = p_vendedor_id and activo and eliminado_en is null;
  if not found then
    raise exception 'El vendedor no está activo.';
  end if;

  select p.comision into v_comision
  from allan.parametro_vendedor p
  where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null
  order by p.vigente_desde desc
  limit 1;

  if v_comision is null then
    raise exception 'El vendedor no tiene comisión vigente configurada.';
  end if;

  insert into allan.venta_total (
    sorteo_id, vendedor_id, venta, premios, comision_congelada, nota, creado_por
  ) values (
    p_sorteo_id, p_vendedor_id, p_venta, p_premios, v_comision, nullif(btrim(p_nota), ''), p_usuario_id
  )
  returning id into v_id;

  perform allan.fn_auditar(
    'venta_total', v_id, 'registrar', 'venta', null, p_venta::text
  );

  -- Si el sorteo ya estaba liquidado hay que rehacer su fila, o la captura no
  -- aparecería hasta que alguien reliquidara.
  if v_estado = 'liquidado' then
    perform allan.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
  end if;

  return query
  select v_id,
         round(p_venta * v_comision, 2),
         round(p_venta - p_venta * v_comision - p_premios, 2);
end;
$$;

revoke execute on function allan.fn_registrar_venta_total(uuid, uuid, numeric, numeric, text, uuid)
  from public, anon;


create or replace function allan.fn_anular_venta_total(
  p_id         uuid,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo uuid;
  v_vend   uuid;
  v_estado allan.estado_sorteo;
begin
  select vt.sorteo_id, vt.vendedor_id into v_sorteo, v_vend
  from allan.venta_total vt
  where vt.id = p_id and vt.anulado_en is null;

  if v_sorteo is null then
    raise exception 'Esa captura no existe o ya estaba anulada.';
  end if;

  update allan.venta_total set anulado_en = now() where id = p_id;

  perform allan.fn_auditar('venta_total', p_id, 'anular', null, null, p_usuario_id::text);

  select estado into v_estado from allan.sorteo where id = v_sorteo;
  if v_estado = 'liquidado' then
    perform allan.fn_recalcular_liquidacion(v_sorteo, v_vend);
  end if;
end;
$$;

revoke execute on function allan.fn_anular_venta_total(uuid, uuid) from public, anon;
