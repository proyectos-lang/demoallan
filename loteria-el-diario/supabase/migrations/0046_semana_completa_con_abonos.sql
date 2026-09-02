-- ===========================================================================
-- La semana entera, con lo ya liquidado a la vista.
--
-- `fn_liquidacion_pendiente` hace lo que promete: devuelve lo que falta por
-- cobrar. Servía para cobrar, pero no para MIRAR: en cuanto se liquidaban el
-- lunes y el martes, esos días desaparecían de la pantalla y de la hoja, y con
-- ellos la venta de la semana. El vendedor abría su papel y no encontraba dos
-- días que sí jugó.
--
-- Esta función devuelve la semana completa y marca cada sorteo con el corte en
-- el que se cerró, si se cerró. Quien cobra sigue usando la otra —lo pagado no
-- puede volver a marcarse— y quien mira usa ésta.
--
-- LO QUE SE AÑADE POR SORTEO
-- --------------------------
--   r_premiado   lo APOSTADO al número que salió
--   r_factor     el multiplicador efectivo de ese sorteo
--   r_corte_id   en qué corte se cerró; nulo si sigue pendiente
--   r_pagado_en  cuándo se cerró
--
-- EL FACTOR NO ES UNO SOLO. Se congela en cada línea al vender, así que dentro
-- de una misma semana conviven 68, 70, 72… Ponerlo en la cabecera del papel
-- —«factor de premio: 70»— era una simplificación que no aguanta: aquí se
-- devuelve el efectivo de cada sorteo, `premio / apostado`, que es el que
-- permite rehacer la cuenta.
--
-- Y `r_premiado` no se calcula dividiendo: se suma directamente el monto de las
-- líneas ganadoras. Dividir premio entre factor da lo mismo —comprobado sobre
-- doscientas líneas— pero sólo mientras el factor sea uniforme dentro del
-- sorteo; sumar el monto es cierto siempre.
-- ===========================================================================

create or replace function allan.fn_semana_completa(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_liquidacion_id uuid,
  r_fecha          date,
  r_hora           allan.hora_sorteo,
  r_numero_ganador smallint,
  r_venta          numeric,
  r_premiado       numeric,   -- lo apostado al número que salió
  r_factor         numeric,   -- multiplicador efectivo del sorteo
  r_comision       numeric,
  r_premios        numeric,   -- lo que costó pagarlo
  r_saldo          numeric,   -- venta − comisión − premios
  r_corte_id       uuid,      -- nulo si sigue pendiente
  r_pagado_en      timestamptz
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with acertado as (
    select t.sorteo_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana
      and s.fecha between p_desde and p_hasta
    group by t.sorteo_id
  )
  select lq.id,
         s.fecha,
         s.hora,
         s.numero_ganador,
         lq.venta,
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada. Misma regla que la 0036.
         case when coalesce(a.premiado, 0) > 0
              then round(lq.premios / a.premiado, 2) else 0 end,
         lq.comision,
         lq.premios,
         lq.venta - lq.comision - lq.premios,
         d.corte_id,
         cv.pagado_en
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  left join acertado a on a.sorteo_id = s.id
  left join allan.corte_detalle d on d.liquidacion_id = lq.id
  left join allan.corte_vendedor cv on cv.id = d.corte_id
  where lq.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
  order by s.fecha, s.hora;
$$;

comment on function allan.fn_semana_completa(uuid, date, date) is
  'La semana entera de un vendedor, sorteo a sorteo, marcando cuáles ya se liquidaron y en qué corte.';

revoke execute on function allan.fn_semana_completa(uuid, date, date) from public, anon;


-- --------------------------------------------------------------------------
-- Los abonos de una semana.
--
-- Cada corte que tocó algún sorteo de esa semana, con lo que se cerró EN ESA
-- SEMANA y no el total del corte: un corte puede abarcar varias semanas, y en
-- el papel de una semana sólo debe figurar la parte que le toca. Si no, la
-- suma de los abonos no cuadraría con el total de la hoja.
-- --------------------------------------------------------------------------
create or replace function allan.fn_abonos_semana(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_corte_id  uuid,
  r_pagado_en timestamptz,
  r_sorteos   integer,
  r_saldo     numeric,   -- la parte de ese corte que cae en esta semana
  r_nota      text
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select cv.id,
         cv.pagado_en,
         count(*)::integer,
         sum(lq.venta - lq.comision - lq.premios),
         cv.nota
  from allan.corte_vendedor cv
  join allan.corte_detalle d on d.corte_id = cv.id
  join allan.liquidacion lq on lq.id = d.liquidacion_id
  join allan.sorteo s on s.id = lq.sorteo_id
  where cv.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
  group by cv.id, cv.pagado_en, cv.nota
  order by cv.pagado_en;
$$;

comment on function allan.fn_abonos_semana(uuid, date, date) is
  'Los cortes que tocaron una semana, con la parte del saldo que corresponde a esa semana.';

revoke execute on function allan.fn_abonos_semana(uuid, date, date) from public, anon;
