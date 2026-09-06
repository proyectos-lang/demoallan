-- ===========================================================================
-- La ciudad de un vendedor deja de estar limitada a cuatro.
--
-- QUÉ CAMBIA Y QUÉ NO
-- -------------------
-- `vendedor.ciudad` siempre fue `text`, así que la BASE nunca limitó nada: la
-- lista de cuatro —San Pedro Sula, Choloma, Villanueva y La Lima— vivía en el
-- código, en un selector. Este cambio quita esa limitación y añade lo que
-- faltaba para que escribir libremente no degrade los datos.
--
-- EL PROBLEMA DEL TEXTO LIBRE
-- ---------------------------
-- Sin nada que lo ordene, el mismo sitio acaba escrito de cuatro maneras
-- —«Choloma», «choloma», «CHOLOMA», «Choloma, Cortés»— y los informes por
-- ciudad reparten un solo lugar en cuatro filas que nadie suma. Aquí se
-- normaliza: se recortan los espacios y se ajusta a las mayúsculas de una
-- ciudad ya registrada si difiere sólo en eso.
--
-- No se corrige la ortografía ni se adivina: «Cholma» seguirá siendo «Cholma»,
-- porque inventar que quiso decir otra cosa es peor que dejar el error a la
-- vista.
--
-- LA COORDENADA ES OPCIONAL
-- -------------------------
-- Antes salía de la lista fija; ahora puede no venir. Si falta, se usa el
-- CENTRO DEL DEPARTAMENTO de Cortés, para que el vendedor aparezca en el mapa
-- en vez de desaparecer de él —`lat` nulo lo deja fuera de la consulta del
-- mapa, que exige coordenada—.
--
-- Es una posición aproximada y hay que poder distinguirla de una real: por eso
-- `ubicacion_aproximada`, que la pantalla puede señalar para que alguien la
-- corrija en vez de creerse que ese vendedor trabaja en mitad del campo.
-- ===========================================================================

alter table public.vendedor
  add column if not exists ubicacion_aproximada boolean not null default false;

comment on column public.vendedor.ubicacion_aproximada is
  'La coordenada es el centro del departamento, no la del vendedor: se creó sin ubicación. Sirve para pedir que alguien la corrija.';


-- --------------------------------------------------------------------------
-- Las ciudades que ya se usan.
--
-- No es un catálogo que haya que mantener: se deriva de los vendedores. Sirve
-- para que el alta ofrezca lo ya escrito y nadie tenga que recordar cómo se
-- tecleó la primera vez — que es de donde salen las variantes.
-- --------------------------------------------------------------------------

create or replace function public.fn_ciudades()
returns table (r_ciudad text, r_vendedores integer)
language sql
stable
security definer
set search_path = public
as $$
  select v.ciudad, count(*)::integer
  from public.vendedor v
  where v.eliminado_en is null
  group by v.ciudad
  -- Las más usadas primero: es lo que se va a elegir casi siempre.
  order by count(*) desc, v.ciudad;
$$;

comment on function public.fn_ciudades() is
  'Las ciudades ya registradas, con cuántos vendedores tiene cada una. Se deriva del padrón; no hay catálogo que mantener.';

revoke execute on function public.fn_ciudades() from public, anon;


-- --------------------------------------------------------------------------
-- El alta, con ciudad libre.
--
-- Misma firma: `p_ciudad` ya era `text` y `p_lat`/`p_lng` ya admitían nulo.
-- Lo que cambia es que ahora se validan y se normalizan.
-- --------------------------------------------------------------------------

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
  p_tope_por_numero numeric
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
   * Se adopta la escritura de una ciudad YA REGISTRADA si sólo difiere en
   * mayúsculas o acentos.
   *
   * Sin esto, «choloma» y «Choloma» son dos ciudades distintas para cualquier
   * informe que agrupe, y el mismo lugar se reparte en filas que nadie suma.
   * Es el precio del texto libre, y se paga aquí una vez en vez de en cada
   * consulta.
   *
   * `unaccent` no está disponible, así que se compara en minúsculas: coge el
   * caso frecuente —la mayúscula— sin prometer más de lo que hace.
   */
  select v.ciudad into v_ciudad
  from public.vendedor v
  where lower(v.ciudad) = lower(v_ciudad)
  limit 1;

  if v_ciudad is null then
    v_ciudad := btrim(p_ciudad);
  end if;

  -- Sin coordenada, el centro del departamento: un vendedor sin `lat` queda
  -- fuera del mapa, que exige coordenada, y desaparecer es peor que estar
  -- aproximado mientras se marque como tal.
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
    id, codigo, nombre, identidad, telefono, correo, ciudad, barrio, zona,
    color, lat, lng, ubicacion_aproximada
  ) values (
    v_id, v_codigo, btrim(p_nombre), v_identidad, v_telefono,
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

comment on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric) is
  'Alta de vendedor. La ciudad es libre; si ya existe con otra escritura se adopta la registrada. Sin coordenada se usa el centro del departamento, marcado como aproximado.';

revoke execute on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric)
  from public, anon;
