-- ===========================================================================
-- Saldos por vendedor, de una semana, para todo el padrón.
--
-- La cuenta ya existe: `fn_liquidacion_por_semana` la hace para UN vendedor y
-- devuelve `r_arrastre` —lo pendiente de semanas anteriores— y `r_acumulado`.
-- Pero llamarla treinta veces para armar la tabla del padrón tarda unos siete
-- segundos, medido. Aquí se hace la misma cuenta una sola vez, agrupando por
-- vendedor.
--
-- LA ARITMÉTICA ES LA MISMA, LETRA POR LETRA
-- ------------------------------------------
-- Y tiene que serlo: este informe y el módulo de liquidación se leen uno al
-- lado del otro, y si difieren aunque sea en un céntimo lo que se rompe es la
-- confianza en los dos. De ahí que:
--
--   · el saldo de cada liquidación se resta fila a fila —venta − comisión −
--     premios— y no se lee de `utilidad`, que se redondea aparte (ver 0036);
--   · pagado y pendiente se parten por `corte_detalle`, igual que en la 0044;
--   · el arrastre son las semanas ESTRICTAMENTE anteriores, como en la 0045.
--
-- SALEN TODOS LOS DEL PADRÓN, aunque esa semana no movieran nada: un vendedor
-- que no vendió pero arrastra saldo de antes es justo a quien hay que ir a
-- cobrar, y si desapareciera de la lista nadie se acordaría de él. Los que ni
-- movieron ni arrastran salen en cero, y la pantalla puede ocultarlos.
-- ===========================================================================

create or replace function allan.fn_saldos_por_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_activo       boolean,
  r_anterior     numeric,   -- pendiente de las semanas anteriores a p_desde
  r_venta        numeric,   -- lo que movió en la semana
  r_comision     numeric,
  r_premios      numeric,
  r_semana       numeric,   -- saldo de la semana: venta − comisión − premios
  r_liquidado    numeric,   -- la parte de la semana ya cerrada en un corte
  r_pendiente    numeric,   -- lo que falta de la semana
  r_actual       numeric    -- r_anterior + r_pendiente
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with fila as (
    select lq.vendedor_id,
           s.fecha,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
  ),
  -- Lo que quedó sin cerrar ANTES de la semana pedida.
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  -- Lo de la semana, separando lo ya cerrado de lo que falta.
  semana as (
    select vendedor_id,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as liquidado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from fila
    where fecha between p_desde and p_hasta
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         v.nombre,
         v.activo,
         coalesce(a.anterior, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0),
         coalesce(a.anterior, 0) + coalesce(s.pendiente, 0)
  from allan.vendedor v
  left join antes  a on a.vendedor_id = v.id
  left join semana s on s.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera dado de baja que siga debiendo o a
  -- quien se le siga debiendo: si tiene saldo, tiene que salir hasta saldarlo.
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by v.codigo;
$$;

comment on function allan.fn_saldos_por_vendedor(date, date) is
  'Saldo anterior y actual de cada vendedor para una semana. Misma aritmética que fn_liquidacion_por_semana.';

revoke execute on function allan.fn_saldos_por_vendedor(date, date) from public, anon;
