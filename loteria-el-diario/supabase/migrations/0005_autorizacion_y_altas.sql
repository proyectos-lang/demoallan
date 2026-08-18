-- ===========================================================================
-- Autorización dentro de las funciones + altas de vendedor y de sorteos.
--
-- HUECO QUE CIERRA ESTA MIGRACIÓN
-- -------------------------------
-- Las funciones de 0002/0004 son SECURITY DEFINER y tienen EXECUTE concedido a
-- `authenticated`. SECURITY DEFINER significa que corren con los permisos del
-- dueño y por tanto SE SALTAN RLS — que era justo la intención para poder
-- escribir en tablas sin políticas de escritura.
--
-- El problema es que ninguna comprobaba QUIÉN llamaba. Con sólo estar
-- autenticado, un vendedor podía llamar a fn_guardar_parametros y subirse la
-- comisión, liquidar un sorteo, o insertar filas inventadas en auditoría.
-- RLS no lo impedía porque estas funciones existen precisamente para eludirlo.
--
-- La corrección es comprobar el rol DENTRO de cada función. Se recrean con el
-- cuerpo íntegro (la firma no cambia, así que basta CREATE OR REPLACE) y una
-- guarda al principio.
-- ===========================================================================

-- --- Guardas ---------------------------------------------------------------

-- ¿La llamada viene con la llave de servicio? Los scripts de operación y el
-- cron entran por ahí y no tienen perfil en usuario_perfil.
--
-- Se mira el CLAIM del JWT, no `current_user`, y la diferencia importa: dentro
-- de una función SECURITY DEFINER `current_user` es el dueño de la función
-- (postgres), no quien llamó. Usarlo haría que fn_guardar_parametros negara el
-- paso al propio service_role en cuanto se la invoca desde otra función.
-- `request.jwt.claims` es un ajuste de la transacción y sí sobrevive al salto.
create or replace function allan.fn_es_servicio()
returns boolean
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    ''
  ) = 'service_role';
$$;

create or replace function allan.fn_exige(p_roles allan.rol_usuario[])
returns void
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_rol allan.rol_usuario;
begin
  if allan.fn_es_servicio() then
    return;
  end if;

  v_rol := allan.fn_rol_actual();

  if v_rol is null or not (v_rol = any (p_roles)) then
    raise exception 'No tiene permiso para esta operación.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- La auditoría es append-only y la escriben las demás funciones. Que un
-- cliente pueda llamarla directamente permitiría fabricar historia.
revoke execute on function allan.fn_auditar(text, uuid, text, text, text, text)
  from authenticated;

-- --- Guardas sobre las funciones existentes -------------------------------

create or replace function allan.fn_abrir_sorteo(
  p_sorteo_id          uuid,
  p_limite_por_numero  numeric
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado is null then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'programado' then
    raise exception 'Sólo se puede abrir un sorteo programado; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
  select p_sorteo_id, n, p_limite_por_numero, 0
  from generate_series(0, 99) as n
  on conflict (sorteo_id, numero) do nothing;

  update allan.sorteo set estado = 'abierto' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'abrir', 'estado', v_estado::text, 'abierto');
end;
$$;

create or replace function allan.fn_cerrar_sorteo(p_sorteo_id uuid)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se puede cerrar un sorteo abierto; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.sorteo set estado = 'cerrado' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'cerrar', 'estado', 'abierto', 'cerrado');
end;
$$;

create or replace function allan.fn_guardar_parametros(
  p_vendedor_id     uuid,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_anterior allan.parametro_vendedor%rowtype;
  v_nuevo_id uuid;
begin
  -- Sin esta guarda, un vendedor podía cambiarse su propia comisión.
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_comision < 0 or p_comision > 0.60 then
    raise exception 'La comisión debe estar entre 0 y 60%%.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_factor_pago < 1 or p_factor_pago > 200 then
    raise exception 'El factor de pago debe estar entre 1 y 200.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_tope_por_numero < 10 then
    raise exception 'El tope por número debe ser al menos L 10.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_anterior
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  for update;

  if found
     and v_anterior.comision = p_comision
     and v_anterior.factor_pago = p_factor_pago
     and v_anterior.tope_por_numero = p_tope_por_numero then
    return v_anterior.id;
  end if;

  if found then
    update allan.parametro_vendedor
    set vigente_hasta = now()
    where id = v_anterior.id;
  end if;

  insert into allan.parametro_vendedor (
    vendedor_id, comision, factor_pago, tope_por_numero, creado_por
  ) values (
    p_vendedor_id, p_comision, p_factor_pago, p_tope_por_numero, auth.uid()
  )
  returning id into v_nuevo_id;

  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'comision',
    coalesce(v_anterior.comision::text, '—'), p_comision::text);
  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'factor_pago',
    coalesce(v_anterior.factor_pago::text, '—'), p_factor_pago::text);
  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'tope_por_numero',
    coalesce(v_anterior.tope_por_numero::text, '—'), p_tope_por_numero::text);

  return v_nuevo_id;
end;
$$;

create or replace function allan.fn_reservar_cuota(
  p_sorteo_id        uuid,
  p_dispositivo_id   uuid,
  p_monto_por_numero numeric
) returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_filas integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  insert into allan.cuota_dispositivo (sorteo_id, dispositivo_id, numero, asignado)
  select p_sorteo_id, p_dispositivo_id, c.numero,
         least(p_monto_por_numero, c.limite_casa - c.vendido)
  from allan.cupo_numero c
  where c.sorteo_id = p_sorteo_id
  on conflict (sorteo_id, dispositivo_id, numero) do nothing;

  get diagnostics v_filas = row_count;

  perform allan.fn_auditar('cuota_dispositivo', p_dispositivo_id, 'reservar',
                           'sorteo_id', null, p_sorteo_id::text);
  return v_filas;
end;
$$;

create or replace function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (
  total_vendedores       integer,
  total_lineas_ganadoras integer,
  total_premios          numeric
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado     allan.estado_sorteo;
  v_ganadoras  integer;
  v_premios    numeric(14,2);
  v_vendedores integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select t.sorteo_id,
         t.vendedor_id,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         auth.uid()
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.sorteo_id, t.vendedor_id;

  get diagnostics v_vendedores = row_count;

  select coalesce(sum(l.premio), 0) into v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  update allan.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$$;

create or replace function allan.fn_anular_ticket(
  p_ticket_id uuid,
  p_motivo    text
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_ticket allan.ticket%rowtype;
  v_estado allan.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from allan.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  -- Un vendedor sólo puede anular lo suyo; administración, cualquiera.
  if not allan.fn_es_servicio()
     and allan.fn_rol_actual() is distinct from 'administrador'
     and v_ticket.vendedor_id is distinct from allan.fn_vendedor_actual() then
    raise exception 'No tiene permiso para anular este ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = v_ticket.sorteo_id
  for share;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  for v_linea in
    select numero, sum(monto) as monto
    from allan.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update allan.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update allan.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update allan.ticket
  set anulado_en = now(), anulado_por = auth.uid(), motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform allan.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo);
end;
$$;

-- --- Alta de vendedor ------------------------------------------------------
-- El código se genera DENTRO de la transacción, con la tabla bloqueada, para
-- que dos altas simultáneas no produzcan dos V-006.

create or replace function allan.fn_crear_vendedor(
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
set search_path = allan, public
as $$
declare
  v_id        uuid;
  v_siguiente integer;
  v_codigo    text;
  v_barrio    text := nullif(btrim(p_barrio), '');
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if length(btrim(p_nombre)) < 5 then
    raise exception 'Escriba el nombre completo del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  if btrim(p_telefono) !~ '^\d{4}-\d{4}$' then
    raise exception 'Teléfono en formato 9999-9999.'
      using errcode = 'invalid_parameter_value';
  end if;

  if btrim(p_correo) !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
    raise exception 'Correo electrónico no válido.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serializa la generación del código entre altas concurrentes.
  lock table allan.vendedor in share row exclusive mode;

  select coalesce(max(substring(codigo from 3)::integer), 0) + 1
  into v_siguiente
  from allan.vendedor;

  v_codigo := 'V-' || lpad(v_siguiente::text, 3, '0');
  v_id := gen_random_uuid();

  insert into allan.vendedor (
    id, codigo, nombre, identidad, telefono, correo, ciudad, barrio, zona, color, lat, lng
  ) values (
    v_id, v_codigo, btrim(p_nombre), nullif(btrim(p_identidad), ''), btrim(p_telefono),
    btrim(p_correo), p_ciudad, v_barrio,
    p_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado'),
    p_color, p_lat, p_lng
  );

  -- Sin parámetros vigentes el vendedor no puede vender: fn_registrar_ticket
  -- los exige para congelarlos en cada línea. Van en la misma transacción.
  perform allan.fn_guardar_parametros(v_id, p_comision, p_factor_pago, p_tope_por_numero);

  perform allan.fn_auditar('vendedor', v_id, 'crear', 'codigo', null, v_codigo);

  return query select v_id, v_codigo;
end;
$$;

-- --- Programación del día --------------------------------------------------
-- Crea los tres sorteos de una fecha. La venta cierra 10 minutos antes de cada
-- sorteo, que es la convención del prototipo (20:00 cierra 19:50).

create or replace function allan.fn_programar_dia(p_fecha date)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_hora   allan.hora_sorteo;
  v_time   time;
  v_creados integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_hora in array array['11:00', '15:00', '20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_hora
                when '11:00' then time '11:00'
                when '15:00' then time '15:00'
                else time '20:00'
              end;

    insert into allan.sorteo (fecha, hora, hora_cierre)
    values (
      p_fecha,
      v_hora,
      ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa')
    )
    on conflict (fecha, hora) do nothing;

    v_creados := v_creados + 1;
  end loop;

  perform allan.fn_auditar('sorteo', null, 'programar_dia', 'fecha', null, p_fecha::text);
  return v_creados;
end;
$$;

-- --- Registro de ticket: quién puede vender a nombre de quién --------------
-- Se recrea con el cuerpo íntegro (CREATE OR REPLACE exige el cuerpo completo)
-- para anteponerle la guarda de rol.

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- Un vendedor sólo registra ventas a su propio nombre. Administración y
  -- digitación pueden hacerlo por cualquiera (la digitalización crea tickets
  -- de la hoja de otro vendedor).
  if not allan.fn_es_servicio() then
    if allan.fn_rol_actual() = 'vendedor'
       and p_vendedor_id is distinct from allan.fn_vendedor_actual() then
      raise exception 'No puede registrar ventas a nombre de otro vendedor.'
        using errcode = 'insufficient_privilege';
    end if;
    perform allan.fn_exige(array['vendedor','digitador','administrador']::allan.rol_usuario[]);
  end if;

  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado <> 'abierto' then
    raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
      using errcode = 'invalid_parameter_value';
  end if;

  if now() >= v_sorteo.hora_cierre then
    raise exception 'La venta de este sorteo cerró a las %.', v_sorteo.hora_cierre
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
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

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
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

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
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

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V901-20990101-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  -- El id se genera aquí en vez de recuperarlo con RETURNING: así no hay
  -- ninguna referencia a la columna `id` dentro del cuerpo de la función.
  v_ticket_id := gen_random_uuid();

  insert into allan.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  );

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  return query select v_ticket_id, v_folio, v_total;
end;
$$;
