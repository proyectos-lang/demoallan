-- ===========================================================================
-- Hora de Honduras en los mensajes, y el simulador de escenarios.
--
-- EL HUSO NO ES COSMÉTICO
-- ------------------------
-- Los timestamptz se guardan en UTC, que es lo correcto. Pero al MOSTRARLOS
-- hay que convertirlos: el mensaje decía «cerró a las 20:50» cuando en
-- Honduras fueron las 14:50. A un vendedor al que se le rechaza una venta con
-- una hora que no reconoce no le queda forma de saber si se equivocó él o el
-- sistema.
--
-- La conversión va explícita a America/Tegucigalpa (UTC−6 todo el año, sin
-- horario de verano) y no al huso del servidor, que en producción es UTC.
-- ===========================================================================

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
    raise exception 'La venta de este sorteo cerró a las % (hora de Honduras).',
      to_char(v_sorteo.hora_cierre at time zone 'America/Tegucigalpa', 'HH24:MI')
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

-- ===========================================================================
-- Simulador de escenarios (Fase 4)
--
-- Recorre las líneas históricas y las recalcula con una comisión y un factor
-- alternos, mes por mes.
--
-- POR QUÉ ES EXACTO Y NO UNA APROXIMACIÓN
-- ---------------------------------------
-- El prototipo reescalaba los premios con una regla de tres sobre el factor
-- promedio ponderado del rango, porque sólo tenía agregados. Aquí tenemos las
-- líneas: el premio simulado es la suma de los montos GANADORES multiplicada
-- por el factor alterno. Sin promedios y sin error de aproximación.
--
-- SU SUPUESTO, QUE NO ES PEQUEÑO
-- ------------------------------
-- Se asume que el volumen de venta no cambia. Es una referencia cuantitativa
-- de qué habría pasado con otros parámetros sobre las mismas apuestas, no un
-- pronóstico: en la realidad, cambiar la comisión cambia el comportamiento de
-- los vendedores, y cambiar el factor cambia el de los apostadores.
--
-- Sólo entran sorteos LIQUIDADOS. Uno sin liquidar no tiene número ganador, y
-- sin él no hay premio que recalcular.
-- ===========================================================================

create or replace function allan.fn_simular(
  p_desde    date,
  p_hasta    date,
  p_comision numeric,   -- fracción: 0.13 para 13 %
  p_factor   numeric
) returns table (
  anio           integer,
  mes            integer,
  dias           integer,
  venta          numeric,
  comision_real  numeric,
  premios_real   numeric,
  utilidad_real  numeric,
  comision_sim   numeric,
  premios_sim    numeric,
  utilidad_sim   numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from s.fecha)::integer,
         extract(month from s.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         count(distinct s.fecha)::integer,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         -- Comisión alterna sobre la misma venta.
         sum(l.monto) * p_comision,
         -- Premio alterno: los mismos aciertos, con otro factor.
         sum(l.monto) filter (where l.gana) * p_factor,
         sum(l.monto)
           - sum(l.monto) * p_comision
           - coalesce(sum(l.monto) filter (where l.gana), 0) * p_factor
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and s.estado = 'liquidado'
    and t.anulado_en is null
  group by 1, 2
  order by 1, 2;
$$;

-- --- Los parámetros reales del rango, ponderados por venta -----------------
-- Es la referencia contra la que se compara el escenario: no sirve el promedio
-- simple de los vendedores, porque uno que vende poco no debe pesar igual que
-- uno que vende mucho.

create or replace function allan.fn_parametros_ponderados(
  p_desde date,
  p_hasta date
) returns table (
  comision_ponderada numeric,
  factor_ponderado   numeric,
  venta              numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select case when sum(l.monto) > 0
              then sum(l.monto * l.comision_congelada) / sum(l.monto)
              else 0 end,
         case when sum(l.monto) filter (where l.gana) > 0
              then sum(l.premio) / sum(l.monto) filter (where l.gana)
              else 0 end,
         coalesce(sum(l.monto), 0)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and s.estado = 'liquidado'
    and t.anulado_en is null;
$$;
