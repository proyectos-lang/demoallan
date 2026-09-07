-- ===========================================================================
-- Editar los datos de un vendedor ya creado.
--
-- QUÉ HUECO LLENA
-- ---------------
-- La tabla de vendedores deja cambiar la comisión, el factor y el tope, y nada
-- más. Todo lo demás —nombre, teléfono, identidad, correo, ciudad, barrio y
-- ahora el alias— se fijaba al dar de alta y no había forma de corregirlo: un
-- nombre mal escrito o un teléfono que cambia obligaban a crear otro vendedor,
-- partiendo su historial en dos.
--
-- QUÉ NO SE PUEDE CAMBIAR, Y POR QUÉ
-- ----------------------------------
--   · EL CÓDIGO. Está en cada folio ya impreso —`V002-20260906-0001`— y en la
--     cuenta de usuario del vendedor. Cambiarlo dejaría los tickets viejos
--     apuntando a un código que ya no existe.
--
--   · LA COMISIÓN, EL FACTOR Y EL TOPE. Se versionan: cada cambio cierra la
--     vigencia anterior en vez de sobrescribirla, para que las ventas ya
--     registradas conserven lo que se les prometió. Siguen en su sitio, con
--     `fn_guardar_parametros`; mezclarlos aquí, donde todo se sobrescribe,
--     invitaría a reescribir el pasado sin querer.
--
-- LA ZONA SE RECALCULA
-- --------------------
-- `zona` es «Ciudad · Barrio» y se arma al crear. Si se edita la ciudad o el
-- barrio y no se rehace, el mapa y los informes seguirían agrupando por la
-- combinación vieja: el vendedor diría una ciudad en su ficha y otra en el
-- filtro, sin que nada avise.
-- ===========================================================================

create or replace function public.fn_editar_vendedor(
  p_vendedor_id uuid,
  p_nombre      text,
  p_alias       text default null,
  p_telefono    text default null,
  p_correo      text default null,
  p_identidad   text default null,
  p_ciudad      text default null,
  p_barrio      text default null,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actual    public.vendedor%rowtype;
  v_alias     text := nullif(btrim(coalesce(p_alias, '')), '');
  v_telefono  text := nullif(btrim(coalesce(p_telefono, '')), '');
  v_correo    text := nullif(btrim(coalesce(p_correo, '')), '');
  v_identidad text := nullif(btrim(coalesce(p_identidad, '')), '');
  v_ciudad    text := nullif(btrim(coalesce(p_ciudad, '')), '');
  v_barrio    text := nullif(btrim(coalesce(p_barrio, '')), '');
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  select * into v_actual
  from public.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  if v_actual.eliminado_en is not null then
    raise exception 'Ese vendedor está eliminado; sus datos no se editan.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Las mismas reglas del alta. Se repiten aquí a propósito: una edición que
  -- validara menos que un alta sería la puerta por donde entran los datos que
  -- el alta rechaza.
  if length(btrim(coalesce(p_nombre, ''))) < 5 then
    raise exception 'Escriba el nombre completo del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_ciudad is null or length(v_ciudad) < 3 then
    raise exception 'Escriba la ciudad del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_alias is not null and length(v_alias) > 30 then
    raise exception 'El alias no puede pasar de 30 caracteres; no cabe en el ticket.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_telefono is not null and v_telefono !~ '^\d{4}-\d{4}$' then
    raise exception 'Teléfono en formato 9999-9999, o déjelo en blanco.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_correo is not null and v_correo !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
    raise exception 'Correo electrónico no válido, o déjelo en blanco.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se adopta la escritura de una ciudad ya registrada si sólo difiere en
  -- mayúsculas. Ver la 0062: sin esto «choloma» y «Choloma» son dos ciudades
  -- para cualquier informe que agrupe.
  select v.ciudad into v_ciudad
  from public.vendedor v
  where lower(v.ciudad) = lower(v_ciudad)
    and v.id <> p_vendedor_id
  limit 1;

  if v_ciudad is null then
    v_ciudad := btrim(p_ciudad);
  end if;

  update public.vendedor
  set nombre    = btrim(p_nombre),
      alias     = v_alias,
      telefono  = v_telefono,
      correo    = v_correo,
      identidad = v_identidad,
      ciudad    = v_ciudad,
      barrio    = v_barrio,
      -- La zona se rehace: si no, el mapa y los informes seguirían agrupando
      -- por la ciudad vieja mientras la ficha muestra la nueva.
      zona      = v_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado')
  where id = p_vendedor_id;

  -- Se audita CAMPO A CAMPO y sólo lo que cambió: una entrada por edición
  -- diría «se editó» sin decir qué, que es justo lo que no sirve cuando hay
  -- que reconstruir por qué un ticket dice lo que dice.
  if btrim(p_nombre) is distinct from v_actual.nombre then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'nombre',
                             v_actual.nombre, btrim(p_nombre));
  end if;

  if v_alias is distinct from v_actual.alias then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'alias',
                             coalesce(v_actual.alias, '—'), coalesce(v_alias, '—'));
  end if;

  if v_telefono is distinct from v_actual.telefono then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'telefono',
                             coalesce(v_actual.telefono, '—'), coalesce(v_telefono, '—'));
  end if;

  if v_correo is distinct from v_actual.correo then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'correo',
                             coalesce(v_actual.correo, '—'), coalesce(v_correo, '—'));
  end if;

  if v_identidad is distinct from v_actual.identidad then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'identidad',
                             coalesce(v_actual.identidad, '—'), coalesce(v_identidad, '—'));
  end if;

  if v_ciudad is distinct from v_actual.ciudad
     or v_barrio is distinct from v_actual.barrio then
    perform public.fn_auditar('vendedor', p_vendedor_id, 'editar', 'zona',
                             v_actual.zona,
                             v_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado'));
  end if;
end;
$$;

comment on function public.fn_editar_vendedor(uuid, text, text, text, text, text, text, text, uuid) is
  'Edita los datos de un vendedor. No toca el código ni los parámetros, que se versionan aparte. Audita campo a campo.';

revoke execute on function public.fn_editar_vendedor(uuid, text, text, text, text, text, text, text, uuid)
  from public, anon;
