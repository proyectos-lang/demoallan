-- ===========================================================================
-- Teléfono, identidad y correo dejan de ser obligatorios.
--
-- POR QUÉ
-- -------
-- El alta exigía teléfono con formato 9999-9999 y un correo válido. En la
-- operación real muchos vendedores no tienen correo, y el teléfono no siempre
-- se sabe al darlos de alta. La consecuencia era peor que el dato que faltaba:
-- quien registraba se inventaba un correo para poder pasar de pantalla, y el
-- padrón acababa con direcciones falsas que nadie puede distinguir de las
-- buenas.
--
-- Un dato ausente se ve; un dato inventado no.
--
-- LO QUE NO CAMBIA
-- ----------------
-- El nombre sigue siendo obligatorio: sin él, la fila no identifica a nadie.
-- Y lo que SÍ se escriba se sigue validando con el mismo rigor de antes —un
-- teléfono a medio teclear o un correo sin arroba siguen rechazándose—. Lo
-- opcional es dejarlos en blanco, no escribirlos mal.
--
-- Vacío se guarda como NULL, no como cadena vacía. La tabla ya los admite
-- nulos desde la 0001: son dos formas de decir «no hay dato» y tener las dos
-- obliga a comprobar ambas en cada consulta que los lea.
-- ===========================================================================

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
  v_barrio    text := nullif(btrim(p_barrio), '');
  -- Los tres opcionales se normalizan una sola vez: en blanco es NULL.
  v_telefono  text := nullif(btrim(coalesce(p_telefono, '')), '');
  v_correo    text := nullif(btrim(coalesce(p_correo, '')), '');
  v_identidad text := nullif(btrim(coalesce(p_identidad, '')), '');
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if length(btrim(coalesce(p_nombre, ''))) < 5 then
    raise exception 'Escriba el nombre completo del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se validan sólo si se escribieron. Dejarlos en blanco es una decisión
  -- legítima; escribirlos mal, no.
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
    id, codigo, nombre, identidad, telefono, correo, ciudad, barrio, zona, color, lat, lng
  ) values (
    v_id, v_codigo, btrim(p_nombre), v_identidad, v_telefono,
    v_correo, p_ciudad, v_barrio,
    p_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado'),
    p_color, p_lat, p_lng
  );

  -- Sin parámetros vigentes el vendedor no puede vender: fn_registrar_ticket
  -- los exige para congelarlos en cada línea. Van en la misma transacción.
  perform public.fn_guardar_parametros(v_id, p_comision, p_factor_pago, p_tope_por_numero);

  perform public.fn_auditar('vendedor', v_id, 'crear', 'codigo', null, v_codigo);

  return query select v_id, v_codigo;
end;
$$;

comment on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric) is
  'Alta de vendedor. Teléfono, correo e identidad son opcionales; si se escriben, se validan.';

revoke execute on function public.fn_crear_vendedor(text, text, text, text, text, text, double precision, double precision, text, numeric, numeric, numeric)
  from public, anon;
