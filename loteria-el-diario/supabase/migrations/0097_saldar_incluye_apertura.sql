-- ===========================================================================
-- Saldar el arrastre cierra también el saldo de apertura.
--
-- POR QUÉ HACE FALTA
-- ------------------
-- La 0096 hace que el saldo con el que un vendedor entra al sistema aparezca
-- en la columna «anterior» de la liquidación. Falta poder COBRARLO.
--
-- `fn_saldar_arrastre` cierra la deuda vieja metiendo en un corte todos los
-- sorteos impagos anteriores a la semana. Un vendedor recién creado no tiene
-- ninguno: la función se encuentra el arreglo vacío y rechaza con «ese
-- vendedor no arrastra nada», justo a quien acabamos de cargarle una deuda de
-- la libreta anterior. Quedaría un saldo visible que no hay forma de cerrar,
-- que es exactamente el problema que la 0069 vino a resolver para los sorteos.
--
-- CÓMO SE CIERRA UN SALDO QUE NO TIENE SORTEOS
-- --------------------------------------------
-- Marcándolo como saldado, con la fecha y el corte que lo cerró. No se
-- fabrican filas de `corte_detalle` —no hay liquidación a la que apuntar— y
-- por eso el saldo de apertura lleva sus propias columnas de cierre. La 0096
-- filtra por `saldado_en is null`, así que en cuanto se marca, deja de sumar
-- al arrastre por la misma vía que ya usaba.
--
-- EL CORTE DICE LA VERDAD DE LO QUE COBRA
-- ---------------------------------------
-- El saldo de apertura entra en el `saldo` del corte, para que la entrega se
-- compare contra el total real de lo que se está cobrando. Pero NO se suma a
-- `venta`, `comision` ni `premios`: esas tres columnas son de venta, y este
-- dinero no lo es. Un corte de un vendedor nuevo sale con venta cero y saldo
-- 4.500, que es precisamente lo que pasó.
--
-- La `nota` lo dice para quien lea el corte sin conocer esta migración.
-- ===========================================================================

alter table public.saldo_inicial
  add column if not exists saldado_en timestamptz,
  add column if not exists saldado_corte_id uuid references public.corte_vendedor(id) on delete set null;

comment on column public.saldo_inicial.saldado_en is
  'Cuándo se cobró. Mientras sea nulo, este saldo sigue sumando al arrastre.';

comment on column public.saldo_inicial.saldado_corte_id is
  'El corte que lo cerró. `on delete set null` para que reversar el corte devuelva el saldo al arrastre en vez de perderlo.';

-- El índice de «uno vivo por vendedor» tiene que seguir valiendo para los
-- saldados: uno ya cobrado no debe impedir cargar el siguiente.
drop index if exists public.saldo_inicial_uno_vivo;
create unique index if not exists saldo_inicial_uno_vivo
  on public.saldo_inicial (vendedor_id)
  where anulado_en is null and saldado_en is null;


create or replace function public.fn_saldar_arrastre(
  p_vendedor_id uuid,
  p_desde       date,
  p_entrega     numeric,
  p_fecha_pago  date default null,
  p_motivo      text default null,
  p_usuario_id  uuid default null
)
returns table (
  r_corte_id uuid,
  r_sorteos  integer,
  r_saldo    numeric,
  r_entrega  numeric,
  r_ajuste   numeric
)
language plpgsql
security definer
set search_path = public
as $saldar$
declare
  v_corte_id uuid := gen_random_uuid();
  v_ids      uuid[];
  v_sorteos  integer;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
  v_saldo    numeric(14,2);
  v_ajuste   numeric(14,2);
  v_fecha    date := coalesce(p_fecha_pago, (now() at time zone 'America/Tegucigalpa')::date);
  v_desde    date;
  v_hasta    date;
  v_apertura_id    uuid;
  v_apertura       numeric(14,2) := 0;
  v_apertura_fecha date;
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if p_entrega is null then
    raise exception 'Escriba cuánto entregó el vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago que todavía no ocurrió no se registra: casi siempre es un dedazo
  -- en el año, y una fecha futura descuadraría cualquier corte por período.
  if v_fecha > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha de pago no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * El saldo de apertura vivo, si lo hay. Se bloquea igual que las
   * liquidaciones: dos administradores cobrando a la vez tienen que
   * encontrarse, no sumar cada uno sobre un dato que el otro ya cambió.
   */
  select id, monto, vigente_desde
    into v_apertura_id, v_apertura, v_apertura_fecha
  from public.saldo_inicial
  where vendedor_id = p_vendedor_id
    and anulado_en is null
    and saldado_en is null
    and vigente_desde < p_desde
  for update;

  if not found then
    v_apertura := 0;
  end if;

  /*
   * Se toman y se BLOQUEAN las liquidaciones del arrastre.
   *
   * El bloqueo importa: si otro administrador está registrando un corte con
   * alguno de estos sorteos, ésta espera y luego choca contra el índice único
   * de `corte_detalle`, en vez de sumar sobre un dato que ya cambió debajo.
   */
  select array_agg(lq.id order by lq.id)
  into v_ids
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  where lq.vendedor_id = p_vendedor_id
    and s.fecha < p_desde
    and not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    );

  -- Ahora hay dos formas de arrastrar algo: sorteos viejos sin pagar, o el
  -- saldo con el que entró al sistema. Sólo se rechaza si no hay ninguna.
  if v_ids is null and v_apertura = 0 then
    raise exception 'Ese vendedor no arrastra nada de semanas anteriores.'
      using errcode = 'no_data_found';
  end if;

  if v_ids is not null then
    perform 1
    from public.liquidacion lq
    where lq.id = any (v_ids)
    order by lq.id
    for update;
  end if;

  -- Los totales se recalculan AQUÍ, siempre. Lo que venga del navegador es una
  -- vista previa: si llegara alterado, el corte guardaría una cifra que no
  -- corresponde a ningún sorteo.
  select coalesce(count(*), 0),
         coalesce(sum(lq.venta), 0),
         coalesce(sum(lq.comision), 0),
         coalesce(sum(lq.premios), 0),
         min(s.fecha),
         max(s.fecha)
    into v_sorteos, v_venta, v_comision, v_premios, v_desde, v_hasta
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  where v_ids is not null and lq.id = any (v_ids);

  /*
   * El saldo suma las dos cosas; la venta NO.
   *
   * Un saldo de apertura es una cuenta traída de la libreta anterior, no un
   * dinero que se vendió. Meterlo en `venta` haría que cualquier informe que
   * sume los cortes dijera que se vendió algo que nadie vendió.
   */
  v_saldo  := (v_venta - v_comision - v_premios) + v_apertura;
  v_ajuste := round(p_entrega, 2) - v_saldo;

  -- Sin sorteos, el rango del corte es el de la apertura: un corte tiene que
  -- decir qué período cubre, y con `null` no se podría ni ordenar ni imprimir.
  v_desde := coalesce(v_desde, v_apertura_fecha, v_fecha);
  v_hasta := coalesce(v_hasta, v_apertura_fecha, v_fecha);

  -- Con ajuste hay que decir por qué. Un descuadre sin explicación es lo que
  -- nadie sabe justificar tres meses después, y es justo cuando se pregunta.
  if v_ajuste <> 0 and nullif(btrim(coalesce(p_motivo, '')), '') is null then
    raise exception 'La entrega no coincide con el saldo (diferencia de %). Escriba el motivo.', v_ajuste
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.corte_vendedor (
    id, vendedor_id, desde, hasta, sorteos, venta, comision, premios, saldo,
    entrega, ajuste, motivo_ajuste, nota, pagado_en, usuario_id
  ) values (
    v_corte_id, p_vendedor_id,
    -- El rango REAL de lo que se paga, no la semana que se estaba mirando:
    -- del sorteo más viejo sin pagar al último anterior a `p_desde`.
    v_desde, v_hasta, v_sorteos,
    v_venta, v_comision, v_premios, v_saldo,
    round(p_entrega, 2), v_ajuste,
    nullif(btrim(coalesce(p_motivo, '')), ''),
    case
      when v_apertura <> 0 and v_sorteos = 0 then 'Saldo inicial de apertura'
      when v_apertura <> 0 then 'Saldo de semanas anteriores, con el saldo inicial'
      else 'Saldo de semanas anteriores'
    end,
    -- La fecha del pago, a mediodía: guardar 00:00 hace que un cambio de zona
    -- horaria lo empuje al día anterior.
    (v_fecha + time '12:00') at time zone 'America/Tegucigalpa',
    p_usuario_id
  );

  if v_ids is not null then
    begin
      insert into public.corte_detalle (corte_id, liquidacion_id)
      select v_corte_id, unnest(v_ids);
    exception when unique_violation then
      raise exception 'Parte de ese arrastre ya se había pagado. Vuelva a cargar el informe.'
        using errcode = 'check_violation';
    end;
  end if;

  -- Y el saldo de apertura queda cerrado, apuntando al corte que lo cobró.
  if v_apertura_id is not null then
    update public.saldo_inicial
    set saldado_en = now(),
        saldado_corte_id = v_corte_id
    where id = v_apertura_id;

    perform public.fn_auditar('saldo_inicial', v_apertura_id, 'saldar',
                              'monto', v_apertura::text, null, p_usuario_id);
  end if;

  perform public.fn_auditar('corte_vendedor', v_corte_id, 'saldar_arrastre',
                            'entrega', v_saldo::text, round(p_entrega, 2)::text,
                            p_usuario_id);

  -- El ajuste se audita APARTE del pago: es la parte que alguien va a querer
  -- revisar, y buscarla dentro de una entrada de pago sería esconderla.
  if v_ajuste <> 0 then
    perform public.fn_auditar('corte_vendedor', v_corte_id, 'ajustar',
                              'ajuste', null,
                              v_ajuste::text || ' — ' || btrim(p_motivo),
                              p_usuario_id);
  end if;

  return query select v_corte_id, v_sorteos, v_saldo, round(p_entrega, 2), v_ajuste;
end;
$saldar$;

comment on function public.fn_saldar_arrastre(uuid, date, numeric, date, text, uuid) is
  'Cierra de una vez lo que un vendedor arrastra: sorteos viejos sin pagar y el saldo con el que entró al sistema. La entrega puede diferir del saldo; la diferencia queda como ajuste con su motivo.';

revoke execute on function public.fn_saldar_arrastre(uuid, date, numeric, date, text, uuid)
  from public, anon;


-- --------------------------------------------------------------------------
-- Reversar un corte devuelve el saldo de apertura al arrastre.
--
-- EL FALLO QUE ESTO EVITA, Y QUE NO SE VERÍA
-- ------------------------------------------
-- `fn_reversar_corte` borra el corte. La referencia `saldado_corte_id` es
-- `on delete set null`, así que se quedaría en nulo sola… pero `saldado_en`
-- NO, y la 0096 filtra por `saldado_en is null`. Resultado: el corte
-- desaparece, el vendedor deja de tener ese pago registrado, y su saldo de
-- apertura queda marcado como cobrado para siempre. Cuatro mil quinientos
-- lempiras evaporados sin que nada falle ni nadie se entere.
--
-- Se limpian las dos columnas, y va ANTES de borrar el corte: después ya no
-- habría con qué encontrar el saldo que ese corte cerró.
--
-- Se reescribe la función entera porque Postgres no deja cambiar una línea. El
-- cuerpo es el de la 0084, con este bloque añadido.
-- --------------------------------------------------------------------------

create or replace function public.fn_reversar_corte(
  p_corte_id   uuid,
  p_motivo     text default null,
  p_usuario_id uuid default null
)
returns table (
  r_sorteos integer,
  r_abonos  integer,
  r_saldo   numeric,
  r_desde   date,
  r_hasta   date
)
language plpgsql
security definer
set search_path = public
as $reversar$
declare
  v_corte   public.corte_vendedor%rowtype;
  v_sorteos integer;
  v_abonos  integer;
  v_aperturas integer;
begin
  select * into v_corte
  from public.corte_vendedor where id = p_corte_id
  for update;

  if not found then
    raise exception 'Ese corte no existe.'
      using errcode = 'no_data_found';
  end if;

  select count(*)::integer into v_sorteos
  from public.corte_detalle where corte_id = p_corte_id;

  /*
   * Los abonos que este corte absorbió vuelven a estar vivos.
   *
   * Va ANTES de borrar el corte: la referencia es `on delete set null`, así
   * que al borrarlo se quedarían en nulo solos. Pero contarlos después sería
   * imposible —ya no habría con qué distinguirlos de los demás abonos vivos—
   * y hace falta el número para decirlo en pantalla.
   */
  select count(*)::integer into v_abonos
  from public.abono_vendedor where corte_id = p_corte_id;

  update public.abono_vendedor
  set corte_id = null
  where corte_id = p_corte_id;

  /*
   * Y el saldo de apertura que este corte cobró vuelve a deberse.
   *
   * `saldado_en` hay que limpiarlo a mano: la cascada sólo alcanza a la
   * referencia, y con la fecha puesta el saldo seguiría contando como cobrado
   * aunque el pago ya no exista.
   */
  select count(*)::integer into v_aperturas
  from public.saldo_inicial where saldado_corte_id = p_corte_id;

  update public.saldo_inicial
  set saldado_en = null,
      saldado_corte_id = null
  where saldado_corte_id = p_corte_id;

  /*
   * La huella, antes de borrar nada.
   *
   * Se guarda lo que el corte decía —período, sorteos y saldo— porque una vez
   * borrado no hay forma de reconstruirlo, y la pregunta que se hace tres
   * meses después es exactamente ésa: qué se revirtió y por cuánto.
   */
  perform public.fn_auditar(
    'corte_vendedor', p_corte_id, 'reversar', 'saldo',
    v_corte.saldo::text,
    'revertido · ' || v_corte.desde::text || ' a ' || v_corte.hasta::text ||
    ' · ' || v_sorteos::text || ' sorteos' ||
    case when v_aperturas > 0 then ' · con saldo inicial' else '' end,
    p_usuario_id
  );

  if nullif(btrim(coalesce(p_motivo, '')), '') is not null then
    perform public.fn_auditar(
      'corte_vendedor', p_corte_id, 'reversar', 'motivo',
      null, btrim(p_motivo), p_usuario_id
    );
  end if;

  /*
   * Y se borra. El detalle se va con él por la cascada del `references`, que
   * es lo que devuelve los sorteos a pendientes: la hoja los busca por «no
   * existe en corte_detalle».
   *
   * No se marca como anulado a propósito: un corte anulado seguiría figurando
   * en el historial de pagos del vendedor, y ahí diría que se le entregó algo
   * que no se le entregó.
   */
  delete from public.corte_vendedor where id = p_corte_id;

  return query select v_sorteos, v_abonos, v_corte.saldo, v_corte.desde, v_corte.hasta;
end;
$reversar$;

comment on function public.fn_reversar_corte(uuid, text, uuid) is
  'Deshace un corte como si nunca se hubiera hecho: libera sus sorteos, sus abonos y el saldo de apertura que hubiera cobrado.';

revoke execute on function public.fn_reversar_corte(uuid, text, uuid)
  from public, anon;
