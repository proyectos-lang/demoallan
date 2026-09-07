-- ===========================================================================
-- Reimprimir la tirilla de una venta ya registrada.
--
-- QUÉ HUECO LLENA
-- ---------------
-- La tirilla sólo se podía imprimir en el momento de la venta, desde el recibo
-- que aparece al confirmar. En cuanto el vendedor pulsa «Nueva venta», ese
-- recibo desaparece y con él la única forma de sacar el papel. Si se atascó el
-- rollo, salió en blanco, o el cliente vuelve al rato pidiendo su comprobante,
-- no había nada que hacer.
--
-- El historial del día ya lista los tickets, pero sólo sus totales: folio,
-- hora, cuántas líneas y cuánto. Para volver a imprimir hace falta lo que no
-- está ahí — LOS NÚMEROS Y SUS MONTOS, uno a uno, y el código de barras.
--
-- REIMPRIMIR NO ES REGISTRAR
-- --------------------------
-- Esto es de sólo lectura, y es la propiedad importante de todo el cambio.
-- Devuelve lo que ya está guardado; no crea ticket, no toca cupo, no mueve un
-- lempira. Se puede llamar mil veces y la venta sigue siendo una.
--
-- Es exactamente el susto que se llevó el usuario cuando un vendedor dijo que
-- reimprimir le había duplicado una venta. Aquel caso resultó ser un doble
-- envío del formulario de registro —arreglado con `envio_id` en la 0056—, no
-- una reimpresión; pero la lección se aplica igual: la vía que reimprime no
-- puede ser la misma que la que registra.
--
-- CADA VENDEDOR VE LO SUYO
-- ------------------------
-- `p_vendedor_id` no es un filtro de comodidad: es la frontera. La aplicación
-- habla con la base como `service_role`, así que las políticas RLS no la
-- estorban y `fn_exige` retorna sin comprobar nada. Si esta función aceptara
-- un folio a secas, un vendedor que cambiara el identificador en la petición
-- se llevaría la tirilla de otro — con los números que juega y cuánto apuesta.
--
-- Por eso el vendedor va en la FIRMA y se compara dentro. Quien llama pone el
-- de la sesión, nunca el que venga del navegador.
--
-- UN TICKET ANULADO TAMBIÉN SE IMPRIME
-- ------------------------------------
-- Se devuelve con su marca de anulado en vez de esconderlo. Quien reclama por
-- una venta anulada necesita el papel precisamente para eso, y ocultarlo sólo
-- obliga a que alguien lo busque en la base. La tirilla lo dirá bien claro.
-- ===========================================================================

create or replace function public.fn_ticket_para_reimprimir(
  p_folio       text,
  p_vendedor_id uuid
)
returns table (
  r_folio        text,
  r_creado_en    timestamptz,
  r_total        numeric,
  r_codigo       text,
  r_anulado      boolean,
  r_fecha        date,
  r_hora         public.hora_sorteo,
  r_vendedor     text,
  r_alias        text,
  r_codigo_v     text,
  -- Las líneas, empaquetadas en un solo campo.
  --
  -- Van como `jsonb` y no como filas sueltas para que la función devuelva UNA
  -- fila por ticket: quien la llama recibe el ticket entero de una vez, sin
  -- tener que reagrupar en el cliente lo que la base ya sabe agrupar.
  r_lineas       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select t.folio,
         t.creado_en,
         t.total,
         t.codigo_barras,
         t.anulado_en is not null,
         s.fecha,
         s.hora,
         v.nombre,
         v.alias,
         v.codigo,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object('numero', l.numero, 'monto', l.monto)
                     -- El mismo orden con el que se imprimió la primera vez:
                     -- una reimpresión que barajara las líneas parecería otra
                     -- venta al ponerla junto al original.
                     order by l.numero, l.monto
                   )
            from public.linea l
            where l.ticket_id = t.id),
           '[]'::jsonb
         )
  from public.ticket   t
  join public.sorteo   s on s.id = t.sorteo_id
  join public.vendedor v on v.id = t.vendedor_id
  where t.folio = p_folio
    -- La frontera. Sin esto, un folio ajeno devolvería la tirilla de otro.
    and t.vendedor_id = p_vendedor_id;
$$;

comment on function public.fn_ticket_para_reimprimir(text, uuid) is
  'Un ticket ya registrado con sus líneas, para volver a imprimir la tirilla. Sólo lectura: no registra nada. Exige el vendedor dueño del ticket.';

revoke execute on function public.fn_ticket_para_reimprimir(text, uuid)
  from public, anon;


-- --------------------------------------------------------------------------
-- La versión de administración: cualquier ticket, sin atarse a un vendedor.
--
-- Se separa en dos funciones en vez de hacer `p_vendedor_id` opcional a
-- propósito. Un parámetro que, dejado en nulo, desactiva la comprobación de
-- pertenencia es un cepo: basta con que alguien olvide pasarlo —o que una
-- variable llegue indefinida— para que la vía del vendedor se convierta
-- silenciosamente en la vía sin restricciones.
--
-- Con dos nombres distintos, quien lee la llamada ve cuál se está usando, y
-- olvidar un argumento produce un error en vez de un agujero.
-- --------------------------------------------------------------------------

create or replace function public.fn_ticket_para_reimprimir_admin(p_folio text)
returns table (
  r_folio        text,
  r_creado_en    timestamptz,
  r_total        numeric,
  r_codigo       text,
  r_anulado      boolean,
  r_fecha        date,
  r_hora         public.hora_sorteo,
  r_vendedor     text,
  r_alias        text,
  r_codigo_v     text,
  r_lineas       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select t.folio, t.creado_en, t.total, t.codigo_barras,
         t.anulado_en is not null,
         s.fecha, s.hora, v.nombre, v.alias, v.codigo,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object('numero', l.numero, 'monto', l.monto)
                     order by l.numero, l.monto
                   )
            from public.linea l
            where l.ticket_id = t.id),
           '[]'::jsonb
         )
  from public.ticket   t
  join public.sorteo   s on s.id = t.sorteo_id
  join public.vendedor v on v.id = t.vendedor_id
  where t.folio = p_folio;
$$;

comment on function public.fn_ticket_para_reimprimir_admin(text) is
  'Como fn_ticket_para_reimprimir pero sin atarse a un vendedor. Sólo para administración: la acción que la llama comprueba el rol.';

revoke execute on function public.fn_ticket_para_reimprimir_admin(text)
  from public, anon;
