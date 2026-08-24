-- ===========================================================================
-- El vendedor puede ver su propio período, no sólo el día de hoy.
--
-- `fn_mi_dia` contesta «¿cómo voy hoy?» y para eso está bien. Pero la pregunta
-- que trae un vendedor a la oficina es otra: «¿cuánto me deben de la semana?»,
-- y para responderla había que abrir el portal siete veces, una por día, o
-- pedirle el dato a administración.
--
-- QUÉ ES «EL TOTAL» AQUÍ
-- ----------------------
-- Comisión más premios: lo que la casa le devuelve. El vendedor cobra la venta
-- en la calle y paga los premios de su bolsillo, así que esas dos cifras son
-- las suyas; la venta bruta es el movimiento, no su dinero.
--
-- Ojo con la simetría: el módulo de liquidación del administrador enseña el
-- SALDO (venta − comisión − premios), que es lo que el vendedor entrega. Son
-- las dos caras de la misma cuenta y ninguna contradice a la otra, pero no son
-- el mismo número y las pantallas lo rotulan de forma distinta a propósito.
--
-- POR QUÉ TRAE `r_pagado`
-- -----------------------
-- Para que el vendedor no tenga que preguntar si ya le cubrieron el lunes. El
-- dato ya existe —lo escribe `fn_registrar_corte`— y sin él la pantalla
-- muestra una deuda que puede llevar días saldada.
--
-- El filtro por vendedor va en el PARÁMETRO, no en la sesión: esta función es
-- `security definer` y la aplicación la llama con el id que saca de la cookie
-- firmada, nunca con uno que venga de la petición.
-- ===========================================================================

create or replace function allan.fn_mi_periodo(
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
  r_comision numeric,
  r_premios  numeric,
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
  'Rejilla día × sorteo de UN vendedor en un rango, con la marca de si ya se le pagó.';

revoke execute on function allan.fn_mi_periodo(uuid, date, date)
  from public, anon, authenticated;
