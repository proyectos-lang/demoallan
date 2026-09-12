-- ===========================================================================
-- Ver y corregir la venta capturada por totales.
--
-- QUÉ HUECO LLENA
-- ---------------
-- La captura por totales sólo se veía desde su propia pestaña, y sólo la del
-- sorteo que estuviera elegido en ese momento. Para revisar el día había que
-- entrar tres veces, una por sorteo.
--
-- Y sólo se podía ANULAR. Una venta de 4.500 tecleada como 450 obligaba a
-- anular y volver a capturar, dejando dos filas en el histórico para lo que
-- fue un dedazo en un dígito.
--
-- DOS FUNCIONES
-- -------------
--   · `fn_ventas_totales_dia` — lo capturado en un día, los tres sorteos
--     juntos, con el rótulo del vendedor ya resuelto.
--   · `fn_editar_venta_total` — corrige venta, premiado y nota.
--
-- LO QUE NO CAMBIA: el vendedor y el sorteo. Igual que al corregir una venta
-- con números (0075), mover una captura de vendedor o de sorteo no es
-- corregir un dedazo sino trasladar dinero de un sitio a otro; para eso está
-- anular y capturar donde toque, que deja las dos huellas.
--
-- LA COMISIÓN CONGELADA TAMPOCO. Aquí sí se conserva la del día de la captura,
-- al revés que en `fn_editar_venta`: la captura la guarda en su propia fila
-- —`comision_congelada`— así que el dato existe y no hay por qué perderlo.
-- En el ticket con números vive por línea y se borra al rehacerlas.
--
-- SE RECONCILIA SI EL SORTEO ESTABA LIQUIDADO, como al registrar y al anular.
-- `fn_recalcular_liquidacion` rechaza si ese sorteo ya se pagó en un corte, y
-- al rechazar deshace la corrección entera.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action. La base
-- habla como `service_role` desde la 0024, así que aquí no hay guarda que
-- sirva.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Lo capturado por totales en un día.
--
-- Los tres sorteos juntos y ordenados por hora: la pregunta que trae aquí a
-- alguien es «qué se capturó ayer», no «qué se capturó ayer a las once».
-- ---------------------------------------------------------------------------
create or replace function public.fn_ventas_totales_dia(
  p_fecha       date,
  p_vendedor_id uuid default null
) returns table (
  r_id          uuid,
  r_sorteo_id   uuid,
  r_hora        public.hora_sorteo,
  r_estado      public.estado_sorteo,
  r_vendedor_id uuid,
  r_codigo      text,
  r_vendedor    text,
  r_venta       numeric,
  r_premios     numeric,
  r_comision    numeric,
  r_saldo       numeric,
  r_nota        text,
  r_creado_en   timestamptz,
  r_anulado     boolean
)
language sql
stable
security definer
set search_path = public
as $ventas_dia$
  select vt.id,
         s.id,
         s.hora,
         s.estado,
         v.id,
         v.codigo,
         -- El alias si lo tiene. Es como se le conoce y como se le busca.
         public.fn_rotulo(v.alias, v.nombre),
         vt.venta,
         vt.premios,
         round(vt.venta * vt.comision_congelada, 2),
         round(vt.venta - vt.venta * vt.comision_congelada - vt.premios, 2),
         vt.nota,
         vt.creado_en,
         vt.anulado_en is not null
  from public.venta_total vt
  join public.sorteo   s on s.id = vt.sorteo_id
  join public.vendedor v on v.id = vt.vendedor_id
  where s.fecha = p_fecha
    and (p_vendedor_id is null or vt.vendedor_id = p_vendedor_id)
  order by s.hora, v.codigo, vt.creado_en;
$ventas_dia$;

comment on function public.fn_ventas_totales_dia(date, uuid) is
  'Lo capturado por totales en un día, los tres sorteos juntos, con el alias del vendedor y el saldo ya calculado.';

revoke execute on function public.fn_ventas_totales_dia(date, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Corregir una captura por totales.
-- ---------------------------------------------------------------------------
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
                              v_fila.venta::text, p_venta::text);
  end if;

  if v_fila.premios <> p_premios then
    perform public.fn_auditar('venta_total', p_id, 'editar', 'premios',
                              v_fila.premios::text, p_premios::text);
  end if;

  if coalesce(v_fila.nota, '') <> coalesce(nullif(btrim(coalesce(p_nota, '')), ''), '') then
    perform public.fn_auditar('venta_total', p_id, 'editar', 'nota',
                              v_fila.nota, nullif(btrim(coalesce(p_nota, '')), ''));
  end if;

  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_fila.sorteo_id, v_fila.vendedor_id);
  end if;

  return query
  select round(p_venta * v_fila.comision_congelada, 2),
         round(p_venta - p_venta * v_fila.comision_congelada - p_premios, 2);
end;
$editar_total$;

comment on function public.fn_editar_venta_total(uuid, numeric, numeric, text, uuid) is
  'Corrige venta, premiado y nota de una captura por totales. No toca vendedor, sorteo ni comisión congelada. Reconcilia la liquidación si el sorteo estaba liquidado.';

revoke execute on function public.fn_editar_venta_total(uuid, numeric, numeric, text, uuid)
  from public, anon;


-- ===========================================================================
-- Las dos que se quedaron fuera de la 0068: el alias también aquí.
--
-- La 0068 pasó seis funciones de informes a `fn_rotulo(alias, nombre)`, pero
-- `fn_desglose_dia` y `fn_resumen_semanal` no entraron —viven desde la 0008 y
-- la 0040 y no se estaban mirando entonces—. El resultado es que el tablero y
-- el informe semanal seguían pintando el nombre registrado mientras el resto
-- del sistema ya decía el alias: el mismo vendedor con dos rótulos según la
-- pantalla, que es justo lo que hace dudar de si son la misma persona.
--
-- Se replican en `public` como hizo la 0068, con el cuerpo intacto salvo esa
-- columna. Las de `allan` se quedan donde están: nada las llama y borrarlas
-- no es asunto de esta migración.
-- ===========================================================================

-- Cuerpo de la 0008, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
create or replace function public.fn_desglose_dia(p_fecha date)
returns table (
  vendedor_id uuid,
  nombre      text,
  hora        public.hora_sorteo,
  estado      public.estado_sorteo,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security definer
set search_path = public
as $desglose$
  select a.vendedor_id,
         public.fn_rotulo(v.alias, v.nombre),
         a.hora, a.estado,
         a.venta, a.comision, a.premios, a.utilidad
  from public.v_agregado_sorteo_vendedor a
  join public.vendedor v on v.id = a.vendedor_id
  where a.fecha = p_fecha
  order by v.codigo, a.hora;
$desglose$;

comment on function public.fn_desglose_dia(date) is
  'Un día, desglose por vendedor y sorteo. Muestra el alias cuando lo hay.';

revoke execute on function public.fn_desglose_dia(date) from public, anon;


-- Cuerpo de la 0040, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
create or replace function public.fn_resumen_semanal(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_activo      boolean,
  r_comision    numeric,
  r_tope        numeric,
  r_factor      numeric,
  r_venta       numeric,
  r_premiado    numeric,
  r_pago        numeric,
  r_comision_l  numeric,
  r_bruto       numeric,
  r_neto        numeric
)
language sql
stable
security definer
set search_path = public
as $semanal$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  ),
  vigente as (
    select distinct on (p.vendedor_id)
           p.vendedor_id, p.comision, p.tope_por_numero, p.factor_pago
    from public.parametro_vendedor p
    where p.vigente_desde < ((p_hasta + 1)::timestamp at time zone 'America/Tegucigalpa')
    order by p.vendedor_id, p.vigente_desde desc
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         g.comision,
         g.tope_por_numero,
         g.factor_pago,
         coalesce(q.venta, 0),
         coalesce(a.premiado, 0),
         coalesce(q.premios, 0),
         coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from public.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  left join vigente   g on g.vendedor_id = v.id
  where v.activo or q.venta is not null
  order by v.codigo;
$semanal$;

comment on function public.fn_resumen_semanal(date, date) is
  'Resumen de una semana por vendedor, con los parámetros vigentes entonces. Muestra el alias cuando lo hay.';

revoke execute on function public.fn_resumen_semanal(date, date) from public, anon;
