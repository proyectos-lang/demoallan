-- ===========================================================================
-- El tablero de control no veía la venta capturada por totales.
--
-- SÍNTOMA. Se registra una captura por totales de 777 para un vendedor en el
-- sorteo de la noche y el tablero sigue mostrando 200 —sólo su ticket—. La
-- captura no aparece por ningún lado: ni en VENTA, ni en la fila del vendedor,
-- ni en la barra del día.
--
-- CAUSA, Y POR QUÉ NO SE VIO ANTES. `fn_control_vendedores` lee los importes de
-- `liquidacion`, que SÍ incluye las capturas desde la 0048. Por eso un día ya
-- liquidado cuadra perfecto: V-011 el 07/09 muestra 9.915, que son 9.905 de
-- capturas más 10 de un ticket.
--
-- El agujero está en el otro brazo de la misma función: `sin_liquidar`, que
-- cubre los sorteos del rango que todavía no tienen fila en `liquidacion`.
-- Ese brazo baja a `ticket`/`linea`, y una captura por totales no es un
-- ticket: no tiene líneas ni números. Así que la venta del día en curso —que
-- es justo la que se mira en un tablero de control— salía incompleta hasta que
-- el sorteo se liquidaba, y entonces aparecía de golpe.
--
-- Es el mismo descuadre que la 0070 corrigió en el informe de gerencia y la
-- 0080 en el panel del vendedor. Faltaba este tercer sitio.
--
-- QUÉ CUENTA COMO QUÉ
-- -------------------
-- Una captura sobre un sorteo sin liquidar entra en `pendiente`, exactamente
-- igual que la venta en tickets de ese mismo sorteo: el vendedor ya la hizo,
-- pero mientras no haya número ganador no genera utilidad. Lo contrario
-- —sumarla a comisión y premios— convertiría el tablero en una proyección, y
-- la nota al pie que ya dice «no entra en premios ni en utilidad» dejaría de
-- ser cierta.
--
-- Los CONTEOS de tickets y líneas NO cambian. Una captura por totales no tiene
-- ni lo uno ni lo otro, y rellenarlos con un 1 inventado haría creer que hay un
-- ticket que nadie podría abrir. Un vendedor que sólo vendió por totales sale
-- con venta y con cero tickets, que es exactamente lo que pasó.
-- ===========================================================================

create or replace function public.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       public.hora_sorteo default null
)
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_zona        text,
  r_color       text,
  r_tickets     integer,
  r_lineas      integer,
  r_venta       numeric,
  r_comision    numeric,
  r_premios     numeric,
  r_utilidad    numeric,
  r_pendiente   numeric
)
language sql
stable
security definer
set search_path = public
as $control_vendedores$
  with
  -- Los sorteos del rango, una sola vez: los demás bloques se enganchan aquí.
  sorteos as (
    select s.id, s.estado
    from public.sorteo s
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
  ),
  -- Los importes de lo YA liquidado, del agregado y no de las líneas. Las
  -- capturas por totales ya están dentro: `fn_liquidar_sorteo` las suma desde
  -- la 0048.
  liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)     as venta,
           sum(lq.comision)  as comision,
           sum(lq.premios)   as premios,
           -- Restado de lo que se enseña, no leído de `utilidad`: las cuatro
           -- columnas se redondean por separado al liquidar. Ver la 0036.
           sum(lq.venta) - sum(lq.comision) - sum(lq.premios) as utilidad
    from public.liquidacion lq
    join sorteos s on s.id = lq.sorteo_id
    where p_vendedores is null or lq.vendedor_id = any (p_vendedores)
    group by lq.vendedor_id
  ),
  -- La venta de los sorteos del rango que todavía no se liquidaron. Ésos no
  -- tienen fila en `liquidacion`, así que aquí no hay atajo; pero son pocos.
  sin_liquidar_tickets as (
    select t.vendedor_id, sum(l.monto) as pendiente
    from sorteos s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where s.estado <> 'liquidado'
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by t.vendedor_id
  ),
  -- Y lo mismo capturado por totales, que es lo que faltaba. Se lee de su
  -- propia tabla porque no deja rastro en `ticket`.
  sin_liquidar_totales as (
    select vt.vendedor_id, sum(vt.venta) as pendiente
    from sorteos s
    join public.venta_total vt on vt.sorteo_id = s.id and vt.anulado_en is null
    where s.estado <> 'liquidado'
      and (p_vendedores is null or vt.vendedor_id = any (p_vendedores))
    group by vt.vendedor_id
  ),
  -- Conteos. Contar no obliga a sumar importes ni a ordenar nada. Sólo
  -- tickets: una captura por totales no tiene ni ticket ni líneas.
  conteos as (
    select t.vendedor_id,
           count(distinct t.id) as tickets,
           count(l.id)          as lineas
    from sorteos s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where p_vendedores is null or t.vendedor_id = any (p_vendedores)
    group by t.vendedor_id
  )
  select v.id, v.codigo, public.fn_rotulo(v.alias, v.nombre), v.zona, v.color,
         coalesce(c.tickets, 0)::integer,
         coalesce(c.lineas, 0)::integer,
         -- La venta del período es la liquidada MÁS la que espera resultado:
         -- el vendedor ya la hizo, aunque todavía no genere utilidad.
         coalesce(q.venta, 0) + coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0),
         coalesce(q.comision, 0),
         coalesce(q.premios, 0),
         coalesce(q.utilidad, 0),
         coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0)
  from public.vendedor v
  -- Externos: un vendedor sin ventas en el rango debe aparecer con ceros, no
  -- desaparecer de la comparación. Es justo lo que hay que ver de él.
  left join liquidado            q on q.vendedor_id = v.id
  left join sin_liquidar_tickets p on p.vendedor_id = v.id
  left join sin_liquidar_totales x on x.vendedor_id = v.id
  left join conteos              c on c.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(q.venta, 0) + coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0) desc,
           v.codigo;
$control_vendedores$;

comment on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo) is
  'Tablero de control por vendedor. Importes liquidados desde `liquidacion`; lo pendiente, de tickets Y de capturas por totales.';

revoke execute on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo)
  from public, anon;
