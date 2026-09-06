-- ===========================================================================
-- Buscar por el código de barras COMPLETO lanzaba en vez de encontrar.
--
-- SÍNTOMA
-- -------
--   El código base debe tener exactamente 12 dígitos; llegó 2609061000011.
--
-- Leer un ticket con la pistola —que devuelve los trece dígitos— fallaba. Sólo
-- funcionaba pasando los doce sin el control, que es justo lo que un lector no
-- hace.
--
-- CAUSA
-- -----
-- La 0061 ya intentaba protegerlo:
--
--     where t.codigo_barras = p_codigo
--        or (p_codigo ~ '^[0-9]{12}$'
--            and t.codigo_barras = p_codigo || fn_ean13_control(p_codigo))
--
-- La idea era que el `and` cortara antes de llamar a la función. No lo hace:
-- PostgreSQL NO GARANTIZA EL ORDEN DE EVALUACIÓN dentro de una expresión
-- booleana. Es libre de evaluar `fn_ean13_control` primero, y esa función
-- lanza con cualquier longitud distinta de doce. La excepción tumba la
-- consulta entera antes de comparar nada.
--
-- Es un error fácil de cometer viniendo de otros lenguajes, donde `&&` sí
-- corta de izquierda a derecha. En SQL el planificador reordena lo que quiera.
--
-- ARREGLO
-- -------
-- `case`, que es la única construcción del estándar donde el orden SÍ está
-- garantizado: las ramas se evalúan en secuencia y sólo la que aplica. Con
-- trece dígitos ni se llama a la función.
--
-- Se aprovecha además para admitir el código con espacios: algunos lectores
-- los añaden al final, y `btrim` evita que un ticket «no aparezca» por un
-- carácter invisible.
-- ===========================================================================

create or replace function public.fn_ticket_por_codigo(p_codigo text)
returns table (
  r_ticket_id uuid,
  r_folio     text,
  r_fecha     date,
  r_hora      public.hora_sorteo,
  r_estado    public.estado_sorteo,
  r_vendedor  text,
  r_codigo_v  text,
  r_creado_en timestamptz,
  r_total     numeric,
  r_premio    numeric,
  r_anulado   boolean,
  r_jugada    text
)
language sql
stable
security definer
set search_path = public
as $$
  with buscado as (
    /*
     * El código que se va a comparar, resuelto UNA VEZ y fuera del `where`.
     *
     * `case` y no `and`: PostgreSQL no garantiza el orden de evaluación de una
     * expresión booleana, así que `x ~ '^[0-9]{12}$' and f(x)` puede llamar a
     * `f` igualmente. `fn_ean13_control` lanza si no recibe doce dígitos, y esa
     * excepción tumbaba la consulta entera al leer un código completo.
     *
     * `btrim` porque algunos lectores añaden un espacio al final, y un ticket
     * que «no aparece» por un carácter invisible es de lo más difícil de
     * diagnosticar desde el mostrador.
     */
    select case
             when btrim(p_codigo) ~ '^[0-9]{13}$' then btrim(p_codigo)
             when btrim(p_codigo) ~ '^[0-9]{12}$'
               then btrim(p_codigo) || public.fn_ean13_control(btrim(p_codigo))::text
             else null
           end as codigo
  )
  select t.id, t.folio, s.fecha, s.hora, s.estado, v.nombre, v.codigo,
         t.creado_en, sum(l.monto), sum(l.premio), t.anulado_en is not null,
         string_agg(
           lpad(l.numero::text, 2, '0') || ':' ||
           case when l.monto = trunc(l.monto)
                then trunc(l.monto)::bigint::text
                else to_char(l.monto, 'FM999999990.00')
           end,
           '  ' order by l.numero, l.monto)
  from buscado b
  join public.ticket   t on t.codigo_barras = b.codigo
  join public.sorteo   s on s.id = t.sorteo_id
  join public.vendedor v on v.id = t.vendedor_id
  join public.linea    l on l.ticket_id = t.id
  group by t.id, t.folio, s.fecha, s.hora, s.estado, v.nombre, v.codigo,
           t.creado_en, t.anulado_en;
$$;

comment on function public.fn_ticket_por_codigo(text) is
  'La venta de un código de barras. Acepta el EAN-13 completo, sus doce dígitos sin control, y con espacios alrededor.';

revoke execute on function public.fn_ticket_por_codigo(text) from public, anon;
