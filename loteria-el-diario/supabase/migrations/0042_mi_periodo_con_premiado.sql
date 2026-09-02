-- ===========================================================================
-- El reporte del vendedor gana la columna «premiado».
--
-- El vendedor va a ver su propio resultado con las mismas columnas que mira la
-- gerencia, y ahí hay una que este sistema no le estaba devolviendo: lo
-- APOSTADO al número que salió. No es lo mismo que lo pagado —eso es
-- `premios`, que ya venía—: apostado por factor es pagado, y son las dos
-- columnas que permiten reconstruir la cuenta a mano.
--
-- Con las dos, el factor efectivo del sorteo sale de dividir una por la otra,
-- así que no hace falta devolverlo: sería un tercer número que puede dejar de
-- cuadrar con los otros dos.
--
-- Cambia el tipo de retorno, así que hay que soltar la función antes de
-- recrearla. Mismo procedimiento que la 0037 y la 0039.
-- ===========================================================================

drop function if exists allan.fn_mi_periodo(uuid, date, date);

create function allan.fn_mi_periodo(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_fecha    date,
  r_hora     allan.hora_sorteo,
  r_estado   allan.estado_sorteo,
  r_ganador  smallint,
  r_tickets  integer,
  r_venta    numeric,
  r_premiado numeric,   -- lo APOSTADO al número que salió
  r_comision numeric,
  r_premios  numeric,   -- lo que costó pagarlo
  r_pagado   boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.fecha,
         s.hora,
         s.estado,
         s.numero_ganador,
         count(distinct t.id)::integer,
         coalesce(sum(l.monto), 0),
         -- `filter` y no un segundo join: las líneas ya están aquí, y volver a
         -- traerlas para contar las ganadoras sería recorrer dos veces lo
         -- mismo. `l.gana` se marca al liquidar, así que un sorteo sin número
         -- ganador da cero, que es lo correcto: todavía no ganó nadie.
         coalesce(sum(l.monto) filter (where l.gana), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0),
         exists (
           select 1
           from allan.liquidacion lq
           join allan.corte_detalle d on d.liquidacion_id = lq.id
           where lq.sorteo_id = s.id and lq.vendedor_id = p_vendedor_id
         )
  -- LEFT JOIN y no INNER: un sorteo en el que este vendedor no vendió nada
  -- tiene que salir igual, en cero. Si desapareciera, la rejilla del día
  -- perdería una fila y parecería que ese sorteo no existió.
  from allan.sorteo s
  left join allan.ticket t
    on t.sorteo_id = s.id
   and t.vendedor_id = p_vendedor_id
   and t.anulado_en is null
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha between p_desde and p_hasta
  group by s.id, s.fecha, s.hora, s.estado, s.numero_ganador
  order by s.fecha, s.hora;
$$;

comment on function allan.fn_mi_periodo(uuid, date, date) is
  'El período de UN vendedor, día por día y sorteo por sorteo, con lo apostado y lo pagado al número ganador.';

revoke execute on function allan.fn_mi_periodo(uuid, date, date) from public, anon;
