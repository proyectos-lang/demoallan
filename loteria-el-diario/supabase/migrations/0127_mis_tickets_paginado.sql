-- ===========================================================================
-- «Mis tickets» del vendedor se puede paginar: gana un desplazamiento.
--
-- Un vendedor con muchas ventas en un día sólo veía las 40 más recientes: la
-- función corta con `limit`, así que las viejas quedaban fuera y no había cómo
-- alcanzarlas. Ahora acepta `p_desde` (offset) para pasar de página: la
-- pantalla pide 40 a la vez y avanza de 40 en 40.
--
-- Cambia la firma —un parámetro más— así que se suelta la anterior primero.
-- ===========================================================================

drop function if exists public.fn_mis_tickets(uuid, date, integer);

create or replace function public.fn_mis_tickets(
  p_vendedor_id uuid,
  p_fecha       date,
  p_limite      integer default 40,
  p_desde       integer default 0
)
returns table (
  r_ticket_id uuid,
  r_folio     text,
  r_hora      public.hora_sorteo,
  r_estado    public.estado_sorteo,
  r_creado_en timestamptz,
  r_total     numeric,
  r_lineas    integer,
  r_premio    numeric,
  r_anulado   boolean,
  r_jugada    text
)
language sql
stable
security definer
set search_path = public
as $mis_tickets$
  select t.id,
         t.folio,
         s.hora,
         -- El estado del sorteo, que es lo que decide si esta venta todavía se
         -- puede deshacer. Va en la consulta y no se deduce de la hora: un
         -- sorteo puede seguir abierto minutos después de su hora de cierre
         -- —el ciclo corre cada cinco minutos— y al revés, uno puede cerrarse
         -- a mano antes.
         s.estado,
         t.creado_en,
         t.total,
         count(l.id)::integer,
         coalesce(sum(l.premio), 0),
         t.anulado_en is not null,
         -- La jugada tal como se lee en el papel, con el formato de la 0058.
         string_agg(
           lpad(l.numero::text, 2, '0') || ':' ||
           case when l.monto = trunc(l.monto)
                then trunc(l.monto)::bigint::text
                else to_char(l.monto, 'FM999999990.00')
           end,
           '  ' order by l.numero, l.monto)
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  left join public.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.vendedor_id = p_vendedor_id
  group by t.id, t.folio, s.hora, s.estado, t.creado_en, t.total, t.anulado_en
  order by t.creado_en desc
  limit p_limite
  offset greatest(p_desde, 0);
$mis_tickets$;

comment on function public.fn_mis_tickets(uuid, date, integer, integer) is
  'Los tickets de un vendedor en un día, paginados: p_limite por página desde p_desde. Ordenados del más reciente al más viejo.';

revoke execute on function public.fn_mis_tickets(uuid, date, integer, integer)
  from public, anon, authenticated;
