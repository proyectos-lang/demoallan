-- ===========================================================================
-- Anular un ticket estaba roto desde la 0024. Nadie lo había intentado.
--
-- SÍNTOMA
-- -------
--   new row for relation "ticket" violates check constraint
--   "ticket_anulacion_completa"
--
-- CAUSA
-- -----
-- `fn_anular_ticket` escribe `anulado_por = auth.uid()`. Desde la 0024 los
-- usuarios viven en `public.usuario` y la aplicación habla con la base como
-- `service_role`, así que `auth.uid()` devuelve NULL SIEMPRE.
--
-- La restricción del esquema (0001) exige que la anulación sea completa:
--
--     (anulado_en is null     and anulado_por is null)
--     or (anulado_en is not null and anulado_por is not null)
--
-- Con `anulado_en = now()` y `anulado_por = null`, ninguna de las dos ramas se
-- cumple y la base rechaza el UPDATE. Es decir: la anulación fallaba
-- ENTERA, desde la pantalla y desde cualquier otra vía.
--
-- La restricción no está de más — un ticket anulado sin responsable es
-- exactamente lo que la bitácora existe para evitar. Lo que faltaba es de
-- dónde sacar ese responsable.
--
-- ARREGLO
-- -------
-- El mismo patrón que ya usa `fn_registrar_ticket` desde la 0033: el usuario
-- llega por parámetro, que es la única fuente fiable cuando no hay JWT. La
-- Server Action lo toma de la sesión firmada; el navegador nunca lo decide.
--
-- `coalesce(p_usuario_id, auth.uid())` y no sólo el parámetro: si algún día se
-- vuelve a un modelo con JWT, sigue funcionando sin tocar nada.
--
-- SE AÑADE `p_forzar` para poder anular sobre un sorteo ya cerrado. Un
-- duplicado detectado en una auditoría —que es cuando se detectan— aparece
-- casi siempre con el sorteo ya cerrado, y hasta ahora no había forma de
-- corregirlo. Sigue prohibido sobre un sorteo LIQUIDADO: ahí el ticket ya
-- entró en la liquidación del vendedor, y quitarlo por detrás descuadraría lo
-- que se le pagó.
-- ===========================================================================

create or replace function public.fn_anular_ticket(
  p_ticket_id  uuid,
  p_motivo     text,
  p_usuario_id uuid default null,
  p_forzar     boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.ticket%rowtype;
  v_estado public.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from public.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  -- Un vendedor sólo puede anular lo suyo; administración, cualquiera.
  if not public.fn_es_servicio()
     and public.fn_rol_actual() is distinct from 'administrador'
     and v_ticket.vendedor_id is distinct from public.fn_vendedor_actual() then
    raise exception 'No tiene permiso para anular este ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_ticket.sorteo_id
  for share;

  -- Sobre un sorteo liquidado no se anula NUNCA, ni forzando: el ticket ya
  -- entró en la liquidación del vendedor y quitarlo por detrás dejaría el
  -- corte sin cuadrar con lo que se le pagó.
  if v_estado = 'liquidado' then
    raise exception 'El sorteo ya está liquidado; anular este ticket descuadraría la liquidación.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_estado <> 'abierto' and not p_forzar then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- Devolver el cupo, número por número en orden ascendente.
  for v_linea in
    select numero, sum(monto) as monto
    from public.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update public.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update public.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update public.ticket
  set anulado_en = now(),
      -- El parámetro primero: `auth.uid()` es NULL bajo service_role, y con él
      -- la restricción `ticket_anulacion_completa` rechaza el UPDATE entero.
      anulado_por = coalesce(p_usuario_id, auth.uid()),
      motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform public.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo);
end;
$$;

comment on function public.fn_anular_ticket(uuid, text, uuid, boolean) is
  'Anula un ticket y devuelve su cupo. El usuario llega por parámetro: auth.uid() es NULL bajo service_role y la restricción de anulación completa rechazaba el UPDATE.';

revoke execute on function public.fn_anular_ticket(uuid, text, uuid, boolean)
  from public, anon;
