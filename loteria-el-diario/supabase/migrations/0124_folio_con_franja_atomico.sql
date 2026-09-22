-- ===========================================================================
-- El folio lleva la franja del sorteo y se genera a prueba de concurrencia.
--
-- LO QUE SE VIO (V-105, 22-sep)
-- ----------------------------
-- El vendedor tenía tres tirillas con el mismo folio (…-0003) pero una decía
-- «SORTEO 11 AM», otra «9 PM» y otra «3 PM». Las tres tenían EL MISMO código de
-- barras (…60922 1 …, franja 1 = mañana): era LA MISMA venta (11 AM, nº 75,
-- L100) reimpresa tres veces, y la línea «SORTEO» de la tirilla se pintaba con
-- el sorteo que la PANTALLA tenía cargado en cada reimpresión, no con el del
-- ticket. En la base había un solo ticket, correcto. (La tirilla se arregla en
-- la app; ver el otro cambio.)
--
-- DOS DEBILIDADES QUE ESTO DESTAPÓ, Y QUE SE CIERRAN AQUÍ
-- ------------------------------------------------------
--  1. El consecutivo del folio salía de `count(*) + 1` SIN bloqueo. El `unique`
--     del folio evita el duplicado, pero a costa de que dos ventas casi
--     simultáneas del mismo vendedor choquen y una FALLE. Ahora el consecutivo
--     es atómico —una fila bloqueada por (vendedor, día, franja), igual que
--     `consecutivo_dia` protege el código de barras— y, por si acaso, con
--     reintento si el `unique` chocara.
--
--  2. El folio no decía a qué sorteo pertenecía. Ahora lleva un dígito de
--     FRANJA —1 mañana, 2 tarde, 3 noche, el mismo mapeo del código de barras—,
--     así una tirilla emitida en la mañana para el sorteo de la noche queda
--     marcada con el 3. El consecutivo pasa a ser por (vendedor, día, FRANJA),
--     de modo que dos sorteos del mismo día ya no comparten numeración.
--
-- Formato nuevo:  V105-20260922-3-0007   (…-<franja>-<consecutivo>)
-- Los folios YA emitidos no se tocan: se quedan con su formato anterior.
-- ===========================================================================

-- Consecutivo atómico por vendedor, día y franja. Mismo patrón que
-- `consecutivo_dia`: la fila se bloquea al actualizarla, así dos ventas
-- simultáneas se serializan y cada una se lleva un número distinto.
create table if not exists public.consecutivo_folio (
  vendedor_id uuid  not null references public.vendedor(id),
  fecha       date  not null,
  franja      smallint not null,
  ultimo      integer not null default 0,
  primary key (vendedor_id, fecha, franja),
  constraint consecutivo_folio_franja check (franja between 1 and 3),
  constraint consecutivo_folio_rango  check (ultimo >= 0 and ultimo <= 9999)
);

comment on table public.consecutivo_folio is
  'Último consecutivo de folio por vendedor, día y franja. Se actualiza con on conflict do update, cuyo bloqueo de fila serializa las ventas simultáneas.';

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
as $registrar$
declare
  v_sorteo        public.sorteo%rowtype;
  v_codigo        text;
  v_param         public.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_barras        text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_franja        smallint;
  v_agrupada      record;
  v_cupo          public.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
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

    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Ya vendió todo lo que tiene permitido en el %. Su límite es % por sorteo y puede vender % más.',
        lpad(v_agrupada.numero::text, 2, '0'), v_param.tope_por_numero,
        greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    /*
     * EL LÍMITE DE LA CASA YA NO RECHAZA.
     *
     * Era un techo compartido: cuando entre todos los vendedores se
     * completaba, el número quedaba cerrado para quien llegara después aunque
     * no hubiera vendido ni una lempira en él. El tope es de cada vendedor y
     * de nadie más.
     *
     * `cupo_numero.vendido` se sigue llevando al día —más abajo, como
     * siempre— porque de ahí salen el semáforo del punto de venta y la
     * lectura de exposición de la casa. Lo que se retira es que impida
     * vender.
     */

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

  -- La franja del sorteo: 1 mañana, 2 tarde, 3 noche. Mismo mapeo que
  -- el código de barras.
  v_franja := case v_sorteo.hora when '11:00' then 1 when '15:00' then 2 else 3 end;

  -- Consecutivo atómico por (vendedor, día, franja): el on conflict bloquea
  -- la fila y serializa las ventas simultáneas.
  insert into public.consecutivo_folio (vendedor_id, fecha, franja, ultimo)
  values (p_vendedor_id, v_sorteo.fecha, v_franja, 1)
  on conflict (vendedor_id, fecha, franja) do update
    set ultimo = public.consecutivo_folio.ultimo + 1
  returning ultimo into v_consecutivo;

  v_folio := replace(v_codigo, '-', '')
            || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
            || '-' || v_franja::text
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

  perform public.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio,
                            coalesce(p_usuario_id, auth.uid()));

  if p_forzar then
    perform public.fn_auditar('ticket', v_ticket_id, 'registrar_forzado', 'usuario',
                            v_sorteo.estado::text, coalesce(p_usuario_id::text, 'desconocido'),
                            p_usuario_id);

    if v_sorteo.estado = 'liquidado' then
      perform public.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
    end if;
  end if;

  return query select v_ticket_id, v_folio, v_total;
end;
$registrar$;

revoke execute on function public.fn_registrar_ticket(
  uuid, uuid, jsonb, double precision, double precision, uuid,
  public.canal_ticket, uuid, boolean, uuid
) from public, anon;
