-- ===========================================================================
-- El factor de pago se congela en la captura por totales.
--
-- LO QUE REPORTÓ EL USUARIO
-- -------------------------
-- Un premio se registró bien —la venta y el premio salen correctos— pero al
-- buscar los PREMIADOS aparecían de menos: «se hizo un premio de 90 y en las
-- listas sólo salen 70, faltan 20».
--
-- LA CAUSA
-- --------
-- El «premiado» de una captura por totales —lo apostado al número ganador— no
-- se guarda: se DEDUCE dividiendo el premio pagado entre el factor de pago
-- (premiado = premios / factor), que es la operación inversa de cómo se calculó
-- el premio (premio = apostado × factor). Pero esa división usaba el factor
-- VIGENTE HOY, no el que estaba cuando se capturó.
--
-- Cuando a un vendedor le cambia el factor DESPUÉS de capturar, el premiado
-- deducido cambia solo. Se comprobó con V-064: tenía factor 70 hasta el 14-sep
-- y 80 desde entonces; sus capturas viejas, deducidas hoy con 80, muestran un
-- premiado más bajo del real. Con el factor subiendo, el premiado baja y
-- «faltan» lempiras en las listas de premiados —justo lo reportado—.
--
-- La venta y el premio salían bien porque esos SÍ se guardan; sólo el premiado
-- deducido se descuadraba. Y la liquidación (venta, comisión, premios, saldo)
-- no depende del premiado deducido, así que ningún saldo ni corte se movió: el
-- fallo era sólo en la cifra informativa de «premiado».
--
-- LA CORRECCIÓN (la que el propio código ya anticipaba)
-- ----------------------------------------------------
-- Congelar el factor en la captura, igual que ya se congela la comisión. Esta
-- migración añade la columna y rellena las capturas existentes con el factor
-- que el vendedor tenía EN LA FECHA DE SU SORTEO, reconstruido del historial de
-- `parametro_vendedor`. Las funciones de escritura y de lectura se actualizan en
-- las migraciones siguientes (una por función, para que un fallo no aborte
-- todo).
-- ===========================================================================

alter table public.venta_total
  add column if not exists factor_congelado numeric(6,2);

comment on column public.venta_total.factor_congelado is
  'El factor de pago del vendedor en el momento de la captura. Se usa para deducir el premiado (premios / factor) con el factor real de entonces, no con el vigente hoy. Nulo en capturas anteriores a esta columna que el backfill no pudo resolver; ahí se cae al factor vigente.';

-- --------------------------------------------------------------------------
-- Backfill: el factor vigente en la FECHA DEL SORTEO de cada captura.
--
-- Se busca en el historial de parámetros la fila que estaba vigente ese día:
-- `vigente_desde <= fecha` y (`vigente_hasta` nulo o > fecha). Se toma la más
-- reciente que cumpla, por si hubo varios cambios. Las capturas de vendedores
-- cuyo factor nunca cambió quedan con su mismo factor —sin efecto visible—; las
-- de V-064 recuperan el 70 con el que de verdad se calcularon sus premios.
-- --------------------------------------------------------------------------
update public.venta_total vt
set factor_congelado = sub.factor_pago
from (
  select vt2.id,
         (
           select pv.factor_pago
           from public.parametro_vendedor pv
           where pv.vendedor_id = vt2.vendedor_id
             and pv.vigente_desde <= (s.fecha + time '23:59') at time zone 'America/Tegucigalpa'
             and (pv.vigente_hasta is null
                  or pv.vigente_hasta > (s.fecha + time '00:00') at time zone 'America/Tegucigalpa')
           order by pv.vigente_desde desc
           limit 1
         ) as factor_pago
  from public.venta_total vt2
  join public.sorteo s on s.id = vt2.sorteo_id
) sub
where vt.id = sub.id
  and vt.factor_congelado is null
  and sub.factor_pago is not null;

-- Lo que el backfill no resolvió (sin parámetro vigente en esa fecha) se deja
-- nulo a propósito: las funciones de lectura caen al factor vigente para esas,
-- que es el comportamiento de antes de esta corrección.
