-- ===========================================================================
-- El informe de gerencia enseña la venta aunque el sorteo no esté liquidado.
--
-- EL PROBLEMA
-- -----------
-- La captura diaria mostraba TODO en cero hasta que el sorteo se liquidaba, y
-- eso es desconcertante cuando la venta existe y está registrada: el gerente
-- ve un día con movimiento real y la pantalla le dice L 0. La reacción natural
-- es pensar que se perdieron los datos.
--
-- LO QUE SE PUEDE Y LO QUE NO
-- ---------------------------
-- La VENTA de un sorteo sin liquidar se conoce perfectamente: está en las
-- líneas, que es donde vive desde que se registró. La COMISIÓN también, porque
-- va congelada en cada línea al venderse.
--
-- Los PREMIOS no. Sin número ganador no se sabe qué se pagó, y por tanto el
-- NETO tampoco existe. Aquí no se inventan: se devuelven en NULL, no en cero.
-- La diferencia importa — un cero se lee como «no se pagó nada», que es una
-- afirmación falsa; un NULL se pinta como «—» y dice la verdad, que es «aún no
-- se sabe». La pantalla ya sabe distinguirlos.
--
-- Poner premios en cero y calcular un neto con ellos sería peor que no mostrar
-- nada: ese neto parecería ganancia. El caso del 3 de septiembre lo ilustra —
-- venta 3.440 con premios en cero daría un «neto» de +3.440, cuando el real,
-- una vez liquidado, fue de −1.460.
--
-- CÓMO SE SEPARA
-- --------------
-- Dos columnas nuevas: `r_venta_pendiente` y `r_tiene_pendiente`. La venta
-- total sigue siendo `r_venta`, ahora sumando lo liquidado y lo que no; quien
-- necesite saber cuánto de eso es firme mira la columna nueva.
--
-- Cambia el tipo de retorno, así que hay que soltar la función antes de
-- recrearla. Mismo procedimiento que la 0037 y la 0039.
-- ===========================================================================

drop function if exists public.fn_informe_gerencia(date, date, public.hora_sorteo);

create function public.fn_informe_gerencia(
  p_desde date,
  p_hasta date,
  p_hora  public.hora_sorteo default null
) returns table (
  r_vendedor_id     uuid,
  r_codigo          text,
  r_nombre          text,
  r_venta           numeric,   -- liquidada + pendiente
  r_venta_pendiente numeric,   -- la parte de sorteos sin liquidar
  r_premiado        numeric,
  r_factor          numeric,
  r_pago            numeric,   -- NULL si no hay nada liquidado
  r_porcentaje      numeric,
  r_comision        numeric,
  r_bruto           numeric,
  r_neto            numeric,   -- NULL si no hay nada liquidado
  r_tiene_pendiente boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
    group by lq.vendedor_id
  ),
  -- La venta de los sorteos que TODAVÍA no se liquidaron. Sale de las líneas
  -- porque esos sorteos no tienen fila en `liquidacion` —no la pueden tener,
  -- su premio aún no existe—. Son los del día, unos miles de filas.
  pendiente as (
    select t.vendedor_id,
           sum(l.monto)                        as venta,
           sum(l.monto * l.comision_congelada) as comision
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and s.estado <> 'liquidado'
      and t.anulado_en is null
    group by t.vendedor_id
  ),
  -- Lo apostado al número que salió. Sólo existe en sorteos ya liquidados: es
  -- `l.gana`, que se marca al liquidar.
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: un vendedor que no vendió
  -- nada es justo lo que el gerente quiere ver, y con un `join` desde
  -- liquidacion desaparecía sin dejar rastro.
  select v.id,
         v.codigo,
         v.nombre,
         coalesce(q.venta, 0) + coalesce(p.venta, 0),
         coalesce(p.venta, 0),
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada.
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         -- NULL, no cero: de un sorteo sin liquidar no se sabe qué se pagó, y
         -- decir «0» sería afirmar que no se pagó nada.
         case when q.vendedor_id is not null then coalesce(q.premios, 0) end,
         case when coalesce(q.venta, 0) + coalesce(p.venta, 0) > 0
              then round((coalesce(q.comision, 0) + coalesce(p.comision, 0))
                         / (coalesce(q.venta, 0) + coalesce(p.venta, 0)), 4)
              else 0 end,
         -- La comisión SÍ se conoce siempre: va congelada en cada línea desde
         -- que se vendió.
         coalesce(q.comision, 0) + coalesce(p.comision, 0),
         coalesce(q.venta, 0) + coalesce(p.venta, 0)
           - coalesce(q.comision, 0) - coalesce(p.comision, 0),
         -- El neto sólo existe donde hay premio calculado. Se resta de lo que
         -- se enseña, no se lee de `utilidad`: las cuatro columnas se redondean
         -- por separado al liquidar. Ver la cabecera de la 0036.
         case when q.vendedor_id is not null
              then coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
         end,
         p.vendedor_id is not null
  from public.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join pendiente p on p.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  where v.activo or q.venta is not null or p.venta is not null
  order by coalesce(q.venta, 0) + coalesce(p.venta, 0) desc, v.codigo;
$$;

comment on function public.fn_informe_gerencia(date, date, public.hora_sorteo) is
  'Informe de gerencia por vendedor. La venta incluye lo no liquidado; premios y neto van en NULL mientras el sorteo no tenga número ganador.';

revoke execute on function public.fn_informe_gerencia(date, date, public.hora_sorteo)
  from public, anon;
