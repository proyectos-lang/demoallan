-- ===========================================================================
-- El saldo de apertura cuenta desde su fecha, no sólo desde la semana pasada.
--
-- LO QUE REPORTÓ EL USUARIO
-- -------------------------
-- «Le doy a agregar saldo pendiente y no me aumenta el saldo». Y tenía razón:
-- el saldo SÍ se guardaba —cinco filas en la tabla, con su monto y su autor—
-- pero la pantalla seguía diciendo cero.
--
-- LA CAUSA, QUE ES UN ERROR DE CRITERIO MÍO
-- -----------------------------------------
-- La 0096 y la 0098 filtran por `vigente_desde < p_desde`: estrictamente
-- anterior al lunes de la semana que se está mirando. Copié esa regla de los
-- sorteos viejos, donde es la correcta —un sorteo de la semana en curso se
-- paga con el corte normal, no con el arrastre—.
--
-- Pero un saldo de apertura no es un sorteo. Quien lo carga lo hace HOY, y hoy
-- casi siempre cae dentro de la semana que tiene abierta en pantalla. Con la
-- comparación estricta, ese saldo no entraba en la semana en curso ni en
-- ninguna anterior: no aparecía en ningún sitio hasta el lunes siguiente.
--
-- Medido contra los datos reales: V-064 con saldo del 17/09 daba «anterior 0»
-- en la semana del 14 al 20. Moviéndole la fecha al 13 —domingo— aparecían sus
-- 45.299. El dinero estaba guardado; sólo era invisible.
--
-- EL CRITERIO BUENO
-- -----------------
-- `vigente_desde <= p_hasta`: el saldo cuenta en cuanto empieza la semana en
-- la que se cargó, y en todas las siguientes. Es lo que significa «entró al
-- sistema debiendo»: desde ese momento, debe.
--
-- Sigue sin aparecer en semanas ANTERIORES a su fecha, que es lo que hay que
-- conservar: mirando el mes pasado, ese vendedor todavía no tenía cuenta
-- abierta aquí, y decir que la tenía falsearía un cierre ya cuadrado.
--
-- SE ARREGLAN LAS DOS FUNCIONES QUE MIRAN LA FECHA
-- ------------------------------------------------
-- `fn_saldos_por_vendedor` la usa para pintar el arrastre, y
-- `fn_saldar_arrastre` para cobrarlo. Si sólo se corrigiera la primera, el
-- saldo se vería pero al ir a cobrarlo la función no lo encontraría y diría
-- que no arrastra nada.
-- ===========================================================================

create or replace function public.fn_saldos_por_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_activo       boolean,
  r_anterior     numeric,   -- pendiente de las semanas anteriores a p_desde
  r_venta        numeric,   -- lo que movió en la semana
  r_comision     numeric,
  r_premios      numeric,
  r_semana       numeric,   -- saldo de la semana: venta − comisión − premios
  r_liquidado    numeric,   -- la parte de la semana ya cerrada en un corte
  r_pendiente    numeric,   -- lo que falta de la semana
  r_actual       numeric    -- r_anterior + r_pendiente
)
language sql
stable
security definer
set search_path = public
as $saldos$
  with fila as (
    select lq.vendedor_id,
           s.fecha,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
  ),
  -- Lo que quedó sin cerrar ANTES de la semana pedida.
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  /*
   * El saldo con el que entró al sistema, si lo hay y NO se ha cobrado.
   *
   * `vigente_desde <= p_hasta` y no `< p_desde`. La diferencia es la que
   * reportó el usuario: quien carga un saldo lo hace HOY, y hoy cae dentro de
   * la semana que tiene abierta en pantalla. Con la comparación estricta ese
   * saldo no entraba ni en la semana en curso ni en ninguna anterior, así que
   * quedaba guardado pero invisible hasta el lunes siguiente.
   *
   * Sigue sin contar en semanas anteriores a su fecha: mirando el mes pasado
   * ese vendedor todavía no tenía cuenta abierta aquí.
   */
  apertura as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null
      and saldado_en is null
      and vigente_desde <= p_hasta
    group by vendedor_id
  ),
  -- Lo de la semana, separando lo ya cerrado de lo que falta.
  semana as (
    select vendedor_id,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as liquidado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from fila
    where fecha between p_desde and p_hasta
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         -- Lo viejo sin cobrar MÁS lo que traía de la libreta anterior.
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0),
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0) + coalesce(s.pendiente, 0)
  from public.vendedor v
  left join antes    a  on a.vendedor_id = v.id
  left join apertura ap on ap.vendedor_id = v.id
  left join semana   s  on s.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera dado de baja que siga debiendo o a
  -- quien se le siga debiendo: si tiene saldo, tiene que salir hasta saldarlo.
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(ap.monto, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by v.codigo;
$saldos$;

comment on function public.fn_saldos_por_vendedor(date, date) is
  'Saldo anterior y actual de cada vendedor para una semana. El anterior incluye el saldo de apertura que siga sin cobrar, desde la semana en que se cargó.';

revoke execute on function public.fn_saldos_por_vendedor(date, date)
  from public, anon;


-- --------------------------------------------------------------------------
-- Y cobrarlo tiene que encontrar lo mismo que se pinta.
--
-- Si sólo se corrigiera la función de arriba, el saldo se vería en pantalla
-- pero al darle a «saldar» esta otra no lo encontraría y respondería que el
-- vendedor no arrastra nada. Las dos miran la misma fecha; las dos cambian.
--
-- Se reescribe entera porque Postgres no deja cambiar una línea. Es el cuerpo
-- de la 0097 con la comparación corregida.
-- --------------------------------------------------------------------------

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
   *
   * `vigente_desde <= p_desde + 6` cubre la semana entera que se está
   * mirando, para encontrar exactamente los mismos saldos que pinta
   * `fn_saldos_por_vendedor`. Si las dos no coincidieran, el saldo se vería en
   * pantalla y al cobrarlo la función diría que no hay nada que cobrar.
   */
  select id, monto, vigente_desde
    into v_apertura_id, v_apertura, v_apertura_fecha
  from public.saldo_inicial
  where vendedor_id = p_vendedor_id
    and anulado_en is null
    and saldado_en is null
    and vigente_desde <= p_desde + 6
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

  -- Hay dos formas de arrastrar algo: sorteos viejos sin pagar, o el saldo con
  -- el que entró al sistema. Sólo se rechaza si no hay ninguna.
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
