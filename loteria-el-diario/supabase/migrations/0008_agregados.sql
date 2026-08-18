-- ===========================================================================
-- Agregados analíticos.
--
-- POR QUÉ NO SON VISTAS MATERIALIZADAS
-- ------------------------------------
-- El plan contemplaba materializar. Con los volúmenes reales del negocio
-- —5 vendedores, 3 sorteos diarios, del orden de 90 000 líneas por año— la
-- agregación en vivo es inmediata para PostgreSQL, y materializar traería
-- maquinaria de refresco y ventanas de desfase. Un tablero que enseña cifras
-- de hace cinco minutos mientras el reporte enseña las de ahora es exactamente
-- la contradicción que el §2 prohíbe.
--
-- Se agrega en vivo desde `linea`, que es la unidad atómica. Si algún día los
-- volúmenes lo piden, materializar es un cambio local a este archivo: las
-- pantallas no saben de dónde salen los números.
--
-- LIQUIDADO Y PENDIENTE VAN SEPARADOS
-- -----------------------------------
-- Mientras un sorteo no esté liquidado, sus premios y su utilidad son
-- proyección (§5). Estas funciones nunca los suman con los definitivos: los
-- devuelven en campos aparte para que la interfaz los rotule como lo que son.
-- ===========================================================================

-- --- Vista base ------------------------------------------------------------
-- Una fila por (sorteo, vendedor). `security_invoker` hace que respete RLS:
-- un vendedor sólo ve las suyas, administración las ve todas.

create or replace view allan.v_agregado_sorteo_vendedor
with (security_invoker = true) as
  select s.id            as sorteo_id,
         s.fecha,
         s.hora,
         s.estado,
         s.numero_ganador,
         t.vendedor_id,
         count(distinct t.id)                        as tickets,
         sum(l.monto)                                as venta,
         sum(l.monto * l.comision_congelada)         as comision,
         sum(l.premio)                               as premios,
         sum(l.monto)
           - sum(l.monto * l.comision_congelada)
           - sum(l.premio)                           as utilidad
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.anulado_en is null
  group by s.id, s.fecha, s.hora, s.estado, s.numero_ganador, t.vendedor_id;

comment on view allan.v_agregado_sorteo_vendedor is
  'Todo indicador del sistema sale de aquí, y esto sale de las líneas. Ningún total se captura a mano.';

grant select on allan.v_agregado_sorteo_vendedor to authenticated;

-- Índices que sostienen la agregación.
create index if not exists linea_ticket_numero on allan.linea (ticket_id, numero);
create index if not exists ticket_sorteo_vigente on allan.ticket (sorteo_id) where anulado_en is null;

-- --- Totales de un rango ---------------------------------------------------

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select
    coalesce(sum(a.venta), 0),
    coalesce(sum(a.comision), 0),
    coalesce(sum(a.tickets), 0)::integer,
    coalesce(sum(a.venta)    filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0),
    coalesce(count(distinct a.sorteo_id) filter (where a.estado =  'liquidado'), 0)::integer,
    coalesce(count(distinct a.sorteo_id) filter (where a.estado <> 'liquidado'), 0)::integer
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta;
$$;

-- --- Serie mensual ---------------------------------------------------------
-- Alimenta el gráfico de utilidad mes por mes. La utilidad sólo cuenta sorteos
-- liquidados; `venta_pendiente` permite avisar de que el mes aún no cerró.

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from a.fecha)::integer,
         extract(month from a.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0)
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta
  group by 1, 2
  order by 1, 2;
$$;

-- --- Por vendedor ----------------------------------------------------------

create or replace function allan.fn_resumen_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  vendedor_id uuid,
  codigo      text,
  nombre      text,
  color       text,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select v.id, v.codigo, v.nombre, v.color,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0)
  from allan.vendedor v
  left join allan.v_agregado_sorteo_vendedor a
    on a.vendedor_id = v.id and a.fecha between p_desde and p_hasta
  where v.activo
  group by v.id, v.codigo, v.nombre, v.color
  order by 5 desc;
$$;

-- --- Un día, sorteo por sorteo --------------------------------------------

create or replace function allan.fn_resumen_dia(p_fecha date)
returns table (
  sorteo_id      uuid,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  numero_ganador smallint,
  tickets        integer,
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
  select s.id, s.hora, s.estado, s.numero_ganador,
         coalesce(sum(a.tickets), 0)::integer,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision), 0),
         coalesce(sum(a.premios), 0),
         coalesce(sum(a.utilidad), 0)
  from allan.sorteo s
  left join allan.v_agregado_sorteo_vendedor a on a.sorteo_id = s.id
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

-- --- Un día, desglose por vendedor y sorteo -------------------------------

create or replace function allan.fn_desglose_dia(p_fecha date)
returns table (
  vendedor_id uuid,
  nombre      text,
  hora        allan.hora_sorteo,
  estado      allan.estado_sorteo,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select a.vendedor_id, v.nombre, a.hora, a.estado,
         a.venta, a.comision, a.premios, a.utilidad
  from allan.v_agregado_sorteo_vendedor a
  join allan.vendedor v on v.id = a.vendedor_id
  where a.fecha = p_fecha
  order by v.codigo, a.hora;
$$;
