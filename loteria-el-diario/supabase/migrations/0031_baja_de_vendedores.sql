-- ===========================================================================
-- Dar de baja a un vendedor, y que la baja le cierre la sesión.
--
-- `allan.vendedor.activo` existe desde 0001 con un comentario explícito —
-- «Baja lógica. Un vendedor nunca se borra» — y hasta hoy NINGUNA función,
-- acción ni pantalla la ponía en `false`. Era un contrato declarado y sin
-- implementar: seis consultas leen la columna, nadie la escribe.
--
-- DOS ESTADOS, NO UNO
-- -------------------
-- Inactivar es reversible (el vendedor se va unas semanas y vuelve). Eliminar
-- no lo es, pero tampoco borra: marca `eliminado_en` y saca al vendedor del
-- padrón para siempre. En ninguno de los dos casos se toca un ticket, una
-- línea ni una liquidación — el histórico tiene que seguir reconstruyendo el
-- pasado, y ahí es donde el vendedor sigue existiendo.
--
-- POR QUÉ LA SESIÓN NO SE CIERRA SOLA
-- -----------------------------------
-- La sesión es una cookie autofirmada con HMAC y doce horas de vigencia
-- (lib/sesion.ts). No hay almacén de sesiones en el servidor: poner
-- `usuario.activo = false` sólo impide el PRÓXIMO ingreso, y el vendedor
-- recién dado de baja podría seguir vendiendo media jornada. `fn_sesion_vigente`
-- es el gancho que faltaba: la aplicación la consulta al renderizar cada
-- página y antes de cada venta, y con eso la baja surte efecto en la siguiente
-- navegación.
-- ===========================================================================

alter table allan.vendedor add column if not exists eliminado_en timestamptz;

comment on column allan.vendedor.eliminado_en is
  'Baja definitiva. El vendedor sale del padrón pero su historial queda intacto: nunca se hace DELETE.';

create index if not exists vendedor_vigente
  on allan.vendedor (codigo) where eliminado_en is null;

-- --- Bajas y altas ---------------------------------------------------------

create or replace function allan.fn_desactivar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  if v_vendedor.eliminado_en is not null then
    raise exception 'Ese vendedor ya fue eliminado.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not v_vendedor.activo then
    return;   -- idempotente: inactivar dos veces no es un error
  end if;

  update allan.vendedor set activo = false where id = p_vendedor_id;
  update allan.usuario   set activo = false where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'inactivar', 'activo',
                           'true', 'false');
end;
$$;

create or replace function allan.fn_activar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- Eliminar es definitivo. Si hiciera falta recuperarlo, se da de alta uno
  -- nuevo: reactivar un código eliminado confundiría el histórico.
  if v_vendedor.eliminado_en is not null then
    raise exception 'Un vendedor eliminado no se puede reactivar. Cree uno nuevo.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_vendedor.activo then
    return;
  end if;

  update allan.vendedor set activo = true where id = p_vendedor_id;
  update allan.usuario   set activo = true where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'reactivar', 'activo',
                           'false', 'true');
end;
$$;

create or replace function allan.fn_eliminar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  if v_vendedor.eliminado_en is not null then
    return;
  end if;

  update allan.vendedor
  set activo = false, eliminado_en = now()
  where id = p_vendedor_id;

  update allan.usuario set activo = false where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'eliminar', 'eliminado_en',
                           null, now()::text);
end;
$$;

comment on function allan.fn_eliminar_vendedor(uuid, uuid) is
  'Baja definitiva del padrón. No borra ni una fila de historial: tickets, líneas y liquidaciones siguen donde estaban.';

-- --- El gancho que cierra la sesión ----------------------------------------

create or replace function allan.fn_sesion_vigente(p_usuario_id uuid)
returns boolean
language sql
stable
security definer
set search_path = allan, public
as $$
  select exists (
    select 1
    from allan.usuario u
    left join allan.vendedor v on v.id = u.vendedor_id
    where u.id = p_usuario_id
      and u.activo
      and (u.vendedor_id is null or (v.activo and v.eliminado_en is null))
  );
$$;

comment on function allan.fn_sesion_vigente(uuid) is
  'Si la cuenta sigue sirviendo. La cookie de sesión es autofirmada y no se puede revocar: esto es lo que la invalida.';

-- --- Un efecto colateral que ahora estorba ---------------------------------
-- `fn_restablecer_contrasena` ponía `activo = true` de paso. Con las bajas ya
-- implementadas, restablecerle la clave a un vendedor dado de baja lo
-- resucitaría sin que nadie lo pidiera. La reactivación tiene su propia
-- función y su propio botón.

create or replace function allan.fn_restablecer_contrasena(
  p_usuario_id uuid,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = true
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'restablecer_contrasena', 'hash',
                           null, null);
end;
$$;

revoke execute on function allan.fn_desactivar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_activar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_eliminar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_sesion_vigente(uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text)
  from public, anon, authenticated;
