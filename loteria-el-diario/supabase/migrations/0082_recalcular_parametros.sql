-- ===========================================================================
-- Aplicar hacia atrás una comisión o un factor que se cambió tarde.
--
-- EL CASO QUE LO MOTIVA
-- ---------------------
-- V-058 ISABEL tenía 15% y se le subió al 20% un lunes a las 2:25 de la tarde.
-- Su venta de esa mañana —registrada a las 12:52— conservaba el 15%, porque
-- cada línea congela la comisión que regía al venderse.
--
-- Eso es lo correcto por omisión: si al cambiar el porcentaje se reescribieran
-- todas las ventas pasadas, un corte ya firmado dejaría de cuadrar con lo que
-- se le entregó al vendedor. Pero cuando el cambio se acordó el lunes por la
-- mañana y se tecleó por la tarde, lo correcto es justo lo contrario: la
-- jornada entera debía ir al 20%.
--
-- Hasta ahora eso sólo se arreglaba corrigiendo venta por venta.
--
-- QUÉ HACE
-- --------
-- Reescribe `comision_congelada` y `factor_congelado` de todo lo del vendedor
-- desde una fecha, en las tres tablas donde viven:
--
--   · `linea`            — la venta con números.
--   · `venta_total`      — la captura por totales (sólo comisión; el factor no
--                          se guarda ahí, el premio ya viene multiplicado).
--   · `liquidacion`      — se rehace desde las líneas ya corregidas.
--
-- El PREMIO de cada línea ganadora se recalcula con el factor nuevo, porque
-- premio = monto x factor y dejarlo con el viejo descuadraría la liquidación
-- contra sus propias líneas.
--
-- LO YA PAGADO TAMBIÉN SE RECALCULA
-- ---------------------------------
-- Decisión explícita de administración. Tiene una consecuencia que conviene
-- tener presente: un corte ya cerrado guarda sus propias cifras —`venta`,
-- `comision`, `premios`, `saldo`— copiadas al pagarse, y esas NO se tocan aquí.
-- Así que tras recalcular, la liquidación de un sorteo pagado puede decir una
-- cifra distinta de la que figura en el corte con el que se le entregó el
-- dinero.
--
-- Es lo que se pidió y se hace, pero la función DEVUELVE cuántos sorteos
-- pagados tocó, para que la pantalla pueda decirlo y quien lo ejecute sepa que
-- hay papel que ya no cuadra.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action — la base
-- habla como `service_role` desde la 0024.
-- ===========================================================================

create or replace function public.fn_recalcular_parametros(
  p_vendedor_id uuid,
  /* Desde qué día se reescribe, inclusive. */
  p_desde       date,
  p_comision    numeric,
  p_factor_pago numeric,
  p_usuario_id  uuid default null
)
returns table (
  r_lineas      integer,   -- líneas de venta con números reescritas
  r_capturas    integer,   -- capturas por totales reescritas
  r_sorteos     integer,   -- liquidaciones rehechas
  r_pagados     integer,   -- de ésas, cuántas ya estaban en un corte pagado
  r_comision_antes numeric,
  r_comision_ahora numeric
)
language plpgsql
security definer
set search_path = public
as $recalcular$
declare
  v_lineas   integer := 0;
  v_capturas integer := 0;
  v_sorteos  integer := 0;
  v_pagados  integer := 0;
  v_antes    numeric;
  v_sorteo   record;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
begin
  if p_comision is null or p_comision < 0 or p_comision > 0.60 then
    raise exception 'La comisión debe estar entre 0 y 60%%.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_factor_pago is null or p_factor_pago < 1 or p_factor_pago > 200 then
    raise exception 'El factor de pago debe estar entre 1 y 200.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_desde is null then
    raise exception 'Hace falta la fecha desde la que se recalcula.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Una fecha futura no reescribiría nada y dejaría a quien la tecleó creyendo
  -- que sí: casi siempre es un dedazo en el mes.
  if p_desde > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha desde la que se recalcula no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor where id = p_vendedor_id;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  -- Lo que había, para la auditoría y para poder decirlo en pantalla.
  select comision into v_antes
  from public.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  limit 1;

  /*
   * Las líneas de venta con números.
   *
   * `gana` no se toca: quién acertó lo decide el número ganador y no cambia
   * porque cambie una comisión. Lo que sí cambia es cuánto costó ese acierto,
   * que es monto x factor.
   */
  with tocadas as (
    update public.linea l
    set comision_congelada = p_comision,
        factor_congelado   = p_factor_pago,
        premio = case when l.gana then l.monto * p_factor_pago else l.premio end
    from public.ticket t
    join public.sorteo s on s.id = t.sorteo_id
    where l.ticket_id = t.id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and s.fecha >= p_desde
    returning l.id
  )
  select count(*)::integer into v_lineas from tocadas;

  /*
   * Las capturas por totales.
   *
   * Sólo la comisión: `venta_total` guarda el premio YA PAGADO en lempiras, no
   * lo apostado, así que el factor no interviene en su fila. Reescribir el
   * premio aquí sería inventar una cifra — habría que saber cuánto se apostó,
   * y ese dato no existe en una captura.
   */
  with tocadas as (
    update public.venta_total vt
    set comision_congelada = p_comision
    from public.sorteo s
    where s.id = vt.sorteo_id
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
      and s.fecha >= p_desde
    returning vt.id
  )
  select count(*)::integer into v_capturas from tocadas;

  /*
   * Y se rehace la liquidación de cada sorteo tocado.
   *
   * NO se usa `fn_recalcular_liquidacion`: esa función RECHAZA los sorteos ya
   * pagados en un corte, y hace bien —está pensada para la venta forzada, donde
   * añadir venta sobre dinero entregado sí es indefendible—. Aquí se pidió
   * explícitamente recalcular también lo pagado, así que la suma se hace aquí
   * con la MISMA fórmula, que es la única parte que no puede divergir:
   *
   *     venta    = Σ monto
   *     comisión = Σ monto x comisión congelada
   *     premios  = Σ premio
   *     utilidad = venta − comisión − premios
   *
   * sumando las dos fuentes, líneas y capturas por totales.
   */
  for v_sorteo in
    select distinct lq.sorteo_id,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
      and s.fecha >= p_desde
  loop
    select coalesce(sum(l.monto), 0),
           coalesce(sum(l.monto * l.comision_congelada), 0),
           coalesce(sum(l.premio), 0)
      into v_venta, v_comision, v_premios
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = v_sorteo.sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null;

    select v_venta    + coalesce(sum(vt.venta), 0),
           v_comision + coalesce(sum(vt.venta * vt.comision_congelada), 0),
           v_premios  + coalesce(sum(vt.premios), 0)
      into v_venta, v_comision, v_premios
    from public.venta_total vt
    where vt.sorteo_id = v_sorteo.sorteo_id
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null;

    update public.liquidacion
    set venta    = v_venta,
        comision = v_comision,
        premios  = v_premios,
        utilidad = v_venta - v_comision - v_premios
    where sorteo_id = v_sorteo.sorteo_id and vendedor_id = p_vendedor_id;

    v_sorteos := v_sorteos + 1;
    if v_sorteo.pagada then
      v_pagados := v_pagados + 1;
    end if;
  end loop;

  perform public.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'recalcular', 'comision',
    coalesce(v_antes::text, '—'),
    p_comision::text || ' desde ' || p_desde::text
  );

  if v_pagados > 0 then
    -- Se audita aparte: es la parte que deja papel sin cuadrar, y tiene que
    -- poder encontrarse sin leer el resto.
    perform public.fn_auditar(
      'parametro_vendedor', p_vendedor_id, 'recalcular', 'sorteos_pagados',
      null, v_pagados::text
    );
  end if;

  return query select v_lineas, v_capturas, v_sorteos, v_pagados,
                      v_antes, p_comision;
end;
$recalcular$;

comment on function public.fn_recalcular_parametros(uuid, date, numeric, numeric, uuid) is
  'Reescribe la comisión y el factor congelados de un vendedor desde una fecha, y rehace sus liquidaciones. Incluye los sorteos ya pagados en un corte: devuelve cuántos para poder avisarlo.';

revoke execute on function public.fn_recalcular_parametros(uuid, date, numeric, numeric, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Qué se vería afectado, ANTES de tocar nada.
--
-- La pantalla pregunta «¿desde cuándo?» y con eso sola no se puede decidir:
-- hace falta saber cuántos sorteos entran, cuánto cambia la comisión en
-- lempiras y —sobre todo— cuántos de esos sorteos ya se pagaron.
-- ---------------------------------------------------------------------------
create or replace function public.fn_impacto_recalculo(
  p_vendedor_id uuid,
  p_desde       date,
  p_comision    numeric,
  p_factor_pago numeric
)
returns table (
  r_sorteos        integer,
  r_pagados        integer,
  r_venta          numeric,
  r_comision_antes numeric,   -- lo que suman las comisiones congeladas hoy
  r_comision_ahora numeric,   -- lo que sumarían con la nueva
  r_premios_antes  numeric,
  r_premios_ahora  numeric,
  r_desde_real     date       -- el primer sorteo que entra, para decirlo
)
language sql
stable
security definer
set search_path = public
as $impacto$
  with liq as (
    select lq.id, lq.sorteo_id, s.fecha,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
      and s.fecha >= p_desde
  ),
  -- La venta con números: comisión y premio cambian los dos.
  porNumeros as (
    select coalesce(sum(l.monto), 0)                          as venta,
           coalesce(sum(l.monto * l.comision_congelada), 0)    as comision,
           coalesce(sum(l.monto * p_comision), 0)              as comision_nueva,
           coalesce(sum(l.premio), 0)                          as premios,
           coalesce(sum(case when l.gana then l.monto * p_factor_pago else 0 end), 0)
                                                              as premios_nuevos
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and s.fecha >= p_desde
  ),
  -- Las capturas: sólo cambia la comisión; el premio va en lempiras.
  porTotales as (
    select coalesce(sum(vt.venta), 0)                          as venta,
           coalesce(sum(vt.venta * vt.comision_congelada), 0)   as comision,
           coalesce(sum(vt.venta * p_comision), 0)              as comision_nueva,
           coalesce(sum(vt.premios), 0)                         as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
      and s.fecha >= p_desde
  )
  select (select count(*)::integer from liq),
         (select count(*)::integer from liq where pagada),
         n.venta + t.venta,
         round(n.comision + t.comision, 2),
         round(n.comision_nueva + t.comision_nueva, 2),
         n.premios + t.premios,
         n.premios_nuevos + t.premios,
         (select min(fecha) from liq)
  from porNumeros n cross join porTotales t;
$impacto$;

comment on function public.fn_impacto_recalculo(uuid, date, numeric, numeric) is
  'Qué cambiaría un recálculo desde una fecha, sin tocar nada: cuántos sorteos, cuántos ya pagados y cuánto se mueve la comisión.';

revoke execute on function public.fn_impacto_recalculo(uuid, date, numeric, numeric)
  from public, anon;
