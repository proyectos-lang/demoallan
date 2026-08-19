-- ===========================================================================
-- Lo que de verdad hacía lentas las pantallas: RLS evaluado fila por fila.
--
-- Medido con `service_role` —que se salta RLS— el simulador tardaba 5,1 s. La
-- misma pantalla, con una sesión de administrador, tardaba 17. La diferencia no
-- estaba en la consulta: estaba en la política.
--
--     create policy linea_por_ticket on allan.linea
--       using (
--         exists (
--           select 1 from allan.ticket t
--           where t.id = linea.ticket_id
--             and ( t.vendedor_id = allan.fn_vendedor_actual()
--                   or allan.fn_rol_actual() in (...) )))
--
-- Ese EXISTS se ejecuta UNA VEZ POR FILA. Sobre 746 mil líneas son 746 mil
-- subconsultas más un millón y medio de llamadas a función — para un
-- administrador, que puede verlo todo y para quien la respuesta es siempre sí.
--
-- Dos cambios, ambos conocidos y ninguno relaja la seguridad:
--
--   1. La comprobación de ROL va primero. Es una comparación contra un valor
--      único; el EXISTS sólo hace falta para un vendedor, que además ve pocas
--      filas.
--   2. Las llamadas a función se envuelven en `(select …)`. Así PostgreSQL las
--      evalúa una sola vez como InitPlan en lugar de por fila. El resultado es
--      idéntico —el rol no cambia a mitad de consulta— y el costo pasa de
--      lineal a constante.
--
-- Quién ve qué no cambia en absoluto: las mismas dos condiciones, unidas por el
-- mismo OR.
-- ===========================================================================

drop policy if exists ticket_propio on allan.ticket;

create policy ticket_propio on allan.ticket
  for select to authenticated
  using (
    (select allan.fn_rol_actual()) in ('administrador', 'auditor', 'digitador')
    or vendedor_id = (select allan.fn_vendedor_actual())
  );

drop policy if exists linea_por_ticket on allan.linea;

create policy linea_por_ticket on allan.linea
  for select to authenticated
  using (
    (select allan.fn_rol_actual()) in ('administrador', 'auditor', 'digitador')
    or exists (
      select 1 from allan.ticket t
      where t.id = linea.ticket_id
        and t.vendedor_id = (select allan.fn_vendedor_actual())
    )
  );

-- ===========================================================================
-- Agregados de rango largo, sin `count(distinct)`.
--
-- `v_agregado_sorteo_vendedor` calcula `count(distinct t.id)` siempre, aunque
-- quien la consulta no lo necesite. Sobre ocho meses eso es una agregación
-- distinta sobre 746 mil filas, y era lo que dejaba a `fn_resumen_mensual` en
-- 8,2 s.
--
-- Las tres funciones de rango largo pasan a leer las tablas base y a contar los
-- tickets donde contar es barato: en la tabla `ticket`, donde cada fila ya es
-- un ticket. La vista se queda como está — para un día es rápida y es la
-- definición canónica de los agregados (§2).
-- ===========================================================================

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with dinero as (
    select
      coalesce(sum(l.monto), 0)                                                    as venta,
      coalesce(sum(l.monto * l.comision_congelada), 0)                             as comision,
      coalesce(sum(l.monto) filter (where s.estado = 'liquidado'), 0)              as venta_liq,
      coalesce(sum(l.monto * l.comision_congelada)
               filter (where s.estado = 'liquidado'), 0)                           as comision_liq,
      coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0)             as premios,
      coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)             as venta_pend
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
  ),
  conteos as (
    select
      (select count(*)
       from allan.ticket t
       join allan.sorteo s on s.id = t.sorteo_id
       where s.fecha between p_desde and p_hasta
         and t.anulado_en is null)::integer as tickets,
      -- Sorteos CON ventas, que es lo que la vista contaba.
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado = 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as liquidados,
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado <> 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as pendientes
  )
  select d.venta, d.comision, c.tickets,
         d.venta_liq, d.comision_liq, d.premios,
         d.venta_liq - d.comision_liq - d.premios,
         d.venta_pend, c.liquidados, c.pendientes
  from dinero d, conteos c;
$$;

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from s.fecha)::integer,
         extract(month from s.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto - l.monto * l.comision_congelada - l.premio)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and t.anulado_en is null
  group by 1, 2
  order by 1, 2;
$$;

-- `fn_resumen_vendedor` se deja como está: ya filtra la fecha dentro del ON, no
-- usa el conteo distinto, y su costo debería caer solo con el arreglo de RLS.
-- Reescribir lo que no está roto es cómo se introducen fallos.
