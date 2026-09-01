-- ===========================================================================
-- Los otros dos informes que mira la gerencia.
--
-- La 0036 cubrió la hoja DASHBOARD: una fila por vendedor para un rango. El
-- gerente mira además otras dos cosas, y hasta ahora las armaba aparte:
--
--   · el RESUMEN DE LA SEMANA — los cinco números de la semana y el padrón con
--     los parámetros con los que se jugó;
--   · el ANÁLISIS DE UN VENDEDOR — su acumulado y su historia semana a semana.
--
-- Las dos se apoyan en el mismo corte semanal, así que aquí van juntas.
--
-- LA SEMANA ES DE LUNES A DOMINGO
-- -------------------------------
-- `date_trunc('week', ...)` empieza en lunes, que es la semana de este
-- negocio: las hojas del gerente van de lunes a domingo. El número de semana
-- es el de la norma ISO, el mismo que enseña cualquier calendario, y va con su
-- rango de fechas al lado para que nadie tenga que fiarse del número solo.
--
-- LO QUE NO ESTÁ Y NO SE INVENTA
-- ------------------------------
-- La hoja del gerente trae columnas de «regalado», «pasados» y un factor de
-- regalía. Este sistema no registra ninguna de las tres —se retiraron por
-- decisión del negocio al hacer la 0036— y ninguna función de aquí las
-- devuelve. Enseñarlas en cero fijo sería fingir un dato.
-- ===========================================================================


-- --------------------------------------------------------------------------
-- Las semanas que de verdad se operaron.
--
-- Es el riel de la izquierda del resumen semanal, y también la fuente de los
-- totales del análisis de vendedores: cuántas semanas hay y cuánta comisión se
-- pagó en total. Una sola función para las dos cosas, porque son la misma
-- pregunta hecha desde dos pantallas.
-- --------------------------------------------------------------------------
create or replace function allan.fn_semanas_operadas()
returns table (
  r_inicio   date,
  r_fin      date,
  r_semana   integer,
  r_anio     integer,
  r_dias     integer,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_neto     numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select
    date_trunc('week', s.fecha)::date,
    (date_trunc('week', s.fecha) + interval '6 days')::date,
    extract(week    from date_trunc('week', s.fecha))::integer,
    extract(isoyear from date_trunc('week', s.fecha))::integer,
    count(distinct s.fecha)::integer,
    count(distinct s.id)::integer,
    sum(lq.venta),
    sum(lq.comision),
    sum(lq.premios),
    -- Restado de lo que se enseña, no sumado de `utilidad`: las cuatro
    -- columnas se redondean por separado al liquidar. Ver la 0036.
    sum(lq.venta) - sum(lq.comision) - sum(lq.premios)
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  group by date_trunc('week', s.fecha)
  -- La más reciente primero: es la que el gerente abre.
  order by 1 desc;
$$;

comment on function allan.fn_semanas_operadas() is
  'Una fila por semana con movimiento liquidado, de la más reciente a la más vieja.';

revoke execute on function allan.fn_semanas_operadas() from public, anon;


-- --------------------------------------------------------------------------
-- El resumen de una semana, vendedor por vendedor.
--
-- Trae dos cosas distintas en la misma fila y conviene no confundirlas:
--
--   · los PARÁMETROS con los que ese vendedor jugó la semana —comisión, tope
--     por número y factor de pago—, que son configuración;
--   · lo que MOVIÓ esa semana, que es resultado.
--
-- Los parámetros se leen vigentes al cierre de la semana, no los de hoy. Un
-- resumen de marzo tiene que enseñar la comisión de marzo: `parametro_vendedor`
-- guarda la historia con `vigente_desde`, y sería un desperdicio consultarla
-- para devolver el valor de ahora.
-- --------------------------------------------------------------------------
create or replace function allan.fn_resumen_semanal(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_activo      boolean,
  r_comision    numeric,   -- FRACCIÓN vigente: 0.15 = 15 %
  r_tope        numeric,   -- tope por número y sorteo
  r_factor      numeric,   -- multiplicador de pago
  r_venta       numeric,
  r_premiado    numeric,   -- lo APOSTADO al número que salió
  r_pago        numeric,   -- lo que costó pagarlo
  r_comision_l  numeric,   -- la comisión en lempiras
  r_bruto       numeric,
  r_neto        numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  ),
  -- El parámetro que regía al terminar la semana. `distinct on` con el orden
  -- descendente por `vigente_desde` se queda con el último que había empezado
  -- a esa altura, que es exactamente la definición de «el vigente entonces».
  vigente as (
    select distinct on (p.vendedor_id)
           p.vendedor_id, p.comision, p.tope_por_numero, p.factor_pago
    from allan.parametro_vendedor p
    where p.vigente_desde < ((p_hasta + 1)::timestamp at time zone 'America/Tegucigalpa')
    order by p.vendedor_id, p.vigente_desde desc
  )
  -- Se parte del padrón, igual que la 0036: un vendedor que no movió nada esa
  -- semana es justo lo que hay que ver, y desapareciendo no se distingue de no
  -- existir.
  select v.id,
         v.codigo,
         v.nombre,
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
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  left join vigente   g on g.vendedor_id = v.id
  where v.activo or q.venta is not null
  order by v.codigo;
$$;

comment on function allan.fn_resumen_semanal(date, date) is
  'Resumen de una semana: por vendedor, los parámetros vigentes entonces y lo que movió.';

revoke execute on function allan.fn_resumen_semanal(date, date) from public, anon;


-- --------------------------------------------------------------------------
-- La historia de un vendedor, semana a semana.
--
-- El acumulado del vendedor no se devuelve aparte: es la suma de estas filas,
-- y calcularlo dos veces —una aquí y otra en la pantalla— es la forma más
-- fácil de que un día dejen de coincidir.
-- --------------------------------------------------------------------------
create or replace function allan.fn_historial_vendedor(
  p_vendedor_id uuid
) returns table (
  r_inicio   date,
  r_fin      date,
  r_semana   integer,
  r_anio     integer,
  r_sorteos  integer,
  r_venta    numeric,
  r_premiado numeric,
  r_premios  numeric,
  r_comision numeric,
  r_neto     numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with semanal as (
    select date_trunc('week', s.fecha)::date as inicio,
           count(distinct s.id)::integer     as sorteos,
           sum(lq.venta)                     as venta,
           sum(lq.comision)                  as comision,
           sum(lq.premios)                   as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
    group by 1
  ),
  acertado as (
    select date_trunc('week', s.fecha)::date as inicio,
           sum(l.monto)                      as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana
    group by 1
  )
  select w.inicio,
         (w.inicio + 6),
         extract(week    from w.inicio)::integer,
         extract(isoyear from w.inicio)::integer,
         w.sorteos,
         w.venta,
         coalesce(a.premiado, 0),
         w.premios,
         w.comision,
         w.venta - w.comision - w.premios
  from semanal w
  left join acertado a on a.inicio = w.inicio
  order by w.inicio;
$$;

comment on function allan.fn_historial_vendedor(uuid) is
  'La historia de un vendedor semana a semana. El acumulado es la suma de estas filas.';

revoke execute on function allan.fn_historial_vendedor(uuid) from public, anon;
