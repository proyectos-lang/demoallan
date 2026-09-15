-- ===========================================================================
-- El autor, en las funciones que la 0083 dejó fuera.
--
-- LO QUE FALTABA
-- --------------
-- La 0083 dio a `fn_auditar` un parámetro para el usuario y lo pasó en cuatro
-- funciones: corregir una venta, corregir una captura, y los abonos. Al
-- comprobarlo sobre un día real quedó claro que era poco: de 429 apuntes, 427
-- seguían sin autor.
--
-- El grueso es `fn_registrar_ticket` —396 apuntes en un solo día— y con él se
-- iban las anulaciones y las capturas por totales. Todas reciben ya
-- `p_usuario_id` de la cookie firmada; sólo faltaba pasárselo.
--
-- Cuerpos íntegros de sus migraciones, con esa única línea cambiada en cada
-- llamada a la auditoría. Los delimitadores pasan a llevar nombre —`$anular$`
-- en vez de `$$`— por lo aprendido en la 0076: un editor que parte el archivo
-- por sentencias desempareja los `$$` desnudos.
-- ===========================================================================


-- --- fn_registrar_ticket ---
-- La venta. Es la que más apuntes genera: 396 en un solo día.

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


-- --- fn_anular_ticket ---
-- Anular una venta: quién la quitó es justo lo que se pregunta después.

create or replace function public.fn_anular_ticket(
  p_ticket_id  uuid,
  p_motivo     text,
  p_usuario_id uuid default null,
  p_forzar     boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $anular_ticket$
declare
  v_ticket public.ticket%rowtype;
  v_estado public.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from public.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  -- Un vendedor sólo puede anular lo suyo; administración, cualquiera.
  if not public.fn_es_servicio()
     and public.fn_rol_actual() is distinct from 'administrador'
     and v_ticket.vendedor_id is distinct from public.fn_vendedor_actual() then
    raise exception 'No tiene permiso para anular este ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_ticket.sorteo_id
  for share;

  /*
   * Fuera de un sorteo abierto hace falta `p_forzar`.
   *
   * La bandera la pone la Server Action después de comprobar que quien llama
   * es administrador, no el navegador: desde la 0024 la aplicación habla como
   * `service_role`, así que `fn_exige` retorna sin comprobar nada y la base no
   * sabe quién está al otro lado.
   *
   * `liquidado` ya no es un caso aparte que se rechace siempre: se trata como
   * los demás, y lo que lo vuelve seguro es la reconciliación de más abajo.
   */
  if v_estado <> 'abierto' and not p_forzar then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- Devolver el cupo, número por número en orden ascendente.
  for v_linea in
    select numero, sum(monto) as monto
    from public.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update public.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update public.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update public.ticket
  set anulado_en = now(),
      -- El parámetro primero: `auth.uid()` es NULL bajo service_role, y con él
      -- la restricción `ticket_anulacion_completa` rechaza el UPDATE entero.
      anulado_por = coalesce(p_usuario_id, auth.uid()),
      motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform public.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo,
                            p_usuario_id);

  /*
   * Y si el sorteo estaba liquidado, se rehace la cuenta del vendedor.
   *
   * VA DESPUÉS DEL UPDATE a propósito: `fn_recalcular_liquidacion` suma sólo
   * los tickets con `anulado_en is null`, así que si corriera antes volvería a
   * contar el que se acaba de quitar y no cambiaría nada.
   *
   * Es la misma transacción —una función plpgsql lo es—, de modo que o queda
   * anulado Y recalculado, o no queda nada. Un ticket anulado con la
   * liquidación sin rehacer es precisamente el descuadre que esto evita.
   *
   * Si ese sorteo ya entró en un corte pagado, la función lanza y la
   * anulación se deshace entera. Ahí el rechazo es lo correcto.
   */
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_ticket.sorteo_id, v_ticket.vendedor_id);
  end if;
end;
$anular_ticket$;


-- --- fn_registrar_venta_total ---
-- Capturar por totales. La 0049 ya lo intentó y tuvo que revertirlo: entonces la firma no admitía el usuario.

create or replace function public.fn_registrar_venta_total(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_venta       numeric,
  p_premios     numeric,
  p_nota        text default null,
  p_usuario_id  uuid default null
) returns table (r_id uuid, r_comision numeric, r_saldo numeric)
language plpgsql
security definer
set search_path = allan, public
as $venta_total$
declare
  v_comision numeric(6,5);
  v_id       uuid;
  v_estado   public.estado_sorteo;
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.';
  end if;

  select estado into v_estado from public.sorteo where id = p_sorteo_id;
  if v_estado is null then
    raise exception 'El sorteo no existe.';
  end if;

  -- El vendedor tiene que estar vivo: un dado de baja no genera venta nueva.
  perform 1 from public.vendedor
   where id = p_vendedor_id and activo and eliminado_en is null;
  if not found then
    raise exception 'El vendedor no está activo.';
  end if;

  select p.comision into v_comision
  from public.parametro_vendedor p
  where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null
  order by p.vigente_desde desc
  limit 1;

  if v_comision is null then
    raise exception 'El vendedor no tiene comisión vigente configurada.';
  end if;

  insert into public.venta_total (
    sorteo_id, vendedor_id, venta, premios, comision_congelada, nota, creado_por
  ) values (
    p_sorteo_id, p_vendedor_id, p_venta, p_premios, v_comision, nullif(btrim(p_nota), ''), p_usuario_id
  )
  returning id into v_id;

  perform public.fn_auditar(
    'venta_total', v_id, 'registrar', 'venta', null, p_venta::text, p_usuario_id
  );

  -- Si el sorteo ya estaba liquidado hay que rehacer su fila, o la captura no
  -- aparecería hasta que alguien reliquidara.
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
  end if;

  return query
  select v_id,
         round(p_venta * v_comision, 2),
         round(p_venta - p_venta * v_comision - p_premios, 2);
end;
$venta_total$;


-- --- fn_anular_venta_total ---
-- Anular una captura.

create or replace function public.fn_anular_venta_total(
  p_id         uuid,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $anular_total$
declare
  v_sorteo uuid;
  v_vend   uuid;
  v_estado public.estado_sorteo;
begin
  select vt.sorteo_id, vt.vendedor_id into v_sorteo, v_vend
  from public.venta_total vt
  where vt.id = p_id and vt.anulado_en is null;

  if v_sorteo is null then
    raise exception 'Esa captura no existe o ya estaba anulada.';
  end if;

  update public.venta_total set anulado_en = now() where id = p_id;

  perform public.fn_auditar('venta_total', p_id, 'anular', null, null, p_usuario_id::text,
                            p_usuario_id);

  select estado into v_estado from public.sorteo where id = v_sorteo;
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_sorteo, v_vend);
  end if;
end;
$anular_total$;


-- --- fn_registrar_corte ---
-- Cerrar el pago de una semana: ahí se entrega dinero, y quién lo cerró
-- es la primera pregunta cuando algo no cuadra.
--
-- `create or replace` basta: la salida no cambia respecto a la 0079, y
-- soltarla dejaría un hueco en el que una llamada en vuelo fallaría.

create or replace function public.fn_registrar_corte(
  p_vendedor_id     uuid,
  p_liquidacion_ids uuid[],
  p_desde           date,
  p_hasta           date,
  p_nota            text default null,
  p_usuario_id      uuid default null
) returns table (
  r_corte_id uuid,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_saldo    numeric,
  r_abonado  numeric,   -- lo que ya había entregado a cuenta
  r_resta    numeric    -- lo que le queda por entregar al cerrar: saldo − abonado
)
language plpgsql
security definer
set search_path = public
as $corte$
declare
  v_corte_id uuid := gen_random_uuid();
  v_ajenas   integer;
  v_sorteos  integer;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
  v_abonado  numeric(14,2);
begin
  -- Inerte bajo `service_role` (0024): la guarda real vive en la Server
  -- Action. Se conserva por coherencia con el resto de funciones.
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if p_liquidacion_ids is null or array_length(p_liquidacion_ids, 1) is null then
    raise exception 'No se eligió ningún sorteo para pagar.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se bloquean antes de sumarlas: si otra transacción está registrando un
  -- corte con alguna de ellas, ésta espera y luego choca contra el índice
  -- único, en vez de sumar sobre un dato que ya cambió debajo.
  perform 1
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
  order by lq.id
  for update;

  -- Ninguna liquidación ajena se cuela en el corte de otro vendedor.
  select count(*) into v_ajenas
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
    and lq.vendedor_id is distinct from p_vendedor_id;

  if v_ajenas > 0 then
    raise exception 'El corte incluye % liquidaciones de otro vendedor.', v_ajenas
      using errcode = 'invalid_parameter_value';
  end if;

  -- Los totales SIEMPRE se recalculan aquí. Lo que manda el navegador es una
  -- vista previa, no un dato: si llegara alterado, el corte guardaría una
  -- cifra que no corresponde a ningún sorteo.
  select count(*),
         coalesce(sum(lq.venta), 0),
         coalesce(sum(lq.comision), 0),
         coalesce(sum(lq.premios), 0)
    into v_sorteos, v_venta, v_comision, v_premios
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids);

  if v_sorteos <> array_length(p_liquidacion_ids, 1) then
    raise exception 'Alguna de las liquidaciones elegidas ya no existe.'
      using errcode = 'no_data_found';
  end if;

  insert into public.corte_vendedor (
    id, vendedor_id, desde, hasta, sorteos, venta, comision, premios, saldo,
    nota, usuario_id
  ) values (
    v_corte_id, p_vendedor_id, p_desde, p_hasta, v_sorteos,
    v_venta, v_comision, v_premios, v_venta - v_comision - v_premios,
    nullif(trim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  begin
    insert into public.corte_detalle (corte_id, liquidacion_id)
    select v_corte_id, unnest(p_liquidacion_ids);
  exception when unique_violation then
    raise exception 'Uno de los sorteos elegidos ya se había pagado. Vuelva a cargar el informe.'
      using errcode = 'check_violation';
  end;

  /*
   * LOS ABONOS VIVOS SE ABSORBEN EN ESTE CORTE.
   *
   * El vendedor ya entregó parte de esta deuda a cuenta. Ese dinero está
   * dentro del saldo que el corte da por cobrado, así que si los abonos
   * siguieran vivos se contarían dos veces: una en el corte y otra
   * descontando del pendiente.
   *
   * Se marcan con el corte y dejan de sumar por su cuenta. El apunte no se
   * borra —la fecha en que entregó cada parte es historia de caja— pero pasa
   * a estar contado aquí dentro.
   */
  select coalesce(sum(a.monto), 0) into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  update public.abono_vendedor
  set corte_id = v_corte_id
  where vendedor_id = p_vendedor_id and corte_id is null;

  perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'saldo',
                           null, (v_venta - v_comision - v_premios)::text, p_usuario_id);

  if v_abonado > 0 then
    perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'abonado',
                             null, v_abonado::text, p_usuario_id);
  end if;

  return query
    select v_corte_id, v_sorteos, v_venta, v_comision, v_premios,
           v_venta - v_comision - v_premios,
           v_abonado,
           v_venta - v_comision - v_premios - v_abonado;
end;
$corte$;


-- --- fn_guardar_parametros ---
-- Cambiar la comisión, el factor o el tope de un vendedor.
--
-- Ésta ni siquiera RECIBÍA el usuario: se apoyaba en `auth.uid()`, nulo desde
-- la 0024, tanto para la auditoría como para `creado_por`. Gana el parámetro,
-- opcional para no romper las llamadas que no lo pasen.
--
-- La firma cambia, así que hay que soltar la vieja: `create or replace` no
-- reemplaza una función cuando cambia su lista de parámetros —crea otra, y
-- entonces toda llamada se vuelve ambigua—. Es exactamente lo que acaba de
-- pasar con `fn_auditar` en la 0083 y hubo que arreglar en la 0085.

drop function if exists public.fn_guardar_parametros(uuid, numeric, numeric, numeric);

create or replace function public.fn_guardar_parametros(
  p_vendedor_id     uuid,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric,
  /* Quién lo cambia. No lo tenía: la auditoría quedaba sin autor. */
  p_usuario_id      uuid default null
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $parametros$
declare
  v_anterior public.parametro_vendedor%rowtype;
  v_nuevo_id uuid;
begin
  -- Sin esta guarda, un vendedor podía cambiarse su propia comisión.
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

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
  from public.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  for update;

  if found
     and v_anterior.comision = p_comision
     and v_anterior.factor_pago = p_factor_pago
     and v_anterior.tope_por_numero = p_tope_por_numero then
    return v_anterior.id;
  end if;

  if found then
    update public.parametro_vendedor
    set vigente_hasta = now()
    where id = v_anterior.id;
  end if;

  insert into public.parametro_vendedor (
    vendedor_id, comision, factor_pago, tope_por_numero, creado_por
  ) values (
    p_vendedor_id, p_comision, p_factor_pago, p_tope_por_numero,
    coalesce(p_usuario_id, auth.uid())
  )
  returning id into v_nuevo_id;

  perform public.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'comision',
    coalesce(v_anterior.comision::text, '—'), p_comision::text, p_usuario_id);
  perform public.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'factor_pago',
    coalesce(v_anterior.factor_pago::text, '—'), p_factor_pago::text, p_usuario_id);
  perform public.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'tope_por_numero',
    coalesce(v_anterior.tope_por_numero::text, '—'), p_tope_por_numero::text, p_usuario_id);

  return v_nuevo_id;
end;
$parametros$;
