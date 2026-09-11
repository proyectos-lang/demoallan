-- ===========================================================================
-- El vendedor puede anular sus ventas, mientras el sorteo siga abierto.
--
-- QUÉ HUECO LLENA
-- ---------------
-- Un dedazo se ve al momento: el cliente dijo 07 y quedó 70, o se confirmó una
-- tanda de más. Hasta ahora el vendedor no podía hacer nada — tenía que llamar
-- a administración, que anula desde el detalle de gerencia. Mientras tanto la
-- venta mala sigue contando y ocupando cupo.
--
-- SÓLO CON EL SORTEO ABIERTO, Y ESO ES TODO EL DISEÑO
-- ---------------------------------------------------
-- Cerrado el sorteo, el número ganador está a punto de salir o ya salió, y
-- anular deja de ser «corregir un dedazo» para ser otra cosa: quitar de los
-- libros una apuesta que se sabe perdedora. Por eso la puerta se cierra ahí, y
-- se cierra EN LA BASE y no en la pantalla.
--
-- `fn_anular_ticket` ya lo resuelve: rechaza fuera de un sorteo abierto salvo
-- que se le pase `p_forzar`, y esa bandera la pone la Server Action después de
-- comprobar que quien llama es administrador. El vendedor nunca la manda, así
-- que su límite no depende de que la pantalla se lo esconda.
--
-- LO QUE FALTA NO ES PERMISO: ES INFORMACIÓN
-- ------------------------------------------
-- `fn_mis_tickets` devuelve folio, hora, total y si está anulado, pero NO el
-- identificador del ticket ni el estado del sorteo. Sin lo primero no se puede
-- pedir la anulación; sin lo segundo, la pantalla no sabe a qué fila ofrecerle
-- el botón — y ofrecerlo en todas para que la base rechace la mitad enseña al
-- vendedor a esperar errores.
--
-- Se añaden los dos. Nada de lo que ya devolvía cambia de nombre ni de orden.
-- ===========================================================================

drop function if exists public.fn_mis_tickets(uuid, date, integer);

create function public.fn_mis_tickets(
  p_vendedor_id uuid,
  p_fecha       date,
  p_limite      integer default 40
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
  r_anulado   boolean
)
language sql
stable
security definer
set search_path = public
as $$
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
         t.anulado_en is not null
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  left join public.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.vendedor_id = p_vendedor_id
  group by t.id, t.folio, s.hora, s.estado, t.creado_en, t.total, t.anulado_en
  order by t.creado_en desc
  limit p_limite;
$$;

comment on function public.fn_mis_tickets(uuid, date, integer) is
  'Los tickets del día de un vendedor. Trae el id y el estado del sorteo para poder ofrecer la anulación sólo donde procede.';

revoke execute on function public.fn_mis_tickets(uuid, date, integer)
  from public, anon;
