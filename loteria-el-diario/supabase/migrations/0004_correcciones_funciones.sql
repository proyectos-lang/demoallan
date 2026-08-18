-- ===========================================================================
-- Corrección: colisión de nombres entre las columnas de salida y las columnas
-- de las tablas dentro de las funciones plpgsql.
--
-- `returns table (id uuid, folio text, total numeric)` declara variables OUT
-- llamadas id/folio/total. A partir de ahí, dentro del cuerpo, cualquier
-- `where id = ...` o `returning ... into ...` es ambiguo: PostgreSQL no sabe si
-- «id» es la columna de la tabla o la variable de salida, y aborta con
-- 42702 «column reference "id" is ambiguous».
--
-- Se corrige de dos formas complementarias:
--   1. Los nombres de salida llevan prefijo y ya no coinciden con ninguna
--      columna (`ticket_id`, `total_premios`, …).
--   2. El id del ticket se genera explícitamente en vez de recuperarlo con
--      RETURNING, que era el punto exacto del choque.
--
-- Cambia el tipo de retorno, así que hay que soltar la función antes de
-- recrearla: CREATE OR REPLACE no puede alterar la firma de salida.
-- ===========================================================================

drop function if exists allan.fn_registrar_ticket(
  uuid, uuid, jsonb, double precision, double precision, uuid, allan.canal_ticket, uuid
);

create function allan.fn_registrar_ticket(
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

-- --- Liquidación: mismo endurecimiento en los nombres de salida -----------
-- `premios` coincidía con la columna de allan.liquidacion.

drop function if exists allan.fn_liquidar_sorteo(uuid, smallint);

create function allan.fn_liquidar_sorteo(
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
  --    Sin tope y sin ajustes para cuadrar contra ningún agregado.
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

  -- 3. Bloquear el sorteo.
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
