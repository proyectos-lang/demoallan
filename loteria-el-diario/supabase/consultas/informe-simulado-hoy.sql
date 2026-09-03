-- ===========================================================================
-- CÓMO QUEDARÍA EL INFORME DE GERENCIA DE HOY, SIN LOS DUPLICADOS.
--
-- SÓLO CONSULTA. No modifica ni una fila: no anula, no borra y no liquida.
-- Se puede ejecutar cuantas veces haga falta, también en producción.
--
-- POR QUÉ LA PANTALLA MUESTRA CEROS
-- ---------------------------------
-- El informe de gerencia se arma desde `public.liquidacion`, y esa tabla sólo
-- se escribe al liquidar un sorteo. Hoy ninguno tiene número ganador —11:00
-- cerrado sin número, 15:00 y 20:00 abiertos— así que no hay ni una fila que
-- mostrar. No es un fallo: mientras no se sepa qué número salió no se sabe
-- cuánto se pagó en premios, y un «neto» sin premios sería una proyección
-- disfrazada de resultado.
--
-- Este guion salta ese paso y calcula lo mismo DESDE LAS LÍNEAS, que es de
-- donde saldría la liquidación. Son las cifras que mostrará el informe cuando
-- el sorteo se liquide.
--
-- LO QUE NO PUEDE CALCULAR
-- ------------------------
-- Premios y neto. Sin número ganador no hay nada que pagar, así que aquí sólo
-- salen venta, comisión y bruto. El neto aparecerá al capturar el resultado.
--
-- QUÉ CUENTA COMO DUPLICADO
-- -------------------------
-- Un ticket con EXACTAMENTE los mismos números y montos que el anterior del
-- mismo vendedor y sorteo, emitido 3 segundos o menos después. Los datos se
-- agrupan solos ahí: por debajo de 3 s hay trece copias y luego un hueco hasta
-- 5,18 s. Lo más espaciado se conserva porque puede ser una venta real
-- repetida — dos personas apostando lo mismo.
--
-- PARA OTRO DÍA O DISTINTO CORTE: cambie `dia` y `segundos` en el bloque
-- `parametros` de cada consulta.
-- ===========================================================================


-- ###########################################################################
-- 1. EL INFORME POR VENDEDOR, COMO SE VERÍA
-- ###########################################################################

with parametros as (
  select date '2026-09-03' as dia, 3.01 as segundos
),
-- Cada ticket vivo con su «firma»: la lista de números y montos, ordenada.
-- Dos tickets con la misma firma llevan exactamente la misma jugada.
tickets as (
  select t.id, t.vendedor_id, t.sorteo_id, t.total, t.creado_en,
         string_agg(l.numero || ':' || l.monto, ',' order by l.numero, l.monto) as firma
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  join public.linea  l on l.ticket_id = t.id
  cross join parametros p
  where s.fecha = p.dia
    and t.anulado_en is null
  group by t.id, t.vendedor_id, t.sorteo_id, t.total, t.creado_en
),
-- `lag` mira el ticket anterior con la MISMA jugada, del mismo vendedor y el
-- mismo sorteo. Si salió a menos de N segundos, es una copia.
marcados as (
  select t.*,
         lag(t.creado_en) over (
           partition by t.vendedor_id, t.sorteo_id, t.firma
           order by t.creado_en
         ) as anterior
  from tickets t
),
clasificados as (
  select m.*,
         (m.anterior is not null
          and extract(epoch from (m.creado_en - m.anterior)) <= p.segundos) as es_duplicado
  from marcados m
  cross join parametros p
)
select
  v.codigo                                       as vendedor,
  v.nombre,
  sum(c.total)                                   as venta_actual,
  coalesce(sum(c.total) filter (where c.es_duplicado), 0) as duplicado,
  sum(c.total) filter (where not c.es_duplicado) as venta_corregida,
  round(pv.comision * 100, 2)                    as pct_comision,
  -- La comisión sale del parámetro vigente del vendedor, que es el mismo que
  -- la liquidación congela en cada línea al venderse.
  round(sum(c.total) filter (where not c.es_duplicado) * pv.comision, 2) as comision,
  round(sum(c.total) filter (where not c.es_duplicado) * (1 - pv.comision), 2) as bruto,
  count(*) filter (where not c.es_duplicado)     as tickets,
  count(*) filter (where c.es_duplicado)         as tickets_dup
from clasificados c
join public.vendedor v on v.id = c.vendedor_id
join public.parametro_vendedor pv
  on pv.vendedor_id = v.id and pv.vigente_hasta is null
group by v.codigo, v.nombre, pv.comision
order by v.codigo;


-- ###########################################################################
-- 2. EL MISMO CORTE, SORTEO POR SORTEO
-- ###########################################################################

with parametros as (
  select date '2026-09-03' as dia, 3.01 as segundos
),
tickets as (
  select t.id, t.vendedor_id, t.sorteo_id, s.hora, t.total, t.creado_en,
         string_agg(l.numero || ':' || l.monto, ',' order by l.numero, l.monto) as firma
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  join public.linea  l on l.ticket_id = t.id
  cross join parametros p
  where s.fecha = p.dia and t.anulado_en is null
  group by t.id, t.vendedor_id, t.sorteo_id, s.hora, t.total, t.creado_en
),
marcados as (
  select t.*, lag(t.creado_en) over (
    partition by t.vendedor_id, t.sorteo_id, t.firma order by t.creado_en) as anterior
  from tickets t
),
clasificados as (
  select m.*,
         (m.anterior is not null
          and extract(epoch from (m.creado_en - m.anterior)) <= p.segundos) as es_duplicado
  from marcados m cross join parametros p
)
select
  c.hora                                         as sorteo,
  s.estado,
  count(*)                                       as tickets_ahora,
  sum(c.total)                                   as venta_ahora,
  count(*) filter (where c.es_duplicado)         as duplicados,
  coalesce(sum(c.total) filter (where c.es_duplicado), 0) as venta_duplicada,
  count(*) filter (where not c.es_duplicado)     as tickets_limpios,
  sum(c.total) filter (where not c.es_duplicado) as venta_limpia
from clasificados c
join public.sorteo s on s.id = c.sorteo_id
group by c.hora, s.estado
order by c.hora;


-- ###########################################################################
-- 3. EL DETALLE DE CADA DUPLICADO, PARA REVISARLO UNO A UNO
-- ###########################################################################

with parametros as (
  select date '2026-09-03' as dia, 3.01 as segundos
),
tickets as (
  select t.id, t.folio, t.vendedor_id, t.sorteo_id, s.hora, t.total, t.creado_en,
         string_agg(l.numero || ':' || l.monto, ',' order by l.numero, l.monto) as firma,
         string_agg(lpad(l.numero::text, 2, '0') || ':' || l.monto, '  ' order by l.numero) as jugada
  from public.ticket t
  join public.sorteo s on s.id = t.sorteo_id
  join public.linea  l on l.ticket_id = t.id
  cross join parametros p
  where s.fecha = p.dia and t.anulado_en is null
  group by t.id, t.folio, t.vendedor_id, t.sorteo_id, s.hora, t.total, t.creado_en
),
marcados as (
  select t.*,
         lag(t.creado_en) over (partition by t.vendedor_id, t.sorteo_id, t.firma
                                order by t.creado_en) as anterior,
         lag(t.folio)     over (partition by t.vendedor_id, t.sorteo_id, t.firma
                                order by t.creado_en) as folio_original
  from tickets t
)
select
  v.codigo                                                          as vendedor,
  m.hora                                                            as sorteo,
  m.folio_original                                                  as original,
  m.folio                                                           as copia_a_anular,
  round(extract(epoch from (m.creado_en - m.anterior))::numeric, 2) as segundos_despues,
  m.total                                                           as monto,
  m.jugada
from marcados m
join public.vendedor v on v.id = m.vendedor_id
cross join parametros p
where m.anterior is not null
  and extract(epoch from (m.creado_en - m.anterior)) <= p.segundos
order by m.creado_en;
