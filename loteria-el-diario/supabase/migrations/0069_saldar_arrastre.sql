-- ===========================================================================
-- Saldar el arrastre de semanas anteriores.
--
-- QUÉ HUECO LLENA
-- ---------------
-- El módulo de liquidación muestra, junto a cada vendedor, lo que quedó
-- pendiente de semanas anteriores. Pero no había forma de cerrarlo: los cortes
-- se registran eligiendo sorteos de LA SEMANA que se está viendo, y los
-- sorteos viejos no aparecen en esa lista. El arrastre crecía y no bajaba
-- nunca, aunque el vendedor hubiera pagado.
--
-- CÓMO SE SALDA
-- -------------
-- El arrastre no es un número suelto: son sorteos concretos de semanas
-- anteriores que no entraron todavía en ningún corte. Saldar el arrastre es
-- meter TODOS esos sorteos en un corte de una vez. Al quedar en
-- `corte_detalle`, dejan de contar como pendientes y el arrastre baja a cero
-- por la misma regla que ya usa el resto del módulo — no hay un mecanismo
-- nuevo que pueda desincronizarse del que ya existía.
--
-- EL VALOR QUE SE ENTREGA PUEDE NO CUADRAR, Y ESTÁ BIEN
-- ----------------------------------------------------
-- Un pago en la calle se cierra con un acuerdo: se redondea, se perdona un
-- resto, se descuenta algo hablado. Por eso quien registra escribe LO QUE SE
-- ENTREGÓ de verdad, no lo que dice el cálculo.
--
-- La diferencia no se esconde ni se reparte entre los sorteos: se guarda como
-- `ajuste` en el corte, con su motivo. Así el corte dice tres cosas separadas
-- y comprobables —lo que se debía, lo que se pagó, y por qué difieren— en vez
-- de un único número que no cuadra con nada.
--
-- Repartir la diferencia entre los sorteos habría sido lo fácil y lo peor:
-- dejaría liquidaciones con cifras que no corresponden a ninguna venta real, y
-- cualquier informe que las sume volvería a decir algo distinto del detalle.
--
-- LA FECHA ES LA DEL PAGO, NO LA DE LA CAPTURA
-- --------------------------------------------
-- Si el vendedor pagó el viernes y esto se registra el lunes, la fecha del
-- corte dice viernes. `pagado_en` guarda esa fecha; `registrado_en` guarda
-- cuándo se tecleó. Las dos hacen falta: la primera para cuadrar la semana con
-- el vendedor, la segunda para saber cuándo entró el dato al sistema — y son
-- justo las dos que se confunden cuando sólo se guarda una.
--
-- NO SE ADMITE UNA FECHA FUTURA. Un pago que todavía no ocurrió no se
-- registra; casi siempre es un dedazo en el año.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Dos columnas nuevas en el corte.
-- --------------------------------------------------------------------------

alter table public.corte_vendedor
  add column if not exists ajuste  numeric(14,2) not null default 0,
  add column if not exists entrega numeric(14,2),
  add column if not exists motivo_ajuste text,
  add column if not exists registrado_en timestamptz not null default now();

comment on column public.corte_vendedor.entrega is
  'Lo que el vendedor entregó de verdad. Nulo en los cortes viejos, donde se asumía igual al saldo.';

comment on column public.corte_vendedor.ajuste is
  'entrega menos saldo. Distinto de cero cuando el pago se cerró con un acuerdo: un redondeo, un resto perdonado.';

comment on column public.corte_vendedor.motivo_ajuste is
  'Por qué la entrega no coincide con el saldo. Se exige cuando hay ajuste.';

comment on column public.corte_vendedor.registrado_en is
  'Cuándo se tecleó el corte. `pagado_en` es cuándo se recibió el dinero, que puede ser antes.';


-- --------------------------------------------------------------------------
-- Lo que un vendedor arrastra de antes de una fecha.
--
-- Devuelve los sorteos uno a uno y no sólo el total: son los que van a entrar
-- en el corte, y la pantalla tiene que poder enseñar qué se está saldando
-- antes de que alguien lo confirme.
-- --------------------------------------------------------------------------

create or replace function public.fn_arrastre_pendiente(
  p_vendedor_id uuid,
  p_desde       date
)
returns table (
  r_liquidacion_id uuid,
  r_fecha          date,
  r_hora           public.hora_sorteo,
  r_venta          numeric,
  r_comision       numeric,
  r_premios        numeric,
  r_saldo          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select lq.id,
         s.fecha,
         s.hora,
         lq.venta,
         lq.comision,
         lq.premios,
         -- Restado, no leído de `utilidad`: las cuatro columnas se redondean
         -- por separado al liquidar. Misma regla que el resto del módulo.
         lq.venta - lq.comision - lq.premios
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  where lq.vendedor_id = p_vendedor_id
    -- ESTRICTAMENTE anterior: la semana que se está viendo se paga con el
    -- corte normal, no con éste.
    and s.fecha < p_desde
    and not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    )
  order by s.fecha, s.hora;
$$;

comment on function public.fn_arrastre_pendiente(uuid, date) is
  'Los sorteos de semanas anteriores que el vendedor no ha pagado. Es lo que compone el arrastre.';

revoke execute on function public.fn_arrastre_pendiente(uuid, date)
  from public, anon;


-- --------------------------------------------------------------------------
-- Saldar el arrastre.
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
as $$
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

  if v_ids is null then
    raise exception 'Ese vendedor no arrastra nada de semanas anteriores.'
      using errcode = 'no_data_found';
  end if;

  perform 1
  from public.liquidacion lq
  where lq.id = any (v_ids)
  order by lq.id
  for update;

  -- Los totales se recalculan AQUÍ, siempre. Lo que venga del navegador es una
  -- vista previa: si llegara alterado, el corte guardaría una cifra que no
  -- corresponde a ningún sorteo.
  select count(*),
         coalesce(sum(lq.venta), 0),
         coalesce(sum(lq.comision), 0),
         coalesce(sum(lq.premios), 0),
         min(s.fecha),
         max(s.fecha)
    into v_sorteos, v_venta, v_comision, v_premios, v_desde, v_hasta
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  where lq.id = any (v_ids);

  v_saldo  := v_venta - v_comision - v_premios;
  v_ajuste := round(p_entrega, 2) - v_saldo;

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
    'Saldo de semanas anteriores',
    -- La fecha del pago, a mediodía: guardar 00:00 hace que un cambio de zona
    -- horaria lo empuje al día anterior.
    (v_fecha + time '12:00') at time zone 'America/Tegucigalpa',
    p_usuario_id
  );

  begin
    insert into public.corte_detalle (corte_id, liquidacion_id)
    select v_corte_id, unnest(v_ids);
  exception when unique_violation then
    raise exception 'Parte de ese arrastre ya se había pagado. Vuelva a cargar el informe.'
      using errcode = 'check_violation';
  end;

  perform public.fn_auditar('corte_vendedor', v_corte_id, 'saldar_arrastre',
                            'entrega', v_saldo::text, round(p_entrega, 2)::text);

  -- El ajuste se audita APARTE del pago: es la parte que alguien va a querer
  -- revisar, y buscarla dentro de una entrada de pago sería esconderla.
  if v_ajuste <> 0 then
    perform public.fn_auditar('corte_vendedor', v_corte_id, 'ajustar',
                              'ajuste', null,
                              v_ajuste::text || ' — ' || btrim(p_motivo));
  end if;

  return query select v_corte_id, v_sorteos, v_saldo, round(p_entrega, 2), v_ajuste;
end;
$$;

comment on function public.fn_saldar_arrastre(uuid, date, numeric, date, text, uuid) is
  'Cierra de una vez todo lo que un vendedor arrastra de semanas anteriores. La entrega puede diferir del saldo: la diferencia queda como ajuste con su motivo.';

revoke execute on function public.fn_saldar_arrastre(uuid, date, numeric, date, text, uuid)
  from public, anon;
