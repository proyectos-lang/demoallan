-- ===========================================================================
-- La jugada salía con un punto de más: «12:20.» en vez de «12:20».
--
-- CAUSA
-- -----
-- `to_char(monto, 'FM999999990.99')` sobre un monto entero. `FM` quita los
-- espacios de relleno y los ceros no significativos de la parte decimal, pero
-- NO quita el separador decimal en sí: 20.00 se convierte en «20.» y el punto
-- se queda ahí, huérfano.
--
-- Es cosmético, pero esta columna existe para cotejarla contra el papel que
-- tiene el cliente en la mano. Un punto de más en cada número mete ruido justo
-- donde se necesita leer rápido y comparar dos tickets de un vistazo.
--
-- ARREGLO
-- -------
-- Se decide por monto: si es entero se escribe sin decimales, y si no, con
-- dos. En este negocio las apuestas son de 5, 10, 20 lempiras —los montos con
-- céntimos no existen en la práctica— así que casi siempre se ve «20», y el
-- caso raro sigue mostrándose completo en vez de redondearse en silencio.
--
-- Sólo cambia esa expresión; el resto de la función es idéntico a la 0057.
-- ===========================================================================

create or replace function public.fn_detalle_venta(
  p_desde            date,
  p_hasta            date,
  p_vendedores       uuid[] default null,
  p_hora             public.hora_sorteo default null,
  p_incluir_anulados boolean default false,
  p_limite           integer default 500
)
returns table (
  r_ticket_id      uuid,
  r_folio          text,
  r_fecha          date,
  r_hora           public.hora_sorteo,
  r_estado         public.estado_sorteo,
  r_numero_ganador smallint,
  r_vendedor_id    uuid,
  r_codigo         text,
  r_vendedor       text,
  r_creado_en      timestamptz,
  r_lineas         integer,
  r_total          numeric,
  r_premio         numeric,
  r_jugada         text,
  r_anulado        boolean,
  r_motivo         text,
  r_repetido       boolean,
  r_segundos       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select t.id,
           t.folio,
           s.fecha,
           s.hora,
           s.estado,
           s.numero_ganador,
           t.vendedor_id,
           v.codigo,
           v.nombre,
           t.creado_en,
           t.anulado_en,
           t.motivo_anulacion,
           count(l.id)::integer      as lineas,
           sum(l.monto)              as total,
           sum(l.premio)             as premio,
           -- La jugada tal como se lee en el papel: número y monto, en orden.
           -- Entero sin decimales, con céntimos sólo si de verdad los hay.
           string_agg(
             lpad(l.numero::text, 2, '0') || ':' ||
             case when l.monto = trunc(l.monto)
                  then trunc(l.monto)::bigint::text
                  else to_char(l.monto, 'FM999999990.00')
             end,
             '  ' order by l.numero, l.monto) as jugada,
           -- La firma compara CONTENIDO, no presentación: es lo que permite
           -- detectar que dos tickets llevan exactamente la misma apuesta.
           string_agg(l.numero || ':' || l.monto, ',' order by l.numero, l.monto) as firma
    from public.ticket t
    join public.sorteo   s on s.id = t.sorteo_id
    join public.vendedor v on v.id = t.vendedor_id
    join public.linea    l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
      and (p_incluir_anulados or t.anulado_en is null)
    group by t.id, t.folio, s.fecha, s.hora, s.estado, s.numero_ganador,
             t.vendedor_id, v.codigo, v.nombre, t.creado_en,
             t.anulado_en, t.motivo_anulacion
  ),
  -- Se mira el ticket ANTERIOR con la misma jugada, del mismo vendedor y
  -- sorteo. `lag` sobre esa partición es exactamente esa pregunta.
  marcado as (
    select b.*,
           lag(b.creado_en) over (
             partition by b.vendedor_id, b.hora, b.fecha, b.firma
             order by b.creado_en
           ) as anterior
    from base b
  )
  select m.id,
         m.folio,
         m.fecha,
         m.hora,
         m.estado,
         m.numero_ganador,
         m.vendedor_id,
         m.codigo,
         m.nombre,
         m.creado_en,
         m.lineas,
         m.total,
         m.premio,
         m.jugada,
         m.anulado_en is not null,
         m.motivo_anulacion,
         m.anterior is not null,
         -- Cuántos segundos tras el ticket gemelo anterior. Nulo si es el
         -- primero de su jugada: no hay nada con qué compararlo.
         case when m.anterior is not null
              then round(extract(epoch from (m.creado_en - m.anterior))::numeric, 2)
         end
  from marcado m
  -- Cronológico ascendente: se lee como ocurrió el día, que es como el
  -- vendedor recuerda su jornada y como se cotejan los papeles.
  order by m.fecha, m.hora, m.codigo, m.creado_en
  limit greatest(p_limite, 1);
$$;

comment on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer) is
  'Venta ticket por ticket con su jugada, para uno o varios vendedores. Marca los que repiten una jugada ya vista en el mismo sorteo.';

revoke execute on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer)
  from public, anon;
