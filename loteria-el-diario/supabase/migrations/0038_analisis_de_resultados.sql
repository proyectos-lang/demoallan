-- ===========================================================================
-- Análisis de resultados: el mismo corte, al grano que se pida.
--
-- Las tarjetas mes por mes del simulador son la forma en que este negocio lee
-- un resultado: venta, comisiones, premios, utilidad y margen, una tarjeta por
-- período. Pero allí sirven para comparar un escenario inventado contra lo
-- real, y lo que hacía falta era mirar lo real y ya — de una semana día por
-- día, de un mes semana por semana, de un año mes por mes.
--
-- POR QUÉ UNA FUNCIÓN Y NO CUATRO
-- -------------------------------
-- El corte cambia sólo en cómo se agrupa la fecha. `date_trunc` hace las
-- cuatro con el mismo cuerpo, y así no hay manera de que el mes y la semana se
-- separen por un cambio hecho en una sola de ellas.
--
-- La semana de `date_trunc` empieza en lunes, que es la semana de este
-- negocio: las hojas del gerente van de lunes a domingo.
--
-- SÓLO CUENTA LO LIQUIDADO
-- ------------------------
-- Se lee de allan.liquidacion, así que un sorteo sin número ganador todavía no
-- aparece. Es lo correcto para un análisis de RESULTADO: la utilidad de un
-- sorteo sin liquidar no existe todavía, y meterlo con premios en cero
-- inflaría el margen de la semana en curso.
--
-- `r_dias` y `r_sorteos` cuentan lo que hay, no lo que cabría: una semana a
-- medias dice «4 días» y así se ve que aún no está cerrada.
-- ===========================================================================

create or replace function allan.fn_analisis_resultados(
  p_desde       date,
  p_hasta       date,
  p_grano       text,
  p_vendedor_id uuid default null,
  p_hora        allan.hora_sorteo default null
) returns table (
  r_inicio    date,
  r_fin       date,
  r_dias      integer,
  r_sorteos   integer,
  r_venta     numeric,
  r_comision  numeric,
  r_premios   numeric,
  r_utilidad  numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with cortado as (
    select
      case p_grano
        when 'dia'    then s.fecha
        when 'semana' then date_trunc('week',  s.fecha)::date
        when 'anio'   then date_trunc('year',  s.fecha)::date
        else               date_trunc('month', s.fecha)::date
      end as inicio,
      s.id      as sorteo_id,
      s.fecha   as fecha,
      lq.venta,
      lq.comision,
      lq.premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
      and (p_hora is null or s.hora = p_hora)
  )
  select
    -- Inicio y fin van recortados al rango pedido. Una «semana» que sólo
    -- solapa dos días con el filtro no debe decir que va de lunes a domingo:
    -- el rótulo de la tarjeta se arma con estas dos fechas y estaría
    -- prometiendo días que la consulta dejó fuera. Se agrupa por el corte
    -- entero; lo que se recorta es cómo se enseña.
    greatest(inicio, p_desde),
    least(
      case p_grano
        when 'dia'    then inicio
        when 'semana' then inicio + 6
        when 'anio'   then (inicio + interval '1 year' - interval '1 day')::date
        else               (inicio + interval '1 month' - interval '1 day')::date
      end,
      p_hasta
    ),
    count(distinct fecha)::integer,
    count(distinct sorteo_id)::integer,
    sum(venta),
    sum(comision),
    sum(premios),
    -- La utilidad se resta de lo que se enseña, no se suma de `liquidacion`:
    -- las cuatro columnas se redondean por separado al liquidar y se separan
    -- hasta un céntimo. Ver la cabecera de la 0036.
    sum(venta) - sum(comision) - sum(premios)
  from cortado
  group by inicio
  order by inicio;
$$;

comment on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo) is
  'Resultado real agregado al grano pedido: dia, semana, mes o anio. Sólo sorteos liquidados.';

revoke execute on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo)
  from public, anon;
