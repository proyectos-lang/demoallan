-- ===========================================================================
-- Usuarios en tabla propia, fuera de Supabase Auth.
--
-- QUÉ CAMBIA, DICHO SIN ADORNOS
-- -----------------------------
-- Hasta ahora la seguridad vivía en la BASE: cada consulta llevaba el JWT que
-- emite Supabase Auth, y RLS recortaba las filas leyendo el rol de ese JWT. Un
-- vendedor no veía los tickets de otro porque la base no se los daba, hiciera
-- lo que hiciera la aplicación.
--
-- Sin `auth` no hay JWT, y sin JWT `fn_rol_actual()` no tiene de dónde leer. La
-- aplicación pasa a hablar con la base como servicio, y el recorte por rol
-- pasa a ser responsabilidad SUYA. Es una frontera más frágil: un olvido en
-- una consulta ya no lo ataja la base.
--
-- Lo que sostiene el cambio es que el navegador nunca habla con PostgREST —
-- todo va por componentes de servidor y acciones de servidor—, así que la
-- llave de servicio no sale del servidor y la aplicación es de hecho el único
-- cliente. Las políticas de RLS se dejan puestas: no estorban, y si algún día
-- se vuelve a un modelo con JWT siguen ahí.
--
-- LO QUE NO SE TOCA
-- -----------------
-- La validación de cupo con la fila bloqueada dentro de la transacción, el
-- congelamiento de parámetros por línea y la liquidación como estado terminal
-- no dependían nunca del JWT. Siguen intactos, que es lo que de verdad protege
-- el dinero.
-- ===========================================================================

create extension if not exists pgcrypto;

create table if not exists allan.usuario (
  id             uuid primary key default gen_random_uuid(),
  usuario        text not null unique,          -- lo que se teclea al entrar
  nombre         text not null,
  rol            allan.rol_usuario not null,
  vendedor_id    uuid references allan.vendedor(id),
  -- bcrypt de pgcrypto. Nunca la contraseña en claro, ni siquiera aquí: quien
  -- lea la tabla no debe poder entrar con lo que ve.
  hash           text not null,
  activo         boolean not null default true,
  debe_cambiar   boolean not null default true, -- la primera es de un solo uso
  ultimo_acceso  timestamptz,
  creado_en      timestamptz not null default now(),
  creado_por     uuid,

  constraint usuario_formato check (usuario ~ '^[a-z0-9._@-]{3,60}$'),
  constraint usuario_vendedor_enlazado check (
    (rol <> 'vendedor') or (vendedor_id is not null)
  )
);

comment on table allan.usuario is
  'Cuentas de acceso. Sustituye a auth.users. La contraseña se guarda como bcrypt (pgcrypto), nunca en claro.';

-- Un vendedor, una cuenta. Dos personas vendiendo bajo el mismo código serían
-- indistinguibles en la bitácora, que es justo lo que la bitácora evita.
create unique index if not exists usuario_vendedor_unico
  on allan.usuario (vendedor_id) where vendedor_id is not null;

alter table allan.usuario enable row level security;
-- Sin políticas: la tabla no se lee nunca desde un cliente. Todo pasa por las
-- funciones de abajo, que jamás devuelven el hash.

-- --- Alta -------------------------------------------------------------------

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
set search_path = allan, public
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

  -- La contraseña NO entra en la bitácora, evidentemente.
  perform allan.fn_auditar('usuario', v_id, 'crear', 'rol', null, p_rol::text);

  return v_id;
end;
$$;

-- --- Autenticación ----------------------------------------------------------
-- Devuelve el perfil o nada. No distingue entre usuario inexistente y
-- contraseña incorrecta: decirlo permitiría averiguar qué cuentas existen.
--
-- `crypt(p_contrasena, u.hash)` vuelve a cifrar con la MISMA sal que lleva el
-- hash guardado; si coincide, la contraseña es la buena. La comparación la hace
-- bcrypt, no una igualdad de textos.

create or replace function allan.fn_autenticar(p_usuario text, p_contrasena text)
returns table (
  r_id          uuid,
  r_nombre      text,
  r_rol         allan.rol_usuario,
  r_vendedor_id uuid,
  r_debe_cambiar boolean
)
language plpgsql
security definer
set search_path = allan, public
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

-- --- Cambio de contraseña ---------------------------------------------------

create or replace function allan.fn_cambiar_contrasena(
  p_usuario_id  uuid,
  p_actual      text,
  p_nueva       text
)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña nueva debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se exige la actual aunque quien llame ya tenga sesión: así una sesión
  -- robada no basta para quedarse con la cuenta.
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

/** Restablecimiento por administración: no exige la actual, la deja de un solo uso. */
create or replace function allan.fn_restablecer_contrasena(
  p_usuario_id uuid,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public
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

-- --- Consulta ---------------------------------------------------------------

create or replace function allan.fn_usuario(p_id uuid)
returns table (
  r_id          uuid,
  r_usuario     text,
  r_nombre      text,
  r_rol         allan.rol_usuario,
  r_vendedor_id uuid,
  r_activo      boolean,
  r_debe_cambiar boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select u.id, u.usuario, u.nombre, u.rol, u.vendedor_id, u.activo, u.debe_cambiar
  from allan.usuario u where u.id = p_id;
$$;

/** Qué vendedores ya tienen acceso, para no ofrecer el alta dos veces. */
create or replace function allan.fn_accesos_vendedor()
returns table (r_vendedor_id uuid, r_usuario text, r_activo boolean)
language sql
stable
security definer
set search_path = allan, public
as $$
  select u.vendedor_id, u.usuario, u.activo
  from allan.usuario u
  where u.vendedor_id is not null;
$$;

-- --- El día del vendedor ----------------------------------------------------
-- El filtro por vendedor va EXPLÍCITO. Antes lo ponía RLS leyendo el JWT; sin
-- JWT hay que decirlo, y decirlo aquí —una sola vez, en la base— es mejor que
-- repetirlo en cada pantalla.

create or replace function allan.fn_mi_dia(p_vendedor_id uuid, p_fecha date)
returns table (
  r_sorteo_id uuid,
  r_hora      allan.hora_sorteo,
  r_estado    allan.estado_sorteo,
  r_ganador   smallint,
  r_tickets   integer,
  r_venta     numeric,
  r_comision  numeric,
  r_premios   numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.id, s.hora, s.estado, s.numero_ganador,
         count(distinct t.id)::integer,
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
  from allan.sorteo s
  left join allan.ticket t
    on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

create or replace function allan.fn_mis_tickets(
  p_vendedor_id uuid,
  p_fecha       date,
  p_limite      integer default 40
)
returns table (
  r_folio     text,
  r_hora      allan.hora_sorteo,
  r_creado_en timestamptz,
  r_total     numeric,
  r_lineas    integer,
  r_premio    numeric,
  r_anulado   boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select t.folio, s.hora, t.creado_en, t.total,
         count(l.id)::integer,
         coalesce(sum(l.premio), 0),
         t.anulado_en is not null
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.vendedor_id = p_vendedor_id
  group by t.folio, s.hora, t.creado_en, t.total, t.anulado_en
  order by t.creado_en desc
  limit p_limite;
$$;

-- Ninguna de estas es invocable desde un cliente: todas se llaman desde el
-- servidor de la aplicación con la llave de servicio.
revoke execute on function allan.fn_crear_usuario(text, text, text, allan.rol_usuario, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_autenticar(text, text) from public, anon, authenticated;
revoke execute on function allan.fn_cambiar_contrasena(uuid, text, text) from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text) from public, anon, authenticated;
revoke execute on function allan.fn_usuario(uuid) from public, anon, authenticated;
revoke execute on function allan.fn_accesos_vendedor() from public, anon, authenticated;
revoke execute on function allan.fn_mi_dia(uuid, date) from public, anon, authenticated;
revoke execute on function allan.fn_mis_tickets(uuid, date, integer) from public, anon, authenticated;
