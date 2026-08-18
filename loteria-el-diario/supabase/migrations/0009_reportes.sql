-- ===========================================================================
-- Reporte filtrable.
--
-- Dos funciones y no una, a propósito: las filas se paginan pero los
-- SUBTOTALES SE CALCULAN SOBRE EL FILTRO COMPLETO. La tabla enseña las
-- primeras 80 filas; el encabezado de subtotales suma las que sean. Mezclarlas
-- en una sola llamada llevaría tarde o temprano a sumar sólo lo visible, que es
-- el error clásico de este tipo de pantalla.
--
-- Ambas corren como el invocador: RLS filtra, así que un vendedor que abra el
-- reporte ve únicamente sus propias filas y unos subtotales coherentes con
-- ellas.
--
-- El filtro por número ganador sólo puede casar con sorteos liquidados — un
-- sorteo sin liquidar no tiene número. Es correcto que los excluya.
-- ===========================================================================

create or replace function allan.fn_reporte_filas(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null,
  p_limite      integer  default 80,
  p_desde_fila  integer  default 0
) returns table (
  fecha          date,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  numero_ganador smallint,
  vendedor_id    uuid,
  vendedor       text,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select a.fecha, a.hora, a.estado, a.numero_ganador,
         a.vendedor_id, v.nombre,
         a.venta, a.comision, a.premios, a.utilidad
  from allan.v_agregado_sorteo_vendedor a
  join allan.vendedor v on v.id = a.vendedor_id
  where a.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or a.vendedor_id = p_vendedor_id)
    and (p_hora        is null or a.hora        = p_hora)
    and (p_numero      is null or a.numero_ganador = p_numero)
  -- Fecha descendente pero hora ascendente dentro del día: lo más reciente
  -- arriba, y dentro de la jornada en el orden en que ocurrió.
  order by a.fecha desc, a.hora asc, v.codigo asc
  limit p_limite offset p_desde_fila;
$$;

create or replace function allan.fn_reporte_totales(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null
) returns table (
  registros           integer,
  dias                integer,
  venta               numeric,
  comision            numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  registros_pendientes integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select count(*)::integer,
         count(distinct a.fecha)::integer,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0),
         count(*) filter (where a.estado <> 'liquidado')::integer
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or a.vendedor_id = p_vendedor_id)
    and (p_hora        is null or a.hora        = p_hora)
    and (p_numero      is null or a.numero_ganador = p_numero);
$$;

-- --- Bitácora de un vendedor ----------------------------------------------
-- La única vista del sistema que baja a la línea individual (§ control de
-- vendedores). Devuelve la hora exacta, el número, el monto y el punto de
-- venta de cada línea.

create or replace function allan.fn_bitacora_vendedor(
  p_vendedor_id uuid,
  p_fecha       date,
  p_hora        allan.hora_sorteo default null
) returns table (
  creado_en      timestamptz,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  folio          text,
  numero         smallint,
  monto          numeric,
  gana           boolean,
  premio         numeric,
  lat            double precision,
  lng            double precision
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.creado_en, s.hora, s.estado, t.folio,
         l.numero, l.monto, l.gana, l.premio, t.lat, t.lng
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha = p_fecha
    and t.anulado_en is null
    and (p_hora is null or s.hora = p_hora)
  order by t.creado_en, l.numero;
$$;

-- --- Actividad por hora del día -------------------------------------------
-- Alimenta las barras de «actividad por hora» del control de vendedores.

create or replace function allan.fn_actividad_horaria(
  p_vendedor_id uuid,
  p_fecha       date
) returns table (
  hora_reloj integer,
  monto      numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(hour from t.creado_en at time zone 'America/Tegucigalpa')::integer,
         sum(l.monto)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha = p_fecha
    and t.anulado_en is null
  group by 1
  order by 1;
$$;
