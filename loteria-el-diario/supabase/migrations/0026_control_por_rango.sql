-- ===========================================================================
-- Control de vendedores por rango de fechas y varios vendedores a la vez.
--
-- Las funciones que había —`fn_bitacora_vendedor`, `fn_actividad_horaria`—
-- reciben UN vendedor y UN día. Servían cuando el padrón eran cinco personas;
-- con treinta, la pregunta que se hace de verdad es «cómo fueron estos cuatro
-- en la última quincena», y contestarla a base de treinta consultas de un día
-- no es contestarla.
--
-- Las viejas se conservan: la bitácora de un día suelto sigue siendo la vista
-- más útil cuando ya se sabe a quién y cuándo mirar.
--
-- `p_vendedores` es un arreglo y admite NULL para decir «todos». Un arreglo
-- vacío significaría «ninguno», que no es lo mismo, y confundirlos es cómo se
-- acaba enseñando un tablero en blanco sin saber por qué.
-- ===========================================================================

create or replace function allan.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
)
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_zona        text,
  r_color       text,
  r_tickets     integer,
  r_lineas      integer,
  r_venta       numeric,
  r_comision    numeric,
  r_premios     numeric,
  r_utilidad    numeric,
  r_pendiente   numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select v.id, v.codigo, v.nombre, v.zona, v.color,
         count(distinct t.id)::integer,
         count(l.id)::integer,
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0),
         -- La utilidad sólo existe donde hay premio calculado: mezclar sorteos
         -- sin liquidar la inflaría con una venta cuyo premio aún no se conoce.
         coalesce(sum(l.monto - l.monto * l.comision_congelada - l.premio)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)
  from allan.vendedor v
  left join allan.ticket t
    on t.vendedor_id = v.id and t.anulado_en is null
  left join allan.sorteo s
    on s.id = t.sorteo_id
   and s.fecha between p_desde and p_hasta
   and (p_hora is null or s.hora = p_hora)
  left join allan.linea l
    on l.ticket_id = t.id and s.id is not null
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  group by v.id, v.codigo, v.nombre, v.zona, v.color
  order by 8 desc, v.codigo;
$$;

comment on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo) is
  'Totales por vendedor en un rango. p_vendedores nulo = todos los activos.';

/** Venta por día del conjunto elegido, para la serie del gráfico. */
create or replace function allan.fn_control_serie(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
)
returns table (r_fecha date, r_venta numeric, r_tickets integer)
language sql
stable
security definer
set search_path = allan, public
as $$
  -- `generate_series` y no sólo los días con venta: un día sin ventas es un
  -- dato, y omitirlo dejaría la línea del gráfico saltando de martes a jueves
  -- como si el miércoles no hubiera existido.
  select d::date,
         coalesce(sum(l.monto), 0),
         count(distinct t.id)::integer
  from generate_series(p_desde, p_hasta, interval '1 day') d
  left join allan.sorteo s
    on s.fecha = d::date and (p_hora is null or s.hora = p_hora)
  left join allan.ticket t
    on t.sorteo_id = s.id
   and t.anulado_en is null
   and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
  left join allan.linea l on l.ticket_id = t.id
  group by d
  order by d;
$$;

/** Actividad por hora del reloj, agregada del conjunto elegido. */
create or replace function allan.fn_control_actividad(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null
)
returns table (r_hora integer, r_monto numeric)
language sql
stable
security definer
set search_path = allan, public
as $$
  select extract(hour from t.creado_en at time zone 'America/Tegucigalpa')::integer,
         coalesce(sum(l.monto), 0)
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  join allan.linea l on l.ticket_id = t.id
  where s.fecha between p_desde and p_hasta
    and t.anulado_en is null
    and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
  group by 1
  order by 1;
$$;

/** La bitácora, ahora por rango. Sigue siendo la única vista que baja a la línea. */
create or replace function allan.fn_bitacora_rango(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date,
  p_hora        allan.hora_sorteo default null,
  p_limite      integer default 300
)
returns table (
  r_fecha     date,
  r_creado_en timestamptz,
  r_hora      allan.hora_sorteo,
  r_estado    allan.estado_sorteo,
  r_folio     text,
  r_numero    smallint,
  r_monto     numeric,
  r_gana      boolean,
  r_premio    numeric,
  r_lat       double precision,
  r_lng       double precision
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.fecha, t.creado_en, s.hora, s.estado, t.folio,
         l.numero, l.monto, l.gana, l.premio, t.lat, t.lng
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
    and t.anulado_en is null
    and (p_hora is null or s.hora = p_hora)
  order by t.creado_en desc, l.numero
  limit p_limite;
$$;

revoke execute on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
revoke execute on function allan.fn_control_serie(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
revoke execute on function allan.fn_control_actividad(date, date, uuid[]) from public, anon;
revoke execute on function allan.fn_bitacora_rango(uuid, date, date, allan.hora_sorteo, integer)
  from public, anon;
