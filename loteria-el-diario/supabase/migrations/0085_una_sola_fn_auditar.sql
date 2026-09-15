-- ===========================================================================
-- Queda UNA sola `fn_auditar`. La 0083 dejó dos y ninguna venta entraba.
--
-- QUÉ PASÓ
-- --------
-- La 0083 añadió a `fn_auditar` un séptimo parámetro para el usuario, con
-- `create or replace`. Pero `create or replace` no reemplaza una función
-- cuando cambia su lista de parámetros: crea otra. Quedaron las dos —la de
-- seis argumentos y la de siete— y cada llamada con seis se volvió ambigua:
--
--     function public.fn_auditar(unknown, uuid, unknown, unknown, text, text)
--     is not unique
--
-- Como casi todo audita, el sistema dejó de registrar ventas. Es el mismo
-- error que ya pasó con `fn_anular_ticket` en la 0067, y la lección es la
-- misma: al añadir un parámetro hay que SOLTAR la firma vieja.
--
-- POR QUÉ NO BASTA CON DEJAR LAS DOS
-- ----------------------------------
-- Postgres elige por firma, y una llamada de seis argumentos encaja tanto en
-- la de seis como en la de siete —el séptimo tiene valor por omisión—. No hay
-- forma de desempatar, así que rechaza. No es que prefiera la equivocada: es
-- que no elige.
--
-- LO QUE SE CONSERVA
-- ------------------
-- La de SIETE, que es la que guarda quién hizo cada cosa. Las treinta llamadas
-- antiguas que pasan seis argumentos siguen funcionando contra ella: el
-- séptimo es opcional y queda nulo, exactamente como estaban antes.
-- ===========================================================================

drop function if exists public.fn_auditar(text, uuid, text, text, text, text);

-- Y se deja constancia de que la que manda es la de siete, por si alguien
-- llega aquí buscando por qué hay un `drop` suelto.
comment on function public.fn_auditar(text, uuid, text, text, text, text, uuid) is
  'Deja constancia de un cambio. El usuario se recibe por parámetro (0083): auth.uid() es nulo desde que la aplicación habla como service_role. La firma de seis argumentos se retiró en la 0085 — convivían las dos y toda llamada se volvía ambigua.';
