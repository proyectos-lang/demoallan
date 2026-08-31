-- ===========================================================================
-- El informe de gerencia, sorteo a sorteo.
--
-- El gerente mira el rango completo y enseguida quiere bajar: «¿y el martes?»,
-- «¿y sólo la de las once?». El día ya se podía estrechar por fuera —un día es
-- un rango de un día— pero la lotería no: hacía falta un filtro más.
--
-- Se cambia la firma, así que hay que soltar la función y volver a crearla.
-- Dejar las dos vivas haría ambigua cualquier llamada de dos argumentos.
--
-- `p_hora` en nulo significa las tres, que es el comportamiento de antes: la
-- llamada de dos argumentos sigue devolviendo exactamente lo mismo.
-- ===========================================================================

drop function if exists allan.fn_informe_gerencia(date, date);

create or replace function allan.fn_informe_gerencia(
  p_desde date,
  p_hasta date,
  p_hora  allan.hora_sorteo default null
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
      and (p_hora is null or s.hora = p_hora)
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
      and (p_hora is null or s.hora = p_hora)
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: la hoja lista a todo el
  -- mundo, y un vendedor que no vendió nada es justo lo que el gerente quiere
  -- ver. Con un `join` desde liquidacion desaparecía sin dejar rastro, que es
  -- la peor forma de no aparecer.
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
         -- El neto sale de restar lo que se enseña, no de sumar `utilidad`:
         -- las cuatro columnas se redondean por separado al liquidar y se
         -- separan hasta un céntimo. Ver la cabecera de la 0036.
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado a on a.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera que haya vendido en el rango aunque
  -- después se le diera de baja: si movió dinero, tiene que salir.
  where v.activo or q.venta is not null
  -- De mayor a menor venta: el gerente mira primero quién mueve más, y los que
  -- no movieron nada caen solos al final.
  order by coalesce(q.venta, 0) desc, v.codigo;
$$;

comment on function allan.fn_informe_gerencia(date, date, allan.hora_sorteo) is
  'El informe de gerencia, una fila por vendedor. Con p_hora en nulo suma las tres loterías; con una hora, sólo ésa.';

revoke execute on function allan.fn_informe_gerencia(date, date, allan.hora_sorteo)
  from public, anon;
