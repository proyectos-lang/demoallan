-- ===========================================================================
-- Las listas de clientes se ordenan por ALIAS, alfabéticamente.
--
-- Pedido: en todas las tablas donde salen clientes, el orden es por el alias
-- (y por el nombre cuando no hay alias, que es lo que muestra `fn_rotulo`), de
-- la A a la Z, ignorando mayúsculas. Antes iban por código de vendedor.
--
-- Ésta: la pestaña de saldos por vendedor. Sólo cambia el `order by`.
-- ===========================================================================

create or replace function public.fn_saldos_por_vendedor(
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
  r_semana       numeric,   -- saldo de la semana, con la apertura de la semana
  r_liquidado    numeric,   -- la parte de la semana ya cerrada en un corte
  r_pendiente    numeric,   -- lo que falta de la semana
  r_actual       numeric    -- r_anterior + r_pendiente
)
language sql
stable
security definer
set search_path = public
as $saldos$
  with fila as (
    select lq.vendedor_id,
           s.fecha,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
  ),
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  /*
   * El saldo de apertura, PARTIDO en dos por su fecha:
   *
   *   · el de semanas anteriores a la que se mira va al «anterior», junto con
   *     los sorteos viejos sin cerrar;
   *   · el de la semana en curso baja a la columna «de la semana», para
   *     compensarse con lo que se jugó —igual que en la hoja—.
   *
   * Es lo que hace que «anterior» sea el mismo arrastre que enseña la hoja.
   */
  apertura_antes as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null and saldado_en is null
      and vigente_desde < p_desde
    group by vendedor_id
  ),
  apertura_semana as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null and saldado_en is null
      and vigente_desde >= p_desde
      and vigente_desde <= p_hasta
    group by vendedor_id
  ),
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
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         -- Anterior: sorteos viejos sin cerrar MÁS la apertura de antes.
         coalesce(a.anterior, 0) + coalesce(apa.monto, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         -- De la semana: el saldo de los sorteos MÁS la apertura de esta
         -- semana, que es la que se compensa aquí.
         coalesce(s.saldo, 0) + coalesce(aps.monto, 0),
         coalesce(s.liquidado, 0),
         -- Pendiente de la semana: lo que falta de los sorteos, más la
         -- apertura de esta semana, que también está sin cobrar.
         coalesce(s.pendiente, 0) + coalesce(aps.monto, 0),
         -- Actual: anterior + pendiente. Mismo total de siempre; sólo cambió
         -- en qué columna vive la apertura de la semana en curso.
         coalesce(a.anterior, 0) + coalesce(apa.monto, 0)
           + coalesce(s.pendiente, 0) + coalesce(aps.monto, 0)
  from public.vendedor v
  left join antes           a   on a.vendedor_id = v.id
  left join apertura_antes  apa on apa.vendedor_id = v.id
  left join apertura_semana aps on aps.vendedor_id = v.id
  left join semana          s   on s.vendedor_id = v.id
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(apa.monto, 0) <> 0
     or coalesce(aps.monto, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$saldos$;

revoke execute on function public.fn_saldos_por_vendedor(date, date) from public, anon;
