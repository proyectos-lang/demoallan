-- ===========================================================================
-- Trazabilidad: quién hizo cada cambio, cuándo y qué movió.
--
-- LO QUE YA HABÍA Y LO QUE FALTABA
-- --------------------------------
-- La tabla `auditoria` lleva 2.681 apuntes con la entidad, la acción, el campo,
-- el valor anterior, el nuevo y la hora exacta. Todo correcto salvo una
-- columna: `usuario_id` está NULO en los 2.681.
--
-- La causa es `fn_auditar`, que lo saca de `auth.uid()`. Desde la 0024 la
-- aplicación habla con la base como `service_role`, así que `auth.uid()`
-- devuelve nulo siempre. Lleva grabando sin autor desde entonces.
--
-- Las funciones que auditan sí reciben quién las llamó —`p_usuario_id`, que
-- viene de la cookie firmada— pero no tenían cómo pasárselo.
--
-- QUÉ CAMBIA
-- ----------
-- `fn_auditar` gana un séptimo parámetro OPCIONAL con el usuario. Opcional a
-- propósito: hay más de treinta llamadas repartidas por veinte migraciones y
-- obligarlo rompería todas de golpe. Las que lo pasen quedan con autor; las
-- que no, se comportan como hasta ahora.
--
-- Y se pasa en las funciones donde más importa saber quién fue: corregir,
-- anular y capturar por totales. Son las que mueven dinero de una cifra a otra
-- sin dejar rastro en ningún papel.
--
-- LO VIEJO NO SE INVENTA. Los 2.681 apuntes anteriores se quedan sin autor: no
-- hay forma honesta de averiguarlo ahora, y rellenarlos con un usuario
-- cualquiera sería peor que dejarlos vacíos — la pantalla dirá «no registrado»
-- y se sabrá que es de antes.
-- ===========================================================================

/*
 * Se SUELTA la firma vieja antes de crear la nueva.
 *
 * `create or replace` no reemplaza una función cuando cambia su lista de
 * parámetros: crea OTRA. Sin este `drop` quedan las dos —la de seis argumentos
 * y la de siete— y toda llamada con seis se vuelve ambigua, porque encaja en
 * las dos. Postgres no elige la equivocada: rechaza, y como casi todo audita,
 * el sistema deja de registrar ventas.
 *
 * Es el mismo tropiezo que la 0067 con `fn_anular_ticket`. Se arregló en la
 * 0085 y se corrige aquí para que una instalación desde cero no lo repita.
 */
drop function if exists public.fn_auditar(text, uuid, text, text, text, text);

create or replace function public.fn_auditar(
  p_entidad        text,
  p_entidad_id     uuid,
  p_accion         text,
  p_campo          text default null,
  p_valor_anterior text default null,
  p_valor_nuevo    text default null,
  /*
   * Quién lo hizo. Opcional por compatibilidad: treinta llamadas repartidas
   * por veinte migraciones siguen sin pasarlo, y obligarlo las rompería todas.
   *
   * `auth.uid()` se conserva como respaldo, aunque hoy siempre da nulo bajo
   * `service_role`: si algún día la aplicación vuelve a hablar autenticada,
   * esto seguirá funcionando sin tocarlo.
   */
  p_usuario_id     uuid default null
) returns void
language sql
security definer
set search_path = public
as $auditar$
  insert into public.auditoria (
    entidad, entidad_id, accion, campo, valor_anterior, valor_nuevo, usuario_id
  ) values (
    p_entidad, p_entidad_id, p_accion, p_campo, p_valor_anterior, p_valor_nuevo,
    coalesce(p_usuario_id, auth.uid())
  );
$auditar$;

comment on function public.fn_auditar(text, uuid, text, text, text, text, uuid) is
  'Deja constancia de un cambio. El usuario se recibe por parámetro: auth.uid() es nulo desde que la aplicación habla como service_role (0024).';


-- ---------------------------------------------------------------------------
-- La consulta de trazabilidad.
--
-- Una fila por cambio, con el nombre de quien lo hizo ya resuelto y —cuando el
-- cambio es sobre una venta— el vendedor y el sorteo a los que pertenece. Sin
-- eso, un apunte dice «se editó la jugada del ticket 3f2a…» y hay que ir a
-- buscar de quién era.
-- ---------------------------------------------------------------------------
create or replace function public.fn_trazabilidad(
  p_desde     date,
  p_hasta     date,
  /* Nulo = todas. Si no, 'editar', 'anular', 'registrar'… */
  p_accion    text default null,
  /* Nulo = todas las entidades: ticket, venta_total, vendedor… */
  p_entidad   text default null,
  p_usuario_id uuid default null,
  p_limite    integer default 500
)
returns table (
  r_id             bigint,
  r_ocurrido_en    timestamptz,
  r_entidad        text,
  r_entidad_id     uuid,
  r_accion         text,
  r_campo          text,
  r_valor_anterior text,
  r_valor_nuevo    text,
  r_usuario_id     uuid,
  /* El nombre de quien lo hizo, o nulo si es de antes de la 0083. */
  r_usuario        text,
  r_rol            text,
  /* A quién afecta, cuando se puede saber: el vendedor de esa venta. */
  r_vendedor       text,
  r_codigo         text,
  /* El sorteo al que pertenece, para poder ubicarlo en el día. */
  r_fecha          date,
  r_hora           public.hora_sorteo
)
language sql
stable
security definer
set search_path = public
as $traza$
  select a.id,
         a.ocurrido_en,
         a.entidad,
         a.entidad_id,
         a.accion,
         a.campo,
         a.valor_anterior,
         a.valor_nuevo,
         a.usuario_id,
         u.nombre,
         u.rol::text,
         public.fn_rotulo(v.alias, v.nombre),
         v.codigo,
         s.fecha,
         s.hora
  from public.auditoria a
  left join public.usuario u on u.id = a.usuario_id
  /*
   * De qué venta se trata, según la entidad.
   *
   * Un apunte sobre `ticket` guarda el identificador del ticket; uno sobre
   * `venta_total`, el de la captura. Los dos llevan a un vendedor y a un
   * sorteo, pero por caminos distintos, así que se resuelven por separado y se
   * toma el que haya.
   */
  left join public.ticket t
         on a.entidad = 'ticket' and t.id = a.entidad_id
  left join public.venta_total vt
         on a.entidad = 'venta_total' and vt.id = a.entidad_id
  left join public.vendedor v
         on v.id = coalesce(
              t.vendedor_id,
              vt.vendedor_id,
              -- Un apunte sobre el propio vendedor o sus parámetros guarda su
              -- identificador directamente.
              case when a.entidad in ('vendedor', 'parametro_vendedor')
                   then a.entidad_id end
            )
  left join public.sorteo s
         on s.id = coalesce(t.sorteo_id, vt.sorteo_id)
  where (a.ocurrido_en at time zone 'America/Tegucigalpa')::date
          between p_desde and p_hasta
    and (p_accion is null or a.accion = p_accion)
    and (p_entidad is null or a.entidad = p_entidad)
    and (p_usuario_id is null or a.usuario_id = p_usuario_id)
  order by a.ocurrido_en desc, a.id desc
  limit greatest(p_limite, 1);
$traza$;

comment on function public.fn_trazabilidad(date, date, text, text, uuid, integer) is
  'Los cambios registrados en un rango, con quién los hizo y a qué venta afectan. Los anteriores a la 0083 no tienen autor: auth.uid() era nulo.';

revoke execute on function public.fn_trazabilidad(date, date, text, text, uuid, integer)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Qué acciones y qué personas hay en un rango, para poblar los filtros.
--
-- Se saca de lo que REALMENTE ocurrió y no de una lista fija: así el filtro
-- nunca ofrece una acción que no tuvo lugar —lo que deja la pantalla vacía sin
-- explicar por qué— ni se queda corto cuando se añade una nueva.
-- ---------------------------------------------------------------------------
create or replace function public.fn_trazabilidad_filtros(
  p_desde date,
  p_hasta date
)
returns table (
  r_tipo   text,     -- 'accion', 'entidad' o 'usuario'
  r_valor  text,     -- lo que va en el filtro
  r_rotulo text,     -- lo que se lee
  r_cuantos integer
)
language sql
stable
security definer
set search_path = public
as $filtros$
  with en_rango as (
    select a.*
    from public.auditoria a
    where (a.ocurrido_en at time zone 'America/Tegucigalpa')::date
            between p_desde and p_hasta
  )
  select 'accion', accion, accion, count(*)::integer
  from en_rango group by accion

  union all

  select 'entidad', entidad, entidad, count(*)::integer
  from en_rango group by entidad

  union all

  select 'usuario',
         coalesce(u.id::text, ''),
         coalesce(u.nombre, 'Sin registrar'),
         count(*)::integer
  from en_rango e
  left join public.usuario u on u.id = e.usuario_id
  group by u.id, u.nombre

  order by 1, 4 desc;
$filtros$;

comment on function public.fn_trazabilidad_filtros(date, date) is
  'Las acciones, entidades y personas que aparecen en un rango, con cuántas veces. Para poblar los filtros con lo que de verdad ocurrió.';

revoke execute on function public.fn_trazabilidad_filtros(date, date)
  from public, anon;


-- ===========================================================================
-- Y las funciones que más importa saber quién ejecutó.
--
-- Corregir una venta, corregir una captura, registrar un abono y quitarlo: son
-- las que mueven una cifra a otra sin que quede rastro en ningún papel. Todas
-- recibían ya `p_usuario_id` de la cookie firmada; lo único que faltaba era
-- pasárselo a `fn_auditar`.
--
-- Cuerpos íntegros de sus migraciones, con esa única línea cambiada en cada
-- llamada a la auditoría.
-- ===========================================================================


-- --- fn_editar_venta_total ---

create or replace function public.fn_editar_venta_total(
  p_id         uuid,
  p_venta      numeric,
  p_premios    numeric,
  p_nota       text default null,
  p_usuario_id uuid default null
) returns table (r_comision numeric, r_saldo numeric)
language plpgsql
security definer
set search_path = public
as $editar_total$
declare
  v_fila   public.venta_total%rowtype;
  v_estado public.estado_sorteo;
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_fila
  from public.venta_total where id = p_id
  for update;

  if not found then
    raise exception 'Esa captura no existe.'
      using errcode = 'no_data_found';
  end if;

  -- Una captura anulada no se corrige: ya no cuenta para nada, y «corregir»
  -- lo que está fuera de la cuenta sólo sirve para confundir a quien lea el
  -- histórico después. Para volver a tenerla, se captura de nuevo.
  if v_fila.anulado_en is not null then
    raise exception 'Esa captura está anulada; no se puede corregir.'
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_fila.sorteo_id
  for share;

  update public.venta_total
  set venta   = p_venta,
      premios = p_premios,
      nota    = nullif(btrim(coalesce(p_nota, '')), '')
  where id = p_id;

  -- Lo de antes y lo de después, en la auditoría: es lo que permite
  -- reconstruir con qué cifra se cuadró la hoja del vendedor ese día.
  if v_fila.venta <> p_venta then
    perform public.fn_auditar('venta_total', p_id, 'editar', 'venta',
                              v_fila.venta::text, p_venta::text, p_usuario_id);
  end if;

  if v_fila.premios <> p_premios then
    perform public.fn_auditar('venta_total', p_id, 'editar', 'premios',
                              v_fila.premios::text, p_premios::text, p_usuario_id);
  end if;

  if coalesce(v_fila.nota, '') <> coalesce(nullif(btrim(coalesce(p_nota, '')), ''), '') then
    perform public.fn_auditar('venta_total', p_id, 'editar', 'nota',
                              v_fila.nota, nullif(btrim(coalesce(p_nota, '')), ''), p_usuario_id);
  end if;

  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_fila.sorteo_id, v_fila.vendedor_id);
  end if;

  return query
  select round(p_venta * v_fila.comision_congelada, 2),
         round(p_venta - p_venta * v_fila.comision_congelada - p_premios, 2);
end;
$editar_total$;


-- --- fn_editar_venta ---

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
                            v_antes, v_despues, p_usuario_id);

  if nullif(btrim(coalesce(p_motivo, '')), '') is not null then
    perform public.fn_auditar('ticket', p_ticket_id, 'editar', 'motivo',
                              null, btrim(p_motivo), p_usuario_id);
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


-- --- fn_registrar_abono ---

create or replace function public.fn_registrar_abono(
  p_vendedor_id uuid,
  p_monto       numeric,
  p_fecha_pago  date default null,
  p_nota        text default null,
  p_usuario_id  uuid default null
)
returns table (
  r_abono_id  uuid,
  r_monto     numeric,
  r_pendiente numeric   -- lo que le queda debiendo DESPUÉS de este abono
)
language plpgsql
security definer
set search_path = public
as $abono$
declare
  v_id      uuid := gen_random_uuid();
  v_fecha   date := coalesce(p_fecha_pago, (now() at time zone 'America/Tegucigalpa')::date);
  v_deuda   numeric(14,2);
  v_abonado numeric(14,2);
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El abono tiene que ser mayor que cero.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago que todavía no ocurrió no se registra: casi siempre es un dedazo
  -- en el año, y una fecha futura descuadra cualquier corte por período.
  if v_fecha > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha de pago no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor where id = p_vendedor_id;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  /*
   * Lo que debe AHORA MISMO, recalculado aquí.
   *
   * Se bloquean los abonos vivos del vendedor para que dos personas cobrando a
   * la vez no lean el mismo pendiente y acepten cada una un abono que junto
   * con el otro se pasa de la deuda.
   */
  perform 1 from public.abono_vendedor
  where vendedor_id = p_vendedor_id and corte_id is null
  for update;

  select coalesce(sum(lq.venta - lq.comision - lq.premios), 0)
  into v_deuda
  from public.liquidacion lq
  where lq.vendedor_id = p_vendedor_id
    and not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    );

  select coalesce(sum(a.monto), 0)
  into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  /*
   * No se acepta más de lo que debe.
   *
   * Un abono mayor que la deuda deja al vendedor con saldo a favor, y este
   * módulo no sabe qué hacer con eso: lo arrastraría como un pendiente
   * negativo que nadie sabría leer. Si de verdad entregó de más, es un corte
   * con su ajuste y su motivo, que sí deja constancia de por qué.
   */
  if round(p_monto, 2) > (v_deuda - v_abonado) then
    raise exception 'El abono (%) pasa de lo que debe (%). Registre un corte si quiere cerrar con ajuste.',
      round(p_monto, 2), greatest(v_deuda - v_abonado, 0)
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.abono_vendedor (
    id, vendedor_id, monto, fecha_pago, nota, usuario_id
  ) values (
    v_id, p_vendedor_id, round(p_monto, 2), v_fecha,
    nullif(btrim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  perform public.fn_auditar('abono_vendedor', v_id, 'crear', 'monto',
                            null, round(p_monto, 2)::text, p_usuario_id);

  return query
  select v_id,
         round(p_monto, 2),
         round(v_deuda - v_abonado - p_monto, 2);
end;
$abono$;


-- --- fn_anular_abono ---

create or replace function public.fn_anular_abono(
  p_abono_id   uuid,
  p_motivo     text default null,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $anular$
declare
  v_fila public.abono_vendedor%rowtype;
begin
  select * into v_fila
  from public.abono_vendedor where id = p_abono_id
  for update;

  if not found then
    raise exception 'Ese abono no existe.'
      using errcode = 'no_data_found';
  end if;

  -- Un abono ya cerrado en un corte no se toca por aquí: su dinero está
  -- contado dentro de ese corte, y quitarlo dejaría el corte sin cuadrar.
  -- Para deshacerlo hay que deshacer el corte.
  if v_fila.corte_id is not null then
    raise exception 'Ese abono ya está incluido en un corte pagado; no se puede quitar por separado.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform public.fn_auditar('abono_vendedor', p_abono_id, 'anular', 'monto',
                            v_fila.monto::text,
                            nullif(btrim(coalesce(p_motivo, '')), ''), p_usuario_id);

  delete from public.abono_vendedor where id = p_abono_id;
end;
$anular$;
