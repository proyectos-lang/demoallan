-- ===========================================================================
-- El arrastre incluye el saldo de apertura.
--
-- Es la otra mitad de la 0095. Allí se guarda el saldo con el que un vendedor
-- entra al sistema; aquí se hace que la liquidación lo VEA.
--
-- DÓNDE SE SUMA, Y DÓNDE NO
-- -------------------------
-- Se suma en `fn_saldos_por_vendedor`, que es la única función que calcula la
-- columna «anterior» de la pantalla de liquidación. NO se toca nada que
-- informe de VENTA —ni el tablero, ni el informe de gerencia, ni el control—
-- porque un saldo de apertura no es una venta: es una cuenta traída de fuera.
-- Ésa es toda la razón por la que vive en su propia tabla y no en una
-- `liquidacion` inventada.
--
-- LA FECHA MANDA
-- --------------
-- El saldo sólo entra en el arrastre de semanas que empiezan DESPUÉS de su
-- `vigente_desde`. Así, al mirar una semana anterior a la fecha de apertura,
-- el vendedor no aparece debiendo un dinero que en ese momento todavía no se
-- le había cargado. Es la misma regla que ya siguen los sorteos viejos, donde
-- sólo cuenta lo estrictamente anterior a la semana que se está viendo.
--
-- POR QUÉ TAMBIÉN SALE EN LA LISTA
-- --------------------------------
-- La consulta termina filtrando por «activo, o con saldo, o con venta». Un
-- vendedor recién creado al que se le acaba de cargar su deuda no tiene venta
-- ni sorteos viejos: sin añadir el saldo de apertura a esa condición, se le
-- cargaría la deuda y desaparecería de la pantalla donde hay que cobrarla.
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
  r_semana       numeric,   -- saldo de la semana: venta − comisión − premios
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
  -- Lo que quedó sin cerrar ANTES de la semana pedida.
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  /*
   * El saldo con el que entró al sistema, si lo hay.
   *
   * `vigente_desde < p_desde` por lo mismo que los sorteos: mirando una semana
   * anterior a la apertura, ese dinero todavía no se le había cargado.
   */
  apertura as (
    select vendedor_id, sum(monto) as monto
    from public.saldo_inicial
    where anulado_en is null
      and vigente_desde < p_desde
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
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         -- Lo viejo sin cobrar MÁS lo que traía de la libreta anterior.
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0),
         coalesce(a.anterior, 0) + coalesce(ap.monto, 0) + coalesce(s.pendiente, 0)
  from public.vendedor v
  left join antes    a  on a.vendedor_id = v.id
  left join apertura ap on ap.vendedor_id = v.id
  left join semana   s  on s.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera dado de baja que siga debiendo o a
  -- quien se le siga debiendo: si tiene saldo, tiene que salir hasta saldarlo.
  -- El saldo de apertura cuenta para esto: un vendedor nuevo al que se le
  -- acaba de cargar su deuda no tiene ni venta ni sorteos viejos, y sin esto
  -- desaparecería justo de la pantalla donde hay que cobrarle.
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(ap.monto, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by v.codigo;
$saldos$;

comment on function public.fn_saldos_por_vendedor(date, date) is
  'Saldo anterior y actual de cada vendedor para una semana. El anterior incluye el saldo de apertura de la 0095.';

revoke execute on function public.fn_saldos_por_vendedor(date, date)
  from public, anon;
