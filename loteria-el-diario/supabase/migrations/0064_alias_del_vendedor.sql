-- ===========================================================================
-- El vendedor gana un alias, que es lo que ve el cliente en el papel.
--
-- PARA QUÉ
-- --------
-- El nombre registrado es el de la persona o la razón social —«ANA CAROLINA
-- RECINOS SOLIS»— y no siempre es como se conoce el puesto en la calle. El
-- alias deja poner «PULPERÍA LA ESQUINA» en el ticket sin tocar el nombre con
-- el que se liquida.
--
-- ES OPCIONAL, Y ESO DEFINE SU COMPORTAMIENTO
-- -------------------------------------------
-- Vacío, el ticket imprime el nombre, que es lo que hacía hasta ahora. No hay
-- que rellenarlo para nada ni migrar a los vendedores que ya existen: nace
-- funcionando igual que antes.
--
-- La caída al nombre se decide en LA BASE y no en cada pantalla. Si cada sitio
-- que muestra un vendedor tuviera que escribir su propio `alias ?? nombre`,
-- bastaría con que uno se olvidara para que el mismo vendedor apareciera con
-- dos identidades distintas según dónde se le mire.
--
-- QUÉ NO CAMBIA
-- -------------
-- El alias es sólo para mostrar. Los informes, la liquidación y la auditoría
-- siguen usando el nombre y el código: son la identidad contable del vendedor,
-- y ésa no puede depender de un rótulo que se cambia cuando cambia el toldo.
-- ===========================================================================

alter table public.vendedor
  add column if not exists alias text;

comment on column public.vendedor.alias is
  'Nombre comercial para el ticket. Opcional: vacío, se imprime `nombre`. No sustituye al nombre en informes ni liquidación.';


-- --------------------------------------------------------------------------
-- Lo que se muestra al cliente: el alias si lo hay, si no el nombre.
--
-- Una función y no un `coalesce` repetido por ahí: la regla vive en un sitio,
-- y el día que cambie —que se recorte, que se ponga en mayúsculas— cambia para
-- todas las pantallas a la vez.
--
-- `immutable` porque depende sólo de sus argumentos: Postgres puede usarla en
-- un índice o resolverla una vez por consulta.
-- --------------------------------------------------------------------------

create or replace function public.fn_rotulo(p_alias text, p_nombre text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(nullif(btrim(coalesce(p_alias, '')), ''), p_nombre);
$$;

comment on function public.fn_rotulo(text, text) is
  'El alias si está diligenciado, si no el nombre. La caída vive aquí para que no la escriba cada pantalla por su cuenta.';


-- --------------------------------------------------------------------------
-- El alta, con alias.
--
-- Cambia la firma —un parámetro más— así que hay que soltar la anterior:
-- dejar las dos vivas haría ambigua cualquier llamada.
-- --------------------------------------------------------------------------

drop function if exists public.fn_crear_vendedor(
  text, text, text, text, text, text, double precision, double precision,
  text, numeric, numeric, numeric
);

create or replace function public.fn_crear_vendedor(
  p_nombre          text,
  p_telefono        text,
  p_correo          text,
  p_identidad       text,
  p_ciudad          text,
  p_barrio          text,
  p_lat             double precision,
  p_lng             double precision,
  p_color           text,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric,
  p_alias           text default null
) returns table (vendedor_id uuid, vendedor_codigo text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id        uuid;
  v_siguiente integer;
  v_codigo    text;
  v_barrio    text := nullif(btrim(coalesce(p_barrio, '')), '');
  v_telefono  text := nullif(btrim(coalesce(p_telefono, '')), '');
  v_correo    text := nullif(btrim(coalesce(p_correo, '')), '');
  v_identidad text := nullif(btrim(coalesce(p_identidad, '')), '');
  v_ciudad    text := nullif(btrim(coalesce(p_ciudad, '')), '');
  v_alias     text := nullif(btrim(coalesce(p_alias, '')), '');
  v_lat       double precision := p_lat;
  v_lng       double precision := p_lng;
  v_aprox     boolean := false;
  -- El centro del departamento de Cortés. Se usa cuando no hay coordenada.
  c_lat constant double precision := 15.4833;
  c_lng constant double precision := -87.9667;
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if length(btrim(coalesce(p_nombre, ''))) < 5 then
    raise exception 'Escriba el nombre completo del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_ciudad is null or length(v_ciudad) < 3 then
    raise exception 'Escriba la ciudad del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * El alias no puede desbordar la tirilla.
   *
   * Medido en Courier bold sobre los 52 mm útiles del rollo (196,5 px), a 11px
   * caben unos treinta caracteres. Se corta AQUÍ y no al imprimir: si se
   * recortara sólo en el papel, quien lo escribió vería en pantalla un alias
   * que el ticket nunca muestra entero, y no sabría por qué.
   */
  if v_alias is not null and length(v_alias) > 30 then
    raise exception 'El alias no puede pasar de 30 caracteres; no cabe en el ticket.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se adopta la escritura de una ciudad ya registrada si sólo difiere en
  -- mayúsculas: sin esto, «choloma» y «Choloma» son dos ciudades para
  -- cualquier informe que agrupe. Ver la 0062.
  select v.ciudad into v_ciudad
  from public.vendedor v
  where lower(v.ciudad) = lower(v_ciudad)
  limit 1;

  if v_ciudad is null then
    v_ciudad := btrim(p_ciudad);
  end if;

  -- Sin coordenada, el centro del departamento: un vendedor sin `lat` queda
  -- fuera del mapa, y desaparecer es peor que estar aproximado mientras se
  -- marque como tal.
  if v_lat is null or v_lng is null then
    v_lat := c_lat;
    v_lng := c_lng;
    v_aprox := true;
  end if;

  if v_telefono is not null and v_telefono !~ '^\d{4}-\d{4}$' then
    raise exception 'Teléfono en formato 9999-9999, o déjelo en blanco.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_correo is not null and v_correo !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
    raise exception 'Correo electrónico no válido, o déjelo en blanco.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serializa la generación del código entre altas concurrentes.
  lock table public.vendedor in share row exclusive mode;

  select coalesce(max(substring(codigo from 3)::integer), 0) + 1
  into v_siguiente
  from public.vendedor;

  v_codigo := 'V-' || lpad(v_siguiente::text, 3, '0');
  v_id := gen_random_uuid();

  insert into public.vendedor (
    id, codigo, nombre, alias, identidad, telefono, correo, ciudad, barrio,
    zona, color, lat, lng, ubicacion_aproximada
  ) values (
    v_id, v_codigo, btrim(p_nombre), v_alias, v_identidad, v_telefono,
    v_correo, v_ciudad, v_barrio,
    v_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado'),
    p_color, v_lat, v_lng, v_aprox
  );

  -- Sin parámetros vigentes el vendedor no puede vender: fn_registrar_ticket
  -- los exige para congelarlos en cada línea. Van en la misma transacción.
  perform public.fn_guardar_parametros(v_id, p_comision, p_factor_pago, p_tope_por_numero);

  perform public.fn_auditar('vendedor', v_id, 'crear', 'codigo', null, v_codigo);

  return query select v_id, v_codigo;
end;
$$;

comment on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric, text) is
  'Alta de vendedor. El alias es opcional: si viene, es lo que imprime el ticket; si no, el nombre.';

revoke execute on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric, text)
  from public, anon;


-- --------------------------------------------------------------------------
-- Cambiar el alias de un vendedor que ya existe.
--
-- Se separa del alta porque es lo que se va a usar de verdad: los vendedores
-- ya están creados, y el alias se pone después de ver cómo lo llama la gente.
-- --------------------------------------------------------------------------

create or replace function public.fn_guardar_alias(
  p_vendedor_id uuid,
  p_alias       text,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alias    text := nullif(btrim(coalesce(p_alias, '')), '');
  v_anterior text;
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if v_alias is not null and length(v_alias) > 30 then
    raise exception 'El alias no puede pasar de 30 caracteres; no cabe en el ticket.'
      using errcode = 'invalid_parameter_value';
  end if;

  select alias into v_anterior
  from public.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  update public.vendedor set alias = v_alias where id = p_vendedor_id;

  -- Cambia lo que ve el cliente en el papel, así que queda registrado quién y
  -- cuándo: no es un dato cosmético si mañana alguien reclama por un ticket.
  perform public.fn_auditar('vendedor', p_vendedor_id, 'alias', 'alias',
                           coalesce(v_anterior, '—'), coalesce(v_alias, '—'));
end;
$$;

comment on function public.fn_guardar_alias(uuid, text, uuid) is
  'Pone o quita el alias de un vendedor. Vacío lo borra y el ticket vuelve al nombre.';

revoke execute on function public.fn_guardar_alias(uuid, text, uuid)
  from public, anon;
