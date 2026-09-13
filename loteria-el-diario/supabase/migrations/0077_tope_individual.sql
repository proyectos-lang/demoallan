-- ===========================================================================
-- El tope por número es de CADA VENDEDOR. Nunca se comparte.
--
-- LO QUE PASABA
-- -------------
-- Vendedores reportaron que no les dejaba vender el 94 «aunque no lo hubieran
-- vendido». Tenían razón, y el sistema hacía lo que estaba escrito: además
-- del tope de cada vendedor había un SEGUNDO techo, `cupo_numero.limite_casa`,
-- compartido por todos.
--
-- En el sorteo de las 11:00 del 13 de septiembre el 94 lo jugaron DIECIOCHO
-- vendedores distintos y entre todos completaron los 4.000 de la casa. A
-- partir de ahí el número quedó cerrado para todo el mundo —incluidos los que
-- no habían vendido nada en él—, y el rechazo decía «cupo agotado», que
-- cualquiera lee como «ya vendiste lo tuyo».
--
-- Los contadores estaban bien: se compararon los 300 números del día contra
-- las líneas vivas, sin un solo descuadre. Lo que estaba mal era la regla.
--
-- QUÉ CAMBIA
-- ----------
-- El límite de la casa DEJA DE RECHAZAR. Si un vendedor tiene 300 por número,
-- esos 300 son suyos y los puede vender íntegros, sin importar cuánto hayan
-- vendido los demás en ese mismo número.
--
-- El tope de cada vendedor sigue siendo el único que decide. Su mensaje ahora
-- dice cuál es el límite y cuánto le queda, para que se entienda de quién es
-- el techo que se alcanzó.
--
-- LO QUE NO CAMBIA
-- ----------------
-- `cupo_numero.vendido` se sigue llevando al día en cada venta. De ahí salen
-- el semáforo del punto de venta y la lectura de exposición de la casa, y
-- siguen siendo útiles: saber cuánto se lleva vendido en un número es
-- información de gestión aunque ya no cierre la puerta a nadie.
--
-- `limite_casa` se conserva en la tabla por la misma razón —es la referencia
-- contra la que se mide esa exposición— y porque borrar una columna con
-- histórico para no ganar nada sería un cambio más grande que el problema que
-- resuelve.
--
-- CUERPO ÍNTEGRO DE LA 0061 con ese rechazo retirado. El resto de la función
-- —el orden de bloqueo ascendente, la cuota por dispositivo, la venta forzada,
-- la reconciliación— queda intacto.
-- ===========================================================================

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
$registrar$;


-- ---------------------------------------------------------------------------
-- Y lo mismo al CORREGIR una venta.
--
-- `fn_editar_venta` (0075) traía la misma comprobación contra el límite de la
-- casa. Si se quita al vender pero se deja al corregir, una venta que entró
-- legítimamente no se podría arreglar después: el sistema aceptaría el error y
-- rechazaría la corrección, que es el peor de los dos mundos.
--
-- Cuerpo íntegro de la 0075 con ese rechazo retirado. El bloqueo de la fila de
-- cupo se conserva —hay que actualizarla igual, y el orden ascendente evita el
-- interbloqueo—; lo que se va es el límite que impedía escribir.
-- ---------------------------------------------------------------------------

create or replace function public.fn_editar_venta(
  p_ticket_id  uuid,
  /* `[{ "numero": 7, "monto": 100 }, ...]` — las líneas que quedan. */
  p_lineas     jsonb,
  p_motivo     text default null,
  p_usuario_id uuid default null
) returns table (r_total numeric, r_lineas integer)
language plpgsql
security definer
set search_path = public
as $editar$
declare
  v_ticket   public.ticket%rowtype;
  v_estado   public.estado_sorteo;
  v_param    public.parametro_vendedor%rowtype;
  v_antes    text;
  v_despues  text;
  v_total    numeric(14,2);
  v_cuantas  integer;
  v_linea    record;
  v_disp     numeric(14,2);
  v_propio   numeric(14,2);
begin
  select * into v_ticket
  from public.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % está anulado; no se puede corregir.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  -- Al menos una línea: un ticket sin líneas no es una corrección, es una
  -- anulación, y para eso está `fn_anular_ticket` — que devuelve el cupo y
  -- deja constancia de quién y por qué.
  select count(*) into v_cuantas
  from jsonb_array_elements(coalesce(p_lineas, '[]'::jsonb));

  if v_cuantas = 0 then
    raise exception 'Una venta corregida tiene que quedar con al menos un número. Para dejarla sin nada, anúlela.'
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_ticket.sorteo_id
  for share;

  select * into v_param
  from public.parametro_vendedor
  where vendedor_id = v_ticket.vendedor_id and vigente_hasta is null
  limit 1;

  if not found then
    raise exception 'Ese vendedor no tiene parámetros vigentes.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- La jugada de ANTES, para la auditoría. Se arma ahora, mientras existe.
  select string_agg(lpad(numero::text, 2, '0') || ':' || monto::text, '  ' order by numero, monto)
  into v_antes
  from public.linea where ticket_id = p_ticket_id;

  /*
   * Se devuelve el cupo VIEJO antes de tocar nada.
   *
   * En orden ascendente de número, como el resto del sistema: es lo que evita
   * el interbloqueo entre dos transacciones que tocan los mismos números en
   * distinto orden.
   */
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

  delete from public.linea where ticket_id = p_ticket_id;

  -- Y se consume el nuevo, comprobando el tope de cada número igual que haría
  -- una venta corriente.
  for v_linea in
    select (e->>'numero')::smallint as numero,
           sum((e->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) e
    group by (e->>'numero')::smallint
    order by 1
  loop
    if v_linea.numero < 0 or v_linea.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_linea.numero
        using errcode = 'invalid_parameter_value';
    end if;
    if v_linea.monto <= 0 then
      raise exception 'El monto del número % tiene que ser mayor que cero.', v_linea.numero
        using errcode = 'invalid_parameter_value';
    end if;

    /*
     * Se bloquea la fila de cupo, pero su límite ya NO rechaza.
     *
     * El `limite_casa` era un techo compartido entre todos los vendedores, y
     * se retiró en la 0077: el tope es de cada quien. Aquí se conserva el
     * `for update` porque la fila hay que bloquearla igual —más abajo se le
     * suma lo corregido— y el orden ascendente de número es lo que evita el
     * interbloqueo.
     */
    select 1 into v_disp
    from public.cupo_numero c
    where c.sorteo_id = v_ticket.sorteo_id and c.numero = v_linea.numero
    for update;

    if v_disp is null then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_linea.numero
        using errcode = 'no_data_found';
    end if;

    -- El tope del vendedor, contando lo que ya tiene en OTROS tickets vivos:
    -- si no, corregir sería la forma de superarlo por partes.
    select coalesce(sum(l.monto), 0) into v_propio
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = v_ticket.sorteo_id
      and t.vendedor_id = v_ticket.vendedor_id
      and t.anulado_en is null
      and t.id <> p_ticket_id
      and l.numero = v_linea.numero;

    if v_propio + v_linea.monto > v_param.tope_por_numero then
      raise exception 'El número % pasa el tope del vendedor (% por número).',
        lpad(v_linea.numero::text, 2, '0'), v_param.tope_por_numero
        using errcode = 'check_violation';
    end if;

    update public.cupo_numero
    set vendido = vendido + v_linea.monto
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update public.cuota_dispositivo
      set consumido = consumido + v_linea.monto
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  /*
   * Las líneas nuevas, con la comisión y el factor VIGENTES.
   *
   * Es una diferencia real con el ticket original, que los congeló el día de
   * la venta. Se asume a propósito: corregir es un acto de hoy, y arrastrar
   * los valores viejos obligaría a guardarlos por línea para saber cuáles eran
   * —dato que no existe una vez borradas—. Si los parámetros cambiaron entre
   * medias, la corrección usa los de ahora y la auditoría deja la jugada
   * anterior para poder reconstruirlo.
   */
  insert into public.linea (
    ticket_id, numero, monto, comision_congelada, factor_congelado
  )
  select p_ticket_id,
         (e->>'numero')::smallint,
         (e->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) e;

  select coalesce(sum(monto), 0), count(*)::integer
  into v_total, v_cuantas
  from public.linea where ticket_id = p_ticket_id;

  update public.ticket set total = v_total where id = p_ticket_id;

  select string_agg(lpad(numero::text, 2, '0') || ':' || monto::text, '  ' order by numero, monto)
  into v_despues
  from public.linea where ticket_id = p_ticket_id;

  -- La auditoría guarda la jugada ENTERA de antes y de después. Es lo único
  -- que permite reconstruir qué decía la tirilla que tiene el cliente.
  perform public.fn_auditar('ticket', p_ticket_id, 'editar', 'jugada',
                            v_antes, v_despues);

  if nullif(btrim(coalesce(p_motivo, '')), '') is not null then
    perform public.fn_auditar('ticket', p_ticket_id, 'editar', 'motivo',
                              null, btrim(p_motivo));
  end if;

  /*
   * Si el sorteo ya estaba liquidado, se rehace la cuenta del vendedor.
   *
   * Va al final, con las líneas nuevas ya escritas: `fn_recalcular_liquidacion`
   * marca las ganadoras y rehace la fila de `liquidacion` a partir de lo que
   * hay. Y rechaza si ese sorteo entró en un corte pagado, deshaciendo la
   * edición entera — una venta corregida sobre dinero ya entregado dejaría el
   * corte sin cuadrar con nada.
   */
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_ticket.sorteo_id, v_ticket.vendedor_id);
  end if;

  return query select v_total, v_cuantas;
end;
$editar$;

comment on function public.fn_editar_venta(uuid, jsonb, text, uuid) is
  'Corrige las líneas de una venta. No toca folio, vendedor ni sorteo. Rehace el cupo entero, comprueba el tope y reconcilia la liquidación si el sorteo estaba liquidado.';

revoke execute on function public.fn_editar_venta(uuid, jsonb, text, uuid)
  from public, anon;
