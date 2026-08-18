-- ===========================================================================
-- Digitalización asistida por IA.
--
-- Principio §1: la IA no registra, propone. Nada de lo que devuelve el modelo
-- llega a `linea` sin pasar por dos filtros:
--
--   1. Revisión humana — el operador corrige los renglones dudosos.
--   2. CONTROL DE CUADRE — la suma de los renglones debe coincidir exactamente
--      con el total que el vendedor escribió al pie de la hoja. Es el único
--      mecanismo capaz de detectar un renglón que el modelo omitió: si falta
--      una apuesta, la suma no da y la confirmación queda bloqueada.
--
-- Y una vez superados, los tickets se crean llamando a fn_registrar_ticket —
-- la misma función que usa la venta móvil. La validación de cupo no se
-- reimplementa aquí: un ticket digitalizado está sujeto exactamente a los
-- mismos topes que uno vendido en la calle.
-- ===========================================================================

create or replace function allan.fn_crear_lote_ocr(
  p_imagen_path      text,
  p_vendedor_id      uuid,
  p_sorteo_id        uuid,
  p_total_declarado  numeric,
  p_confianza_global numeric,
  p_modelo           text,
  p_tokens_entrada   integer,
  p_tokens_salida    integer,
  p_costo            numeric
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_id uuid;
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  insert into allan.lote_ocr (
    imagen_path, vendedor_id, sorteo_id, total_declarado, confianza_global,
    estado, modelo, tokens_entrada, tokens_salida, costo_inferencia
  ) values (
    p_imagen_path, p_vendedor_id, p_sorteo_id, p_total_declarado, p_confianza_global,
    'extraido', p_modelo, p_tokens_entrada, p_tokens_salida, p_costo
  )
  returning id into v_id;

  perform allan.fn_auditar('lote_ocr', v_id, 'extraer', 'costo_inferencia',
                           null, p_costo::text);
  return v_id;
end;
$$;

-- --- Validación y creación de tickets -------------------------------------
-- p_lineas: [{"numero": 7, "monto": 50}, ...] ya corregidas por el operador.

create or replace function allan.fn_validar_lote_ocr(
  p_lote_id uuid,
  p_lineas  jsonb
) returns table (ticket_id uuid, ticket_folio text, lineas integer)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_lote    allan.lote_ocr%rowtype;
  v_suma    numeric(14,2);
  v_ticket  record;
  v_n       integer;
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  select * into v_lote
  from allan.lote_ocr where id = p_lote_id
  for update;

  if not found then
    raise exception 'El lote % no existe.', p_lote_id
      using errcode = 'no_data_found';
  end if;

  if v_lote.estado = 'validado' then
    raise exception 'Este lote ya fue validado; sus tickets están creados.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El lote no tiene renglones.'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(sum((l->>'monto')::numeric), 0) into v_suma
  from jsonb_array_elements(p_lineas) as l;

  -- El control de cuadre. Sin coincidencia exacta no se crea nada: la
  -- diferencia casi siempre significa un renglón que el modelo no vio.
  if v_suma <> v_lote.total_declarado then
    raise exception 'Descuadre: los renglones suman % y la hoja declara %. Diferencia de %.',
      v_suma, v_lote.total_declarado, v_suma - v_lote.total_declarado
      using errcode = 'check_violation';
  end if;

  -- Los tickets se crean por la misma puerta que una venta móvil, con sus
  -- mismos topes de cupo y su mismo congelamiento de parámetros.
  select * into v_ticket
  from allan.fn_registrar_ticket(
    v_lote.sorteo_id,
    v_lote.vendedor_id,
    p_lineas,
    null, null, null,
    'ocr'::allan.canal_ticket,
    p_lote_id
  );

  select jsonb_array_length(p_lineas) into v_n;

  update allan.lote_ocr
  set estado = 'validado', validado_por = auth.uid(), validado_en = now()
  where id = p_lote_id;

  perform allan.fn_auditar('lote_ocr', p_lote_id, 'validar', 'folio',
                           null, v_ticket.ticket_folio);

  return query select v_ticket.ticket_id, v_ticket.ticket_folio, v_n;
end;
$$;

-- --- Rechazo ---------------------------------------------------------------

create or replace function allan.fn_rechazar_lote_ocr(
  p_lote_id uuid,
  p_motivo  text
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  update allan.lote_ocr
  set estado = 'rechazado', validado_por = auth.uid(), validado_en = now()
  where id = p_lote_id and estado <> 'validado';

  if not found then
    raise exception 'El lote no existe o ya fue validado.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform allan.fn_auditar('lote_ocr', p_lote_id, 'rechazar', 'motivo', null, p_motivo);
end;
$$;

-- --- Gasto de inferencia ---------------------------------------------------
-- §8 pide vigilar tanto la calidad como el gasto. Esto alimenta la tarjeta de
-- «gasto del mes» de la pantalla.

create or replace function allan.fn_gasto_ocr(
  p_desde date,
  p_hasta date
) returns table (
  lotes             integer,
  imagenes_validadas integer,
  costo_total       numeric,
  confianza_media   numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select count(*)::integer,
         count(*) filter (where estado = 'validado')::integer,
         coalesce(sum(costo_inferencia), 0),
         coalesce(avg(confianza_global), 0)
  from allan.lote_ocr
  where creado_en::date between p_desde and p_hasta;
$$;
