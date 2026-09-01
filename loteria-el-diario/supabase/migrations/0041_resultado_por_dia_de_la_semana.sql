-- ===========================================================================
-- El resultado por día de la semana.
--
-- No es «cada día», que ya lo da `fn_analisis_resultados` con el grano 'dia'.
-- Es todos los lunes juntos, todos los martes juntos, y así: la pregunta es si
-- hay un día que sistemáticamente deja o quita dinero, y esa sólo se contesta
-- apilando meses de lunes.
--
-- Siete filas siempre que haya historia, y sin parámetros a propósito: el
-- análisis financiero de la gerencia es el acumulado de toda la operación. Un
-- rango corto no contesta esta pregunta —tres lunes no son una tendencia— así
-- que no se ofrece la posibilidad de pedirlo.
--
-- `isodow` numera de 1 (lunes) a 7 (domingo), que es el orden en el que se
-- lee una semana aquí. `dow` empieza en domingo y habría obligado a rotar la
-- lista en la pantalla.
-- ===========================================================================

create or replace function allan.fn_resultado_por_dia_semana()
returns table (
  r_dow      integer,   -- 1 = lunes … 7 = domingo
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
    extract(isodow from s.fecha)::integer,
    count(distinct s.fecha)::integer,
    count(distinct s.id)::integer,
    sum(lq.venta),
    sum(lq.comision),
    sum(lq.premios),
    -- Restado de lo que se enseña, no sumado de `utilidad`. Ver la 0036.
    sum(lq.venta) - sum(lq.comision) - sum(lq.premios)
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  group by 1
  order by 1;
$$;

comment on function allan.fn_resultado_por_dia_semana() is
  'Todos los lunes juntos, todos los martes juntos: una fila por día de la semana, toda la historia.';

revoke execute on function allan.fn_resultado_por_dia_semana() from public, anon;
