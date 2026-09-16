-- ===========================================================================
-- El vendedor necesita ver QUÉ números lleva cada ticket suyo.
--
-- PARA QUÉ
-- --------
-- Hasta ahora `fn_mis_tickets` decía cuántas líneas y cuánto suma, pero no
-- cuáles. Con eso alcanza para reconocer una venta —«¿me registró usted
-- esto?»— y para anularla entera, que es lo único que se podía hacer.
--
-- Para CORREGIRLA no alcanza: hay que poder ver el 07:100 y cambiarlo a
-- 07:250 sin tocar las otras once líneas. Sin la jugada, la pantalla de
-- corrección tendría que pedir las líneas en un segundo viaje, y el vendedor
-- esperaría por un dato que ya podía venir con la fila.
--
-- EL MISMO FORMATO QUE EL RESTO DEL SISTEMA
-- -----------------------------------------
-- `07:100  42:250`, tal como lo arma `fn_detalle_venta` desde la 0058: número
-- con dos cifras, monto entero cuando no tiene céntimos. No se inventa uno
-- nuevo porque la pantalla de corrección del administrador ya sabe leer ése, y
-- dos formatos para el mismo dato son dos maneras de escribir el mismo error.
--
-- POR QUÉ NO SE FILTRA NADA MÁS AQUÍ
-- ----------------------------------
-- Esta función ya está atada al vendedor por parámetro, así que la jugada que
-- devuelve es siempre la suya. Quién puede corregir y cuándo NO se decide en
-- esta consulta: se decide en la Server Action, que es el único sitio con la
-- sesión firmada delante. Desde la 0024 la aplicación habla como
-- `service_role` y cualquier guarda escrita aquí retornaría sin mirar nada.
--
-- El `left join` sobre `linea` se conserva: un ticket anulado puede quedarse
-- sin líneas, y perderlo de la lista sería peor que mostrarlo sin jugada.
--
-- POR QUÉ HAY QUE BORRARLA ANTES
-- ------------------------------
-- Añadir `r_jugada` cambia el TIPO DE RETORNO, y `create or replace` no puede
-- cambiarlo: Postgres responde `42P13 cannot change return type`. Hay que
-- borrar la función primero, con su firma exacta entre paréntesis.
--
-- La firma completa importa, y ésta es la lección más cara de este proyecto:
-- un `drop` sin ella —o peor, ninguno— no sustituye la función, CREA UNA
-- SEGUNDA. A partir de ahí toda llamada queda ambigua, Postgres se niega con
-- `is not unique`, y en la 0083 eso bloqueó las ventas en producción hasta que
-- la 0085 borró la duplicada. Aquí el error salta al aplicar, que es el buen
-- momento para enterarse.
--
-- El `if exists` permite volver a correr este archivo sin que falle en una
-- base donde ya se aplicó.
-- ===========================================================================

drop function if exists public.fn_mis_tickets(uuid, date, integer);

create or replace function public.fn_mis_tickets(
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
  limit p_limite;
$mis_tickets$;

comment on function public.fn_mis_tickets(uuid, date, integer) is
  'Los tickets del día de un vendedor, con su jugada. Trae el id y el estado del sorteo para ofrecer anular y corregir sólo donde procede.';

revoke execute on function public.fn_mis_tickets(uuid, date, integer)
  from public, anon;
