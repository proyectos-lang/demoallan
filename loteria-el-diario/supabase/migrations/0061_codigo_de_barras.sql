-- ===========================================================================
-- Cada venta lleva su código de barras EAN-13.
--
-- PARA QUÉ
-- --------
-- Para poder leer un ticket con la pistola en vez de teclear el folio, y para
-- tener un identificador corto que se pueda dictar por teléfono. Vale aunque
-- el ticket no llegue a imprimirse: el código es del ticket, no del papel.
--
-- POR QUÉ EAN-13 Y NO EL FOLIO
-- ----------------------------
-- El folio —`V002-20260903-0001`— lleva letras y guiones, y los lectores
-- básicos no lo leen sin configurarlos. EAN-13 es numérico puro, el mismo
-- estándar de los productos de supermercado, y lo lee cualquier pistola sin
-- tocar nada. El folio se queda: identifica al vendedor de un vistazo, que el
-- código de barras no hace.
--
-- LA ESTRUCTURA, DÍGITO A DÍGITO
-- ------------------------------
--     26 09 06   0   0001   X
--     └──┬───┘   │   └─┬─┘  └── dígito de control (lo calcula el estándar)
--     YYMMDD     │     └────── consecutivo del día, 0000–9999
--                └──────────── sorteo: 1 = 11 AM, 2 = 3 PM, 3 = 9 PM
--
-- Son 11 dígitos de datos y EAN-13 admite 12, así que sobra uno. Va un CERO
-- FIJO entre el sorteo y el consecutivo: es el hueco de crecer sin cambiar el
-- formato —un día podría ser el segundo dígito del consecutivo, o marcar una
-- sucursal— y mientras tanto no significa nada, que es mejor que darle un
-- significado apretado ahora.
--
-- EL CONSECUTIVO ES DEL DÍA, NO DEL SORTEO
-- ----------------------------------------
-- Corre del sorteo de la mañana al de la noche y se reinicia a medianoche en
-- hora de Honduras. Como el sorteo va aparte en el código, dos tickets del
-- mismo día no pueden coincidir aunque sean de sorteos distintos.
--
-- QUÉ PASA SI SE LLEGA A 9999
-- ---------------------------
-- El contador no da la vuelta en silencio: la función lanza. Un código de
-- barras repetido es peor que no tenerlo — la pistola devolvería dos ventas
-- distintas y nadie sabría cuál es. Con el volumen de hoy —unos cincuenta
-- tickets diarios— el tope queda lejísimos, pero el día que se acerque hay que
-- enterarse, no descubrirlo cuadrando.
-- ===========================================================================

alter table public.ticket
  add column if not exists codigo_barras text;

comment on column public.ticket.codigo_barras is
  'EAN-13 del ticket: YYMMDD + sorteo + 0 + consecutivo del día + control. Identificador corto y legible por pistola.';

-- Único de verdad: es lo que hace fiable leerlo con el lector. Parcial porque
-- los tickets anteriores a esta migración no lo tienen, y en SQL dos NULL no
-- chocan entre sí — misma lección de la 0050 y la 0056.
create unique index if not exists ticket_codigo_barras_unico
  on public.ticket (codigo_barras)
  where codigo_barras is not null;

-- Se busca por él al leer con la pistola, y `where` lo mantiene pequeño.
create index if not exists ticket_por_codigo
  on public.ticket (codigo_barras)
  where codigo_barras is not null and anulado_en is null;


-- --------------------------------------------------------------------------
-- El dígito de control del estándar.
--
-- Se suman los doce dígitos con pesos 1 y 3 alternados desde la izquierda, y
-- el control es lo que falta para llegar a la decena siguiente. Comprobado
-- contra el ejemplo de referencia: 260612 3 01001 -> control 8.
-- --------------------------------------------------------------------------

create or replace function public.fn_ean13_control(p_doce text)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_suma integer := 0;
  i      integer;
begin
  if p_doce is null or length(p_doce) <> 12 or p_doce !~ '^[0-9]{12}$' then
    raise exception 'El código base debe tener exactamente 12 dígitos; llegó %.', p_doce
      using errcode = 'invalid_parameter_value';
  end if;

  for i in 1..12 loop
    -- Posiciones impares pesan 1 y pares 3, contando desde la izquierda.
    v_suma := v_suma + substr(p_doce, i, 1)::integer * (case when i % 2 = 0 then 3 else 1 end);
  end loop;

  return (10 - (v_suma % 10)) % 10;
end;
$$;

comment on function public.fn_ean13_control(text) is
  'Dígito de control de un EAN-13 a partir de sus doce dígitos de datos.';


-- --------------------------------------------------------------------------
-- El contador diario.
--
-- Una fila por fecha. Se lleva aparte y no se cuentan los tickets del día:
-- contar daría el mismo número dos veces si dos ventas entran a la vez, y
-- volvería a dar un número ya usado si un ticket se anula.
-- --------------------------------------------------------------------------

create table if not exists public.consecutivo_dia (
  fecha    date primary key,
  ultimo   integer not null default 0,

  constraint consecutivo_rango check (ultimo >= 0 and ultimo <= 9999)
);

comment on table public.consecutivo_dia is
  'El último consecutivo entregado cada día. Aparte de los tickets: contarlos repetiría números al anular o bajo concurrencia.';


-- --------------------------------------------------------------------------
-- El código de un ticket.
--
-- Toma el siguiente consecutivo del día y arma el EAN-13. Se llama DENTRO de
-- la transacción que registra el ticket, así que el número que entrega ya no
-- se lo puede llevar nadie más.
-- --------------------------------------------------------------------------

create or replace function public.fn_codigo_barras(
  p_fecha date,
  p_hora  public.hora_sorteo
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n     integer;
  v_orden integer;
  v_doce  text;
begin
  /*
   * `on conflict do update` con el bloqueo implícito de la fila: dos ventas
   * simultáneas del mismo día se serializan aquí y cada una se lleva un número
   * distinto. Es el mismo mecanismo que protege el cupo.
   */
  insert into public.consecutivo_dia (fecha, ultimo)
  values (p_fecha, 1)
  on conflict (fecha) do update
    set ultimo = public.consecutivo_dia.ultimo + 1
  returning ultimo into v_n;

  if v_n > 9999 then
    raise exception 'Se agotaron los códigos de barras del %: son 9.999 por día.', p_fecha
      using errcode = 'check_violation';
  end if;

  v_orden := case p_hora when '11:00' then 1 when '15:00' then 2 else 3 end;

  -- YYMMDD + sorteo + el cero de reserva + consecutivo de cuatro.
  v_doce := to_char(p_fecha, 'YYMMDD')
            || v_orden::text
            || '0'
            || lpad(v_n::text, 4, '0');

  return v_doce || public.fn_ean13_control(v_doce)::text;
end;
$$;

comment on function public.fn_codigo_barras(date, public.hora_sorteo) is
  'Siguiente EAN-13 del día: YYMMDD + sorteo + 0 + consecutivo + control.';

revoke execute on function public.fn_codigo_barras(date, public.hora_sorteo)
  from public, anon;


-- --------------------------------------------------------------------------
-- La venta estampa el código.
--
-- Se recrea `fn_registrar_ticket` con el cuerpo íntegro y una línea más. La
-- firma no cambia, así que basta `create or replace`.
-- --------------------------------------------------------------------------

create or replace function public.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          public.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null,
  p_forzar         boolean default false,
  p_usuario_id     uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sorteo        public.sorteo%rowtype;
  v_codigo        text;
  v_param         public.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_barras        text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          public.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  if not public.fn_es_servicio() then
    if public.fn_rol_actual() = 'vendedor'
       and p_vendedor_id is distinct from public.fn_vendedor_actual() then
      raise exception 'No puede registrar ventas a nombre de otro vendedor.'
        using errcode = 'insufficient_privilege';
    end if;
    perform public.fn_exige(array['vendedor','digitador','administrador']::public.rol_usuario[]);
  end if;

  select * into v_sorteo
  from public.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado = 'programado' then
    raise exception 'El sorteo todavía no ha abierto.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not p_forzar then
    if v_sorteo.estado <> 'abierto' then
      raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
        using errcode = 'invalid_parameter_value';
    end if;

    if now() >= v_sorteo.hora_cierre then
      raise exception 'La venta de este sorteo cerró a las % (hora de Honduras).',
        to_char(v_sorteo.hora_cierre at time zone 'America/Tegucigalpa', 'HH12:MI AM')
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  select codigo into v_codigo
  from public.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  select * into v_param
  from public.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    select * into v_cupo
    from public.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from public.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update public.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update public.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  select count(*) + 1 into v_consecutivo
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  v_ticket_id := gen_random_uuid();

  -- El código de barras, del día del SORTEO y no del día en que se registra:
  -- una venta futura hecha el lunes para el jueves lleva el jueves, que es
  -- cuando el ticket se cobra y cuando alguien lo va a buscar.
  v_barras := public.fn_codigo_barras(v_sorteo.fecha, v_sorteo.hora);

  insert into public.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id, forzado, codigo_barras
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total,
    coalesce(p_usuario_id, auth.uid()),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id, p_forzar, v_barras
  );

  insert into public.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform public.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  if p_forzar then
    perform public.fn_auditar('ticket', v_ticket_id, 'registrar_forzado', 'usuario',
                             v_sorteo.estado::text, coalesce(p_usuario_id::text, 'desconocido'));

    if v_sorteo.estado = 'liquidado' then
      perform public.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
    end if;
  end if;

  return query select v_ticket_id, v_folio, v_total;
end;
$$;


-- --------------------------------------------------------------------------
-- Buscar un ticket por su código.
--
-- Es lo que usa la pistola: se lee el código y sale la venta.
-- --------------------------------------------------------------------------

create or replace function public.fn_ticket_por_codigo(p_codigo text)
returns table (
  r_ticket_id uuid,
  r_folio     text,
  r_fecha     date,
  r_hora      public.hora_sorteo,
  r_estado    public.estado_sorteo,
  r_vendedor  text,
  r_codigo_v  text,
  r_creado_en timestamptz,
  r_total     numeric,
  r_premio    numeric,
  r_anulado   boolean,
  r_jugada    text
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.folio, s.fecha, s.hora, s.estado, v.nombre, v.codigo,
         t.creado_en, sum(l.monto), sum(l.premio), t.anulado_en is not null,
         string_agg(
           lpad(l.numero::text, 2, '0') || ':' ||
           case when l.monto = trunc(l.monto)
                then trunc(l.monto)::bigint::text
                else to_char(l.monto, 'FM999999990.00')
           end,
           '  ' order by l.numero, l.monto)
  from public.ticket t
  join public.sorteo   s on s.id = t.sorteo_id
  join public.vendedor v on v.id = t.vendedor_id
  join public.linea    l on l.ticket_id = t.id
  /*
   * Se acepta con o sin el dígito de control: algunos lectores lo omiten.
   *
   * El control sólo se calcula cuando llegan EXACTAMENTE doce dígitos.
   * `fn_ean13_control` lanza con cualquier otra longitud, y una excepción
   * dentro de un `where` tumba la consulta entera: al leer un código completo
   * —trece— la pistola no encontraría nada y el error no diría por qué.
   */
  where t.codigo_barras = p_codigo
     or (p_codigo ~ '^[0-9]{12}$'
         and t.codigo_barras = p_codigo || public.fn_ean13_control(p_codigo)::text)
  group by t.id, t.folio, s.fecha, s.hora, s.estado, v.nombre, v.codigo,
           t.creado_en, t.anulado_en;
$$;

comment on function public.fn_ticket_por_codigo(text) is
  'La venta de un código de barras. Acepta el EAN-13 completo o sus doce dígitos sin control.';

revoke execute on function public.fn_ticket_por_codigo(text) from public, anon;


-- --------------------------------------------------------------------------
-- La tanda devuelve el código, para que llegue al papel.
--
-- Cambia el tipo de retorno, así que hay que soltar la función. Es el mismo
-- cuerpo de la 0056 con una columna más.
-- --------------------------------------------------------------------------

drop function if exists public.fn_registrar_tanda(
  uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid
);

create or replace function public.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null,
  p_envio_id    uuid default null
) returns table (
  r_folio     text,
  r_total     numeric,
  r_creado_en timestamptz,
  r_repetido  boolean,
  r_codigo    text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuantos integer;
  v_lineas  jsonb;
  v_res     record;
  v_ya      integer;
  v_primero boolean := true;
begin
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_cuantos := jsonb_array_length(p_tickets);

  if v_cuantos = 0 then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  -- ¿Este envío ya entró? Se devuelve lo que se creó, sin duplicar. Ver 0056.
  if p_envio_id is not null then
    select count(*) into v_ya
    from public.ticket t
    where t.envio_id = p_envio_id;

    if v_ya > 0 then
      return query
        select t.folio, t.total, t.creado_en, true, t.codigo_barras
        from public.ticket t
        where t.envio_id = p_envio_id
        order by t.folio;
      return;
    end if;
  end if;

  -- Prebloqueo de los números de la tanda, en orden ascendente: sin esto, dos
  -- tandas con los mismos números en distinto orden se interbloquean.
  perform 1
  from public.cupo_numero c
  where c.sorteo_id = p_sorteo_id
    and c.numero in (
      select distinct (linea->>'numero')::smallint
      from jsonb_array_elements(p_tickets) as ticket,
           jsonb_array_elements(ticket) as linea
    )
  order by c.numero
  for update;

  for v_lineas in select * from jsonb_array_elements(p_tickets)
  loop
    select * into v_res
    from public.fn_registrar_ticket(
      p_sorteo_id, p_vendedor_id, v_lineas,
      p_lat, p_lng, null,
      'movil'::public.canal_ticket, null,
      p_forzar, p_usuario_id
    );

    -- La marca del envío va en el PRIMER ticket y sólo en él: el índice único
    -- es por ticket, y estamparla en todos los haría chocar entre sí.
    if p_envio_id is not null and v_primero then
      update public.ticket set envio_id = p_envio_id where id = v_res.ticket_id;
      v_primero := false;
    end if;

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;
    r_repetido := false;

    -- La hora y el código, LEÍDOS DE LA FILA: son lo que quedó guardado, que
    -- es lo que debe viajar al papel.
    select t.creado_en, t.codigo_barras into r_creado_en, r_codigo
    from public.ticket t where t.id = v_res.ticket_id;

    return next;
  end loop;

  return;
end;
$$;

comment on function public.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid) is
  'Registra varios tickets en una transacción y devuelve folio, total, hora y código de barras de cada uno.';

revoke execute on function public.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid)
  from public, anon;


-- La venta futura envuelve a la tanda: hereda la columna nueva.
--
-- También hay que soltarla antes: gana `r_codigo` en la salida, y Postgres no
-- permite cambiar el tipo de retorno de una función existente ni siquiera con
-- `create or replace`. Mismo caso que `fn_registrar_tanda` aquí arriba.
drop function if exists public.fn_registrar_venta_futura(
  date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid
);

create or replace function public.fn_registrar_venta_futura(
  p_fecha       date,
  p_hora        public.hora_sorteo,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_usuario_id  uuid default null,
  p_envio_id    uuid default null
) returns table (
  r_folio     text,
  r_total     numeric,
  r_creado_en timestamptz,
  r_repetido  boolean,
  r_codigo    text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sorteo uuid;
begin
  v_sorteo := public.fn_asegurar_sorteo(p_fecha, p_hora);

  -- `p_forzar` en false: una venta futura no levanta el corte de hora.
  return query
    select * from public.fn_registrar_tanda(
      v_sorteo, p_vendedor_id, p_tickets,
      p_lat, p_lng, false, p_usuario_id, p_envio_id
    );
end;
$$;

revoke execute on function public.fn_registrar_venta_futura(date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid)
  from public, anon;
