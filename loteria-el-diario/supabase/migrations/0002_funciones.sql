-- ===========================================================================
-- Funciones transaccionales
--
-- Todo lo que escribe pasa por aquí. El cliente NUNCA hace INSERT directo
-- sobre ticket, linea, cupo_numero ni sorteo.
--
-- Orden de bloqueo, respetado por todas las funciones para evitar interbloqueos:
--     sorteo  →  vendedor  →  cupo_numero (por número, ASCENDENTE)
--
-- Todas son SECURITY DEFINER con `search_path` fijado: si no se fija, un
-- usuario podría anteponer un esquema propio y secuestrar la resolución de
-- nombres dentro de la función.
-- ===========================================================================

-- --- Auditoría -------------------------------------------------------------

create or replace function allan.fn_auditar(
  p_entidad        text,
  p_entidad_id     uuid,
  p_accion         text,
  p_campo          text default null,
  p_valor_anterior text default null,
  p_valor_nuevo    text default null
) returns void
language sql
security definer
set search_path = allan, public
as $$
  insert into allan.auditoria (
    entidad, entidad_id, accion, campo, valor_anterior, valor_nuevo, usuario_id
  ) values (
    p_entidad, p_entidad_id, p_accion, p_campo, p_valor_anterior, p_valor_nuevo, auth.uid()
  );
$$;

-- --- Rol del usuario actual ------------------------------------------------

create or replace function allan.fn_rol_actual()
returns allan.rol_usuario
language sql
stable
security definer
set search_path = allan, public
as $$
  select rol from allan.usuario_perfil where id = auth.uid();
$$;

create or replace function allan.fn_vendedor_actual()
returns uuid
language sql
stable
security definer
set search_path = allan, public
as $$
  select vendedor_id from allan.usuario_perfil where id = auth.uid();
$$;

-- --- Abrir un sorteo y sembrar su cupo ------------------------------------
-- Siembra las 100 filas de cupo_numero. `p_limite_por_numero` es el límite
-- global de la casa PARA ESTA FRANJA: se pasa distinto para 11:00, 15:00 y
-- 20:00, que es la decisión tomada en §13.

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

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'abrir', 'estado',
                           v_estado::text, 'abierto');
end;
$$;

-- --- Cerrar la venta -------------------------------------------------------

create or replace function allan.fn_cerrar_sorteo(p_sorteo_id uuid)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
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

-- --- Registrar un ticket ---------------------------------------------------
-- El corazón del sistema. La verificación del cupo y la inserción ocurren en
-- la MISMA transacción, con la fila de cupo bloqueada. Nunca se consulta antes
-- y se inserta después: eso permitiría sobreventa bajo concurrencia.
--
-- p_lineas: jsonb  [{"numero": 47, "monto": 50}, ...]
--
-- Devuelve el ticket creado. Si algún número no tiene cupo, lanza excepción y
-- la transacción entera se deshace: no se registran tickets a medias.

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (id uuid, folio text, total numeric)
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

  -- 5. Folio: V003-20260817-0001, consecutivo por vendedor y día. El bloqueo
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

  insert into allan.ticket (
    folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  )
  returning allan.ticket.id into v_ticket_id;

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

-- --- Reservar cuota para un dispositivo -----------------------------------

create or replace function allan.fn_reservar_cuota(
  p_sorteo_id      uuid,
  p_dispositivo_id uuid,
  p_monto_por_numero numeric
) returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_filas integer;
begin
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

-- --- Liquidar un sorteo ----------------------------------------------------
-- Transacción única: marca las líneas ganadoras, calcula el premio con el
-- factor congelado DE CADA LÍNEA, genera las liquidaciones por vendedor y
-- bloquea el sorteo.
--
-- El premio es `monto * factor_congelado`, sin tope y sin ajustes para cuadrar
-- contra ningún agregado: el agregado se deriva de las líneas, nunca al revés.

create or replace function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (vendedores integer, lineas_ganadoras integer, premios numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado    allan.estado_sorteo;
  v_ganadoras integer;
  v_premios   numeric(14,2);
  v_vendedores integer;
begin
  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE: nadie puede vender ni volver a liquidar mientras esto corre.
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

  -- 1. Marcar ganadoras y calcular el premio con el factor de cada línea.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  -- 2. Liquidación por vendedor, agregando desde las líneas.
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

  -- 3. Bloquear el sorteo. El CHECK del esquema obliga a que estado,
  --    numero_ganador y liquidado_en viajen juntos.
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

-- --- Anular un ticket ------------------------------------------------------
-- Los tickets no se editan: se anulan y se vuelven a emitir. Devuelve el cupo
-- consumido para que el número vuelva a estar disponible.

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

  -- Devolver el cupo, número por número en orden ascendente.
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

-- --- Guardar parámetros de un vendedor -------------------------------------
-- Versionado: cierra la fila vigente e inserta una nueva. Nunca UPDATE en
-- sitio, para que las ventas ya registradas conserven lo que se les prometió.

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

  -- Sin cambios reales: no se versiona por versionar.
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

  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'comision',
    coalesce(v_anterior.comision::text, '—'), p_comision::text
  );
  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'factor_pago',
    coalesce(v_anterior.factor_pago::text, '—'), p_factor_pago::text
  );
  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'tope_por_numero',
    coalesce(v_anterior.tope_por_numero::text, '—'), p_tope_por_numero::text
  );

  return v_nuevo_id;
end;
$$;

-- --- Cupo disponible (consulta, NO autoritativa) --------------------------
-- Lo que la interfaz muestra al teclear el número. Es un dato de conveniencia:
-- la verificación que manda es la de fn_registrar_ticket, dentro de la
-- transacción. Entre esta lectura y el INSERT el saldo puede haber cambiado.

create or replace function allan.fn_cupo_disponible(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_numero      smallint
) returns numeric
language sql
stable
security definer
set search_path = allan, public
as $$
  select greatest(
    least(
      -- disponible de la casa
      (select c.limite_casa - c.vendido
       from allan.cupo_numero c
       where c.sorteo_id = p_sorteo_id and c.numero = p_numero),
      -- disponible del vendedor
      (select p.tope_por_numero
       from allan.parametro_vendedor p
       where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null)
      - coalesce((
          select sum(l.monto)
          from allan.linea l
          join allan.ticket t on t.id = l.ticket_id
          where t.sorteo_id = p_sorteo_id
            and t.vendedor_id = p_vendedor_id
            and t.anulado_en is null
            and l.numero = p_numero
        ), 0)
    ),
    0
  );
$$;
