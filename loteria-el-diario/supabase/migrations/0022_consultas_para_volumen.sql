-- ===========================================================================
-- Tres consultas que el volumen dejó inservibles.
--
-- Con el histórico cargado, las pantallas tardaban esto en responder:
--
--     simulador        17,3 s
--     geo              16,4 s
--     punto de venta    8,8 s
--     tablero           8,7 s
--     reportes          7,1 s
--
-- Ninguna de las tres causas es «hay muchos datos»: las tres son consultas que
-- traen filas para trabajarlas fuera de la base, o que impiden a PostgreSQL
-- filtrar antes de agregar. Con unos miles de filas no se notaba.
-- ===========================================================================

-- --- 1. Un LEFT JOIN que impedía filtrar -----------------------------------
--
-- `fn_resumen_dia` tardaba 8,4 s para UN día. Tres sorteos y unas diez mil
-- líneas no pueden costar eso.
--
-- La causa: `left join v_agregado_sorteo_vendedor a on a.sorteo_id = s.id`
-- con el filtro `where s.fecha = p_fecha` en el lado IZQUIERDO. En un LEFT
-- JOIN, PostgreSQL no puede empujar esa condición dentro de la vista agrupada
-- —hacerlo cambiaría el resultado, porque las filas sin pareja deben
-- conservarse—, así que agrega las 746 mil líneas enteras y sólo después junta.
--
-- `fn_desglose_dia`, que filtra la vista directamente, tardaba 354 ms.
--
-- El arreglo es repetir la fecha en el ON. Ahí sí se puede empujar: la
-- restricción se aplica a la vista antes de agregar, y el LEFT JOIN sigue
-- devolviendo los sorteos sin ventas.

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
  left join allan.v_agregado_sorteo_vendedor a
    on a.sorteo_id = s.id
   and a.fecha = p_fecha        -- <- redundante en lógica, decisivo en plan
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

-- --- 2. El mapa contaba líneas en el navegador -----------------------------
--
-- La pantalla de geo pedía los tickets del día y después TODAS las líneas de
-- esos ~700 tickets, sólo para contar cuántas tenía cada uno. Eran unas tres
-- mil filas por la red y un recorrido de `allan.linea` por cada carga.
--
-- Contar es exactamente lo que la base hace mejor.

create or replace function allan.fn_mapa_dia(
  p_fecha       date,
  p_vendedor_id uuid default null
)
returns table (
  r_folio       text,
  r_lat         double precision,
  r_lng         double precision,
  r_total       numeric,
  r_creado_en   timestamptz,
  r_vendedor_id uuid,
  r_hora        allan.hora_sorteo,
  r_lineas      integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.folio, t.lat, t.lng, t.total, t.creado_en, t.vendedor_id, s.hora,
         count(l.id)::integer
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.anulado_en is null
    and t.lat is not null
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
  group by t.folio, t.lat, t.lng, t.total, t.creado_en, t.vendedor_id, s.hora;
$$;

comment on function allan.fn_mapa_dia(date, uuid) is
  'Un punto por ticket para el mapa, con su número de líneas ya contado. Sustituye a traer las líneas y contarlas en el cliente.';

-- --- 3. El punto de venta sumaba diez mil líneas en el navegador -----------
--
-- Traía todas las líneas del sorteo —unas diez mil con treinta vendedores—
-- para repartirlas en un vector de cien casillas por vendedor. El resultado son
-- como mucho 30 × 100 filas: agregarlas en SQL manda tres mil filas en vez de
-- diez mil, y el trabajo lo hace quien tiene los índices.

create or replace function allan.fn_vendido_por_vendedor(p_sorteo_id uuid)
returns table (
  r_vendedor_id uuid,
  r_numero      smallint,
  r_vendido     numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.vendedor_id, l.numero, sum(l.monto)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.vendedor_id, l.numero;
$$;

comment on function allan.fn_vendido_por_vendedor(uuid) is
  'Lo vendido por cada vendedor en cada número de un sorteo. Es el dato que el POS usa para mostrar el saldo al teclear; sigue sin ser autoritativo (§3): la venta la valida fn_registrar_ticket con la fila bloqueada.';

revoke execute on function allan.fn_mapa_dia(date, uuid) from public, anon;
revoke execute on function allan.fn_vendido_por_vendedor(uuid) from public, anon;
