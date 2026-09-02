-- ===========================================================================
-- La liquidación, vista por semanas.
--
-- Hasta ahora el módulo contestaba una sola pregunta: «qué le queda por pagar
-- a este vendedor en este rango». Faltaban las otras dos, que son las que se
-- hacen antes de abrir la hoja:
--
--   · ¿qué semanas hay y cuál tiene saldo pendiente? — el riel de la izquierda;
--   · ¿cómo va el cobro semana a semana, en total o por vendedor? — el resumen.
--
-- Las tres salen de la misma cuenta, así que salen de la misma función. Con
-- `p_vendedor_id` en nulo devuelve el negocio entero, que es lo que necesita el
-- resumen sin filtro.
--
-- PAGADO Y PENDIENTE SE PARTEN POR `corte_detalle`
-- ------------------------------------------------
-- Una liquidación está pagada cuando figura en un corte, y la tabla tiene
-- `unique (liquidacion_id)`: no puede estar en dos. Por eso `pagado` y
-- `pendiente` suman exactamente `saldo` y no hace falta comprobarlo aparte —lo
-- garantiza la restricción, no la consulta.
--
-- Eso es también lo que hace posible el pago parcial: se cobran el lunes y el
-- martes, y al volver a la semana esos dos días ya no están en `pendiente`
-- pero siguen contando en `saldo`.
--
-- EL SALDO SE RESTA FILA A FILA, no se lee de `utilidad`: las cuatro columnas
-- se redondean por separado al liquidar. Ver la cabecera de la 0036.
-- ===========================================================================

create or replace function allan.fn_liquidacion_por_semana(
  p_vendedor_id uuid default null
) returns table (
  r_inicio        date,
  r_fin           date,
  r_semana        integer,
  r_anio          integer,
  r_sorteos       integer,   -- sorteos distintos de la semana
  r_liquidaciones integer,   -- filas de liquidación; con un vendedor, = sorteos
  r_pagadas       integer,
  r_pendientes    integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_saldo         numeric,   -- todo lo de la semana
  r_pagado        numeric,   -- lo que ya se cerró en un corte
  r_pendiente     numeric    -- lo que falta por cobrar
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with base as (
    select date_trunc('week', s.fecha)::date as inicio,
           s.id as sorteo_id,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where p_vendedor_id is null or lq.vendedor_id = p_vendedor_id
  )
  select inicio,
         (inicio + 6),
         extract(week    from inicio)::integer,
         extract(isoyear from inicio)::integer,
         count(distinct sorteo_id)::integer,
         count(*)::integer,
         count(*) filter (where pagada)::integer,
         count(*) filter (where not pagada)::integer,
         sum(venta),
         sum(comision),
         sum(premios),
         sum(saldo),
         coalesce(sum(saldo) filter (where pagada), 0),
         coalesce(sum(saldo) filter (where not pagada), 0)
  from base
  group by inicio
  -- La más reciente primero: es la que se cobra.
  order by 1 desc;
$$;

comment on function allan.fn_liquidacion_por_semana(uuid) is
  'Cobro semana a semana: cuánto hay, cuánto se pagó y cuánto falta. Sin vendedor, el negocio entero.';

revoke execute on function allan.fn_liquidacion_por_semana(uuid) from public, anon;
