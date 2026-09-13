-- ===========================================================================
-- La restricción que todavía imponía el techo compartido.
--
-- LO QUE FALTABA
-- --------------
-- La 0077 quitó el rechazo por `limite_casa` de las funciones, pero el techo
-- vivía en DOS sitios. El otro es esta restricción de la tabla, puesta en la
-- 0001:
--
--     constraint cupo_no_excedido check (vendido <= limite_casa)
--
-- Con la función ya sin el rechazo, el segundo vendedor que intentaba vender
-- su tope completo se topaba contra la tabla:
--
--     new row for relation "cupo_numero" violates check constraint
--     "cupo_no_excedido"
--
-- Es decir: el problema que reportaron —no poder vender un número que uno no
-- ha vendido— seguía ocurriendo, sólo que con un mensaje peor, porque el de
-- la base no está escrito para que lo lea un vendedor.
--
-- POR QUÉ SE VA
-- -------------
-- Su comentario original la describe como «última línea de defensa contra la
-- sobreventa: aunque la lógica de la función fallara, la base rechaza el
-- INSERT». Era coherente mientras existiera un límite de casa que respetar.
-- Ya no lo hay: el tope es de cada vendedor y `limite_casa` pasó a ser una
-- REFERENCIA de exposición, no un máximo.
--
-- Una restricción que protege una regla derogada no protege nada; sólo
-- impide lo que ahora es correcto.
--
-- LO QUE SIGUE PROTEGIDO
-- ----------------------
-- `cupo_no_negativo` se queda: `vendido` nunca puede bajar de cero, y eso sí
-- delataría un error de contabilidad —una devolución de cupo mayor que lo
-- consumido— que ninguna regla de negocio justifica.
--
-- Y el tope de cada vendedor lo siguen comprobando `fn_registrar_ticket` y
-- `fn_editar_venta`, con la fila de cupo bloqueada (`for update`), que es
-- donde esa comprobación tiene que estar para ser correcta bajo concurrencia.
-- ===========================================================================

alter table public.cupo_numero
  drop constraint if exists cupo_no_excedido;

comment on column public.cupo_numero.limite_casa is
  'Referencia de exposición de la casa en ese número. Desde la 0077 NO es un máximo: no impide vender. El único tope que rechaza es el de cada vendedor.';

comment on column public.cupo_numero.vendido is
  'Lo vendido entre todos los vendedores en ese número. Alimenta el semáforo del punto de venta y la lectura de exposición. Puede superar limite_casa.';
