-- ===========================================================================
-- La pestaña de saldos cuadra con la hoja y con la impresión.
--
-- EL DESCUADRE DE V-047
-- ---------------------
-- Debía 30.255,25 de apertura; esa semana la casa le quedó debiendo 9.177. La
-- impresión hacía la rebaja y decía 21.078, pero la pestaña de saldos mostraba
-- «saldo anterior 30.255», sin restar los 9.177.
--
-- POR QUÉ CADA PANTALLA DABA UNA CIFRA
-- ------------------------------------
-- Las dos colocan el saldo de apertura en semanas distintas:
--
--   · La HOJA lo trata como pendiente DE SU SEMANA. Si esa semana cerró en
--     negativo, la apertura y el negativo se compensan ahí mismo, y el
--     arrastre a la semana siguiente ya sale rebajado: 30.255 − 9.177.
--
--   · SALDOS lo metía en «anterior» con `vigente_desde <= p_hasta`, que
--     incluye la apertura de la SEMANA EN CURSO. Pero el saldo negativo de esa
--     semana va en la columna «de la semana», aparte. Así «anterior» sumaba
--     la apertura entera sin el negativo que le corresponde: 30.255 pelado.
--
-- Las dos cifras eran defendibles por separado; lo que no puede ser es que la
-- misma persona lea dos números para lo mismo.
--
-- QUÉ SE IGUALA
-- -------------
-- «Anterior» pasa a contar sólo la apertura de semanas ESTRICTAMENTE
-- anteriores a la que se mira —`vigente_desde < p_desde`, la misma regla que
-- ya usa para los sorteos viejos—. La apertura de la semana en curso baja a la
-- columna «de la semana», donde se compensa con lo que se jugó, exactamente
-- como hace la hoja. El «actual» —anterior + pendiente— no cambia de valor:
-- las dos piezas se reordenan, no se suman ni se restan de más.
--
-- Resultado: «anterior» de saldos == «arrastre» de la hoja, y «actual» ==
-- «acumulado». Las tres pantallas —saldos, hoja e impresión— dicen lo mismo.
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
  order by v.codigo;
$saldos$;

comment on function public.fn_saldos_por_vendedor(date, date) is
  'Saldo anterior y actual por vendedor. «Anterior» es el arrastre de semanas previas (sorteos y apertura); la apertura de la semana en curso va en «de la semana». Cuadra con fn_liquidacion_por_semana.';

revoke execute on function public.fn_saldos_por_vendedor(date, date)
  from public, anon;
