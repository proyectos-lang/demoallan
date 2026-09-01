-- ===========================================================================
-- El grano más fino del análisis: un sorteo.
--
-- La 0038 partía por día, semana, mes y año. Debajo del día todavía hay algo,
-- y es donde de verdad se explica un resultado: el sorteo. Un día malo casi
-- nunca es un día malo entero — es que a las tres salió un número muy jugado.
-- Con el corte por día eso queda escondido dentro de la suma de los tres.
--
-- POR QUÉ CAMBIA LA FIRMA
-- -----------------------
-- Hasta ahora cada tarjeta se identificaba con una fecha y bastaba. Un sorteo
-- necesita fecha Y hora, así que la salida gana `r_hora`. Como cambia el tipo
-- de retorno hay que soltar la función antes de recrearla: `create or replace`
-- no puede cambiar las columnas de un `returns table` (precedente: la 0037).
--
-- Va también el número ganador. A este grano cada tarjeta es exactamente un
-- sorteo, así que hay uno solo y es lo que explica la fila entera: los premios
-- de la tarjeta son ese número y nada más. En los demás granos se devuelve en
-- nulo, porque «el número ganador de agosto» no significa nada.
--
-- CÓMO SE AGRUPAN LOS OTROS GRANOS
-- --------------------------------
-- `corte_hora` es la hora sólo cuando se pide 'sorteo'; en los demás es nulo
-- en todas las filas, así que agrupar por (inicio, corte_hora) da exactamente
-- lo mismo que agrupar por inicio. Un solo cuerpo sigue sirviendo para los
-- cinco cortes, que era el punto de la 0038: que no se puedan separar.
-- ===========================================================================

drop function if exists allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo);

create function allan.fn_analisis_resultados(
  p_desde       date,
  p_hasta       date,
  p_grano       text,
  p_vendedor_id uuid default null,
  p_hora        allan.hora_sorteo default null
) returns table (
  r_inicio         date,
  r_fin            date,
  r_hora           allan.hora_sorteo,
  r_numero_ganador smallint,
  r_dias           integer,
  r_sorteos        integer,
  r_venta          numeric,
  r_comision       numeric,
  r_premios        numeric,
  r_utilidad       numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with cortado as (
    select
      case p_grano
        when 'sorteo' then s.fecha
        when 'dia'    then s.fecha
        when 'semana' then date_trunc('week',  s.fecha)::date
        when 'anio'   then date_trunc('year',  s.fecha)::date
        else               date_trunc('month', s.fecha)::date
      end as inicio,
      case when p_grano = 'sorteo' then s.hora end as corte_hora,
      s.id             as sorteo_id,
      s.fecha          as fecha,
      s.numero_ganador as numero_ganador,
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
        when 'sorteo' then inicio
        when 'dia'    then inicio
        when 'semana' then inicio + 6
        when 'anio'   then (inicio + interval '1 year' - interval '1 day')::date
        else               (inicio + interval '1 month' - interval '1 day')::date
      end,
      p_hasta
    ),
    corte_hora,
    -- Un solo sorteo por grupo a este grano, así que el máximo ES el número.
    case when p_grano = 'sorteo' then max(numero_ganador) end,
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
  group by inicio, corte_hora
  order by inicio, corte_hora;
$$;

comment on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo) is
  'Resultado real agregado al grano pedido: sorteo, dia, semana, mes o anio. Sólo sorteos liquidados.';

revoke execute on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo)
  from public, anon;
