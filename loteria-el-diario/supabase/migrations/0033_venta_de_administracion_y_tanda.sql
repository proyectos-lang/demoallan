-- ===========================================================================
-- Dos cosas que el punto de venta necesitaba de la base.
--
-- 1. VENTA DESPUÉS DEL CIERRE, SÓLO PARA ADMINISTRACIÓN
--    Una apuesta rezagada llega, y hoy no hay forma de meterla: la venta se
--    corta al segundo y el rechazo es el mismo para el vendedor que para el
--    dueño. Se abre una puerta explícita, `p_forzar`, y se deja rastro de por
--    dónde entró: `ticket.forzado`, `creado_por` de verdad y auditoría aparte.
--
--    LA BASE NO SABE QUIÉN LLAMA. Desde 0024 la aplicación habla como
--    `service_role`, así que `fn_es_servicio()` es `true` en toda petición y
--    `fn_exige` retorna sin comprobar nada. Por eso `p_forzar` es un parámetro
--    y no una consulta de rol: quien decide es la Server Action, que sí tiene
--    la sesión delante. El navegador nunca manda esta bandera.
--
--    SOBRE UN SORTEO YA LIQUIDADO hay que reconciliar o el sorteo deja de
--    cuadrar: las líneas nuevas no estarían marcadas como ganadoras y la fila
--    de allan.liquidacion se quedaría con el total viejo. De ahí
--    `fn_recalcular_liquidacion`. Y si ese sorteo YA SE LE PAGÓ al vendedor en
--    un corte, no se admite venta ninguna: el monto pagado dejaría de
--    corresponder con lo liquidado y no habría forma de cuadrarlo hacia atrás.
--
-- 2. TANDA DE TICKETS
--    El vendedor de calle atiende una cola: cuatro personas, cuatro tickets,
--    una sola confirmación al final. Registrarlos uno a uno desde el navegador
--    deja la puerta abierta a que el tercero entre y el cuarto no, y a que el
--    vendedor no sepa cuál falló. Una función plpgsql ES una transacción: o
--    entra la tanda entera o no entra ninguno.
--
--    EL PREBLOQUEO NO ES ADORNO. `fn_registrar_ticket` ordena sus números de
--    forma ascendente dentro de cada ticket, lo que basta para una venta
--    suelta. Pero una tanda [[5],[3]] bloquearía el 5 y luego el 3, mientras
--    otra tanda simultánea [[3],[5]] haría lo contrario: interbloqueo. Tomar
--    de golpe, en orden, todos los números de la tanda antes del bucle lo
--    elimina.
-- ===========================================================================

alter table allan.ticket add column if not exists forzado boolean not null default false;

comment on column allan.ticket.forzado is
  'Registrado por administración con la venta ya cerrada. Se audita aparte y se distingue en pantalla.';

create index if not exists ticket_forzado on allan.ticket (sorteo_id) where forzado;

-- --- Reconciliar un sorteo liquidado ---------------------------------------

create or replace function allan.fn_recalcular_liquidacion(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo   allan.sorteo%rowtype;
  v_pagada   boolean;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
begin
  select * into v_sorteo from allan.sorteo where id = p_sorteo_id;

  if not found or v_sorteo.estado <> 'liquidado' then
    return;   -- no hay nada que reconciliar
  end if;

  -- Lo ya pagado no se toca. Si se admitiera, el corte que el vendedor firmó
  -- dejaría de coincidir con lo que dice la liquidación, y no hay manera
  -- honesta de arreglarlo después.
  select exists (
    select 1
    from allan.liquidacion lq
    join allan.corte_detalle d on d.liquidacion_id = lq.id
    where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id
  ) into v_pagada;

  if v_pagada then
    raise exception 'Ese sorteo ya se le pagó al vendedor; no admite más venta.'
      using errcode = 'check_violation';
  end if;

  -- Las líneas nuevas que acertaron, con el factor congelado de cada una.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null
    and l.numero = v_sorteo.numero_ganador
    and not l.gana;

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
    into v_venta, v_comision, v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios,
    v_venta - v_comision - v_premios
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;

  perform allan.fn_auditar('liquidacion', p_sorteo_id, 'recalcular', 'venta',
                           null, v_venta::text);
end;
$$;

comment on function allan.fn_recalcular_liquidacion(uuid, uuid) is
  'Rehace la liquidación de un vendedor en un sorteo ya liquidado. Rechaza si ese sorteo ya entró en un corte pagado.';

-- --- La venta ---------------------------------------------------------------
-- La firma cambia, así que hay que soltar la anterior: dejar las dos vivas
-- haría ambigua la llamada de ocho argumentos de fn_validar_lote_ocr.

drop function if exists allan.fn_registrar_ticket(
  uuid, uuid, jsonb, double precision, double precision, uuid,
  allan.canal_ticket, uuid
);

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null,
  p_forzar         boolean default false,
  p_usuario_id     uuid default null
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

  -- Un sorteo `programado` no tiene cupo sembrado: forzarlo fallaría más
  -- abajo con un mensaje que no explica nada.
  if v_sorteo.estado = 'programado' then
    raise exception 'El sorteo todavía no ha abierto.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Los dos cortes —el de estado y el de hora— sólo se levantan con p_forzar,
  -- que la Server Action pone a `true` únicamente para un administrador.
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
    lat, lng, dispositivo_id, lote_ocr_id, forzado
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total,
    coalesce(p_usuario_id, auth.uid()),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id, p_forzar
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

  if p_forzar then
    perform allan.fn_auditar('ticket', v_ticket_id, 'registrar_forzado', 'usuario',
                             v_sorteo.estado::text, coalesce(p_usuario_id::text, 'desconocido'));

    -- Sobre un sorteo ya liquidado, el ticket nuevo obliga a rehacer las
    -- cuentas de ese vendedor o el sorteo deja de cuadrar.
    if v_sorteo.estado = 'liquidado' then
      perform allan.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
    end if;
  end if;

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

comment on function allan.fn_registrar_ticket(uuid, uuid, jsonb, double precision, double precision, uuid, allan.canal_ticket, uuid, boolean, uuid) is
  'Registra una venta. p_forzar levanta el corte por estado y por hora, y sólo lo pone a true la Server Action para un administrador.';

-- --- La tanda ---------------------------------------------------------------

create or replace function allan.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null
) returns table (r_folio text, r_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_cuantos integer;
  v_lineas  jsonb;
  v_res     record;
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

  -- Tope de cordura. Una tanda de calle son cuatro o cinco tickets; cincuenta
  -- ya es un envío que conviene mirar antes de dejarlo pasar entero.
  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  -- Prebloqueo de TODOS los números de la tanda, en orden ascendente. Sin
  -- esto, dos tandas con los mismos números en distinto orden se interbloquean
  -- entre sí: cada fn_registrar_ticket ordena lo suyo, pero nadie ordena el
  -- conjunto.
  perform 1
  from allan.cupo_numero c
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
    from allan.fn_registrar_ticket(
      p_sorteo_id, p_vendedor_id, v_lineas,
      p_lat, p_lng, null,
      'movil'::allan.canal_ticket, null,
      p_forzar, p_usuario_id
    );

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;
    return next;
  end loop;

  return;
end;
$$;

comment on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid) is
  'Registra varios tickets en una sola transacción: o entran todos o no entra ninguno. Prebloquea los números de la tanda para no interbloquearse con otra.';

revoke execute on function allan.fn_recalcular_liquidacion(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid)
  from public, anon;
