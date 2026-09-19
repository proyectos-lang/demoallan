-- ===========================================================================
-- El «vendido por número» del punto de venta se truncaba a 1000 filas.
--
-- LO QUE REPORTARON
-- -----------------
-- Vendedores y administración: al registrar una venta, el cupo del número no
-- bajaba en la pantalla —pero sólo en ALGUNOS números—. La venta sí entraba y
-- el cupo real (`cupo_numero.vendido`) se descontaba bien; lo que no bajaba era
-- el disponible que muestra el teclado.
--
-- LA CAUSA
-- --------
-- El teclado calcula el disponible de cada número con `fn_vendido_por_vendedor`,
-- que agrupa lo vendido por (vendedor, número). Con treinta y pico vendedores
-- por cien números, eso son hasta ~3000 filas. Y PostgREST corta las respuestas
-- a 1000 filas por defecto: la pantalla recibía el «vendido propio» TRUNCADO.
-- A los números cuyas filas quedaban después de la fila 1000 no les llegaba su
-- tally, así que su disponible no bajaba aunque la venta hubiera entrado. Por
-- eso el fallo aparecía sólo en «algunos» números, y cambiaba de un sorteo a
-- otro según cuántas filas hubiera.
--
-- Se comprobó sobre datos reales: en un sorteo, la suma de `cupo_numero.vendido`
-- y la suma directa de las 2.592 líneas vivas coincidían al céntimo (108.734),
-- mientras la RPC devolvía exactamente 1000 filas y sumaba de menos (79.146).
-- El cupo nunca estuvo mal; lo que estaba corta era la lectura.
--
-- LA CORRECCIÓN
-- -------------
-- Se añade `p_vendedor_id` opcional. La pantalla del vendedor —que sólo necesita
-- lo suyo— pasa su id y recibe a lo sumo ~100 filas, muy por debajo del tope.
-- El punto de venta del administrador, que sí necesita a todo el padrón, lo pide
-- sin filtro y lo lee PAGINANDO con `.range()`, que sortea el tope de 1000.
--
-- La firma cambia, así que se suelta la anterior primero: `create or replace` no
-- reemplaza una función cuando cambia su lista de parámetros —crearía una
-- segunda y las llamadas quedarían ambiguas—.
-- ===========================================================================

drop function if exists public.fn_vendido_por_vendedor(uuid);

create function public.fn_vendido_por_vendedor(
  p_sorteo_id   uuid,
  p_vendedor_id uuid default null
)
returns table (
  r_vendedor_id uuid,
  r_numero      smallint,
  r_vendido     numeric
)
language sql
stable
security definer
set search_path = public
as $vendido$
  select t.vendedor_id, l.numero, sum(l.monto)
  from public.linea l
  join public.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
  group by t.vendedor_id, l.numero;
$vendido$;

comment on function public.fn_vendido_por_vendedor(uuid, uuid) is
  'Lo vendido por cada vendedor en cada número de un sorteo. Con p_vendedor_id devuelve sólo lo de ese vendedor —lo que pide el teclado, y así no se acerca al tope de filas de la API—. Sin él, todo el padrón: quien lo llame así debe paginar. No es autoritativo: la venta la valida fn_registrar_ticket con la fila bloqueada.';

revoke execute on function public.fn_vendido_por_vendedor(uuid, uuid) from public, anon;
