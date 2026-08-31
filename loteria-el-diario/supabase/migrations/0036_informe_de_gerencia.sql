-- ===========================================================================
-- El informe que el gerente mira todos los días.
--
-- Hasta ahora vivía en una hoja de cálculo —«032 SEMANA 01 DE AGOSTO DE
-- 2026.xlsx», pestaña DASHBOARD— con una fila por vendedor y una columna por
-- cada paso de la cuenta. Esta función devuelve exactamente esas columnas para
-- cualquier rango: un día, una semana o un mes.
--
-- LA CUENTA DE LA HOJA, COMPROBADA CONTRA LA BASE
-- ----------------------------------------------
--   comisión    = venta × porcentaje
--   total bruto = venta − comisión
--   total neto  = total bruto − pago premiado
--
-- Es, término a término, lo que ya guarda allan.liquidacion: venta, comision,
-- premios y utilidad = venta − comision − premios. O sea que el «total neto»
-- de la hoja es la utilidad de siempre. No hay cuenta nueva que inventar; lo
-- que falta es el desglose que la hoja enseña y la liquidación no guarda.
--
-- Se comprobó fila a fila contra la hoja. M. CAROL: venta 82.090, comisión al
-- 20 % son 16.418, bruto 65.672; premiado 1.155 al factor 70 son 80.850 de
-- pago; neto 65.672 − 80.850 = −15.178, que es lo que dice la casilla.
--
-- LO QUE NO ESTABA GUARDADO: «PREMIADO»
-- -------------------------------------
-- La hoja separa lo APOSTADO al número ganador («Premiado») de lo PAGADO por
-- él («Pago premiado» = premiado × factor). La liquidación sólo guarda lo
-- segundo. Se recupera sumando el monto de las líneas ganadoras, que son una
-- de cada cien: el índice parcial `linea_ganadoras` está para eso.
--
-- SALE TODO EL PADRÓN, TAMBIÉN QUIEN NO VENDIÓ
-- --------------------------------------------
-- La hoja lista a los ciento cinco vendedores tenga cada uno movimiento o no,
-- y con razón: un vendedor en cero es una noticia. Si se parte de las
-- liquidaciones, ése desaparece sin dejar rastro — la peor forma de no
-- aparecer, porque no se distingue de no existir. Se parte del padrón.
--
-- Quien esté dado de baja pero haya vendido en el rango también sale: si movió
-- dinero esa semana, tiene que estar en las cuentas de esa semana. Filtrar la
-- tabla es cosa de la pantalla, no de aquí.
--
-- COLUMNAS QUE NO SE TRAEN
-- ------------------------
-- «Regalado» y «Pago regalado» quedan fuera por decisión del negocio: ya no se
-- usan. «Pasados» sale en cero en las ciento cinco filas de la hoja, así que
-- una columna de ceros no aporta nada. Si algún día vuelven, vuelven aquí.
--
-- EL NETO SE RESTA AQUÍ, NO SE SUMA DE `utilidad`
-- -----------------------------------------------
-- `fn_liquidar_sorteo` guarda venta, comisión, premios y utilidad en cuatro
-- columnas numeric(14,2), y redondea CADA UNA por separado; la utilidad se
-- calcula antes de redondear. Así que round(V) − round(C) − round(P) no
-- siempre es round(V − C − P): se separan hasta un céntimo por liquidación.
--
-- Medido sobre una semana del histórico: 22 de 630 filas difieren, la peor en
-- L 0.01, y acumulando por vendedor la mayor separación es de L 0.07.
--
-- Da igual para un total, pero no para este informe: el gerente lo comprueba
-- con calculadora, y una fila donde venta − comisión − premios no da el neto
-- que está escrito al lado destruye la confianza en toda la tabla. Por eso el
-- neto se resta de las tres columnas que se enseñan, y la fila cuadra siempre.
--
-- FACTOR Y PORCENTAJE SON EFECTIVOS, NO NOMINALES
-- -----------------------------------------------
-- En la hoja son constantes por vendedor porque la hoja es de una semana. En
-- un rango cualquiera un vendedor pudo cambiar de parámetros —cada línea
-- lleva congelados los suyos—, así que aquí se devuelve lo que de verdad
-- ocurrió: el factor es pago÷premiado y el porcentaje es comisión÷venta. Con
-- parámetros estables dan el mismo 70 y el mismo 0.20 de la hoja.
-- ===========================================================================

create or replace function allan.fn_informe_gerencia(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_venta        numeric,
  r_premiado     numeric,
  r_factor       numeric,
  r_pago         numeric,
  r_porcentaje   numeric,
  r_comision     numeric,
  r_bruto        numeric,
  r_neto         numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  -- Lo apostado al número que salió. Son una de cada cien líneas, y el índice
  -- parcial `linea_ganadoras` cubre justo esta condición.
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: la hoja lista a todo el
  -- mundo, y un vendedor que no vendió nada en la semana es justo lo que el
  -- gerente quiere ver. Con un `join` desde liquidacion desaparecía sin dejar
  -- rastro, que es la peor forma de no aparecer.
  select v.id,
         v.codigo,
         v.nombre,
         coalesce(q.venta, 0),
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada.
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         coalesce(q.premios, 0),
         case when coalesce(q.venta, 0) > 0
              then round(q.comision / q.venta, 4) else 0 end,
         coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0),
         -- El neto sale de restar lo que se enseña, no de sumar `utilidad`.
         -- Ver la nota de la cabecera sobre el céntimo de redondeo.
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado a on a.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera que haya vendido en el rango aunque
  -- después se le diera de baja: si movió dinero esa semana, tiene que salir.
  where v.activo or q.venta is not null
  -- De mayor a menor venta: el gerente mira primero quién mueve más, y los que
  -- no movieron nada caen solos al final.
  order by coalesce(q.venta, 0) desc, v.codigo;
$$;

comment on function allan.fn_informe_gerencia(date, date) is
  'El informe de gerencia, una fila por vendedor: venta, premiado, factor, pago, comisión, bruto y neto. Sólo sorteos liquidados.';

revoke execute on function allan.fn_informe_gerencia(date, date)
  from public, anon;
