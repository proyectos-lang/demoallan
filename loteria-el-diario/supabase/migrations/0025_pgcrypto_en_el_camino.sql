-- ===========================================================================
-- «function gen_salt(unknown, integer) does not exist»
--
-- pgcrypto está instalado, pero en el esquema `extensions` — que es donde
-- Supabase pone las extensiones, no en `public`. Por eso el
-- `create extension if not exists pgcrypto` de la 0024 no hizo nada: la
-- encontró y siguió.
--
-- Las funciones declaran `set search_path = allan, public`, así que `crypt` y
-- `gen_salt` quedaban fuera de su alcance. Fijar el search_path no es opcional
-- en una función `security definer` —sin él, quien la llama podría anteponer un
-- esquema con funciones suyas y ejecutarlas con los privilegios del dueño—, así
-- que la salida no es quitarlo sino añadir `extensions`.
-- ===========================================================================

create or replace function allan.fn_crear_usuario(
  p_usuario     text,
  p_contrasena  text,
  p_nombre      text,
  p_rol         allan.rol_usuario,
  p_vendedor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
declare
  v_id uuid;
begin
  if length(coalesce(p_contrasena, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_rol = 'vendedor' and p_vendedor_id is null then
    raise exception 'Una cuenta de vendedor tiene que ir enlazada a un vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.usuario (usuario, nombre, rol, vendedor_id, hash)
  values (lower(trim(p_usuario)), p_nombre, p_rol, p_vendedor_id,
          crypt(p_contrasena, gen_salt('bf', 10)))
  returning id into v_id;

  perform allan.fn_auditar('usuario', v_id, 'crear', 'rol', null, p_rol::text);

  return v_id;
end;
$$;

create or replace function allan.fn_autenticar(p_usuario text, p_contrasena text)
returns table (
  r_id           uuid,
  r_nombre       text,
  r_rol          allan.rol_usuario,
  r_vendedor_id  uuid,
  r_debe_cambiar boolean
)
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
declare
  v_id uuid;
begin
  select u.id into v_id
  from allan.usuario u
  where u.usuario = lower(trim(p_usuario))
    and u.activo
    and u.hash = crypt(p_contrasena, u.hash);

  if v_id is null then
    return;   -- sin filas: credenciales incorrectas
  end if;

  update allan.usuario set ultimo_acceso = now() where id = v_id;

  return query
    select u.id, u.nombre, u.rol, u.vendedor_id, u.debe_cambiar
    from allan.usuario u where u.id = v_id;
end;
$$;

create or replace function allan.fn_cambiar_contrasena(
  p_usuario_id uuid,
  p_actual     text,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña nueva debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from allan.usuario u
                 where u.id = p_usuario_id and u.hash = crypt(p_actual, u.hash)) then
    raise exception 'La contraseña actual no es correcta.'
      using errcode = 'invalid_password';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = false
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'cambiar_contrasena', 'hash',
                           null, null);
end;
$$;

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
      debe_cambiar = true,
      activo = true
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'restablecer_contrasena', 'hash',
                           null, null);
end;
$$;

revoke execute on function allan.fn_crear_usuario(text, text, text, allan.rol_usuario, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_autenticar(text, text) from public, anon, authenticated;
revoke execute on function allan.fn_cambiar_contrasena(uuid, text, text) from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text) from public, anon, authenticated;
