-- ===========================================================================
-- Detalle de venta: ticket por ticket, con sus números, para varios vendedores.
--
-- QUÉ HUECO LLENA
-- ---------------
-- El informe de gerencia contesta con totales: cuánto vendió cada uno, cuánto
-- se pagó, qué quedó. Cuando algo no cuadra —y la auditoría del 3 de
-- septiembre lo demostró— hace falta bajar hasta la venta individual, y eso
-- sólo se podía haciendo consultas a mano contra la base.
--
-- `fn_bitacora_rango` ya baja al detalle pero de UN vendedor, y la pregunta
-- real es «enséñame el día de estos tres». De ahí `p_vendedores` como arreglo,
-- igual que en `fn_control_vendedores`.
--
-- POR QUÉ UNA FILA POR TICKET Y NO POR LÍNEA
-- ------------------------------------------
-- Un ticket de doce números daría doce filas repitiendo folio y hora, y quien
-- lee tiene que reconstruir mentalmente dónde empieza y acaba cada ticket. Los
-- números vienen agregados en `r_jugada` —«05:10  47:20  99:5»— que es como
-- están en el papel que tiene el cliente en la mano. Eso es lo que se compara
-- cuando alguien reclama.
--
-- El ticket es además la unidad de la duplicación: dos tickets con la misma
-- jugada son el patrón que hay que poder ver de un vistazo.
--
-- LOS ANULADOS SALEN, MARCADOS
-- ----------------------------
-- `p_incluir_anulados` los trae con `r_anulado` en true y su motivo. Un
-- detalle de venta que los esconde no sirve para auditar: cuando alguien
-- pregunta «¿y este ticket?», la respuesta «se anuló por esto» es justo la que
-- hay que poder dar. Por omisión van fuera, que es lo que se quiere para leer
-- la venta del día.
--
-- `r_repetido` marca el ticket cuya jugada ya apareció antes en el mismo
-- vendedor y sorteo. No afirma que sea un error —dos clientes pueden apostar
-- igual— pero es dónde mirar primero.
-- ===========================================================================

create or replace function public.fn_detalle_venta(
  p_desde            date,
  p_hasta            date,
  p_vendedores       uuid[] default null,
  p_hora             public.hora_sorteo default null,
  p_incluir_anulados boolean default false,
  p_limite           integer default 500
)
returns table (
  r_ticket_id      uuid,
  r_folio          text,
  r_fecha          date,
  r_hora           public.hora_sorteo,
  r_estado         public.estado_sorteo,
  r_numero_ganador smallint,
  r_vendedor_id    uuid,
  r_codigo         text,
  r_vendedor       text,
  r_creado_en      timestamptz,
  r_lineas         integer,
  r_total          numeric,
  r_premio         numeric,
  r_jugada         text,
  r_anulado        boolean,
  r_motivo         text,
  r_repetido       boolean,
  r_segundos       numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select t.id,
           t.folio,
           s.fecha,
           s.hora,
           s.estado,
           s.numero_ganador,
           t.vendedor_id,
           v.codigo,
           v.nombre,
           t.creado_en,
           t.anulado_en,
           t.motivo_anulacion,
           count(l.id)::integer      as lineas,
           sum(l.monto)              as total,
           sum(l.premio)             as premio,
           -- La jugada tal como se lee en el papel: número y monto, en orden.
           string_agg(lpad(l.numero::text, 2, '0') || ':' || trim(to_char(l.monto, 'FM999999990.99')),
                      '  ' order by l.numero, l.monto) as jugada,
           -- La firma compara CONTENIDO, no presentación: es lo que permite
           -- detectar que dos tickets llevan exactamente la misma apuesta.
           string_agg(l.numero || ':' || l.monto, ',' order by l.numero, l.monto) as firma
    from public.ticket t
    join public.sorteo   s on s.id = t.sorteo_id
    join public.vendedor v on v.id = t.vendedor_id
    join public.linea    l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
      and (p_incluir_anulados or t.anulado_en is null)
    group by t.id, t.folio, s.fecha, s.hora, s.estado, s.numero_ganador,
             t.vendedor_id, v.codigo, v.nombre, t.creado_en,
             t.anulado_en, t.motivo_anulacion
  ),
  -- Se mira el ticket ANTERIOR con la misma jugada, del mismo vendedor y
  -- sorteo. `lag` sobre esa partición es exactamente esa pregunta.
  marcado as (
    select b.*,
           lag(b.creado_en) over (
             partition by b.vendedor_id, b.hora, b.fecha, b.firma
             order by b.creado_en
           ) as anterior
    from base b
  )
  select m.id,
         m.folio,
         m.fecha,
         m.hora,
         m.estado,
         m.numero_ganador,
         m.vendedor_id,
         m.codigo,
         m.nombre,
         m.creado_en,
         m.lineas,
         m.total,
         m.premio,
         m.jugada,
         m.anulado_en is not null,
         m.motivo_anulacion,
         m.anterior is not null,
         -- Cuántos segundos tras el ticket gemelo anterior. Nulo si es el
         -- primero de su jugada: no hay nada con qué compararlo.
         case when m.anterior is not null
              then round(extract(epoch from (m.creado_en - m.anterior))::numeric, 2)
         end
  from marcado m
  -- Cronológico ascendente: se lee como ocurrió el día, que es como el
  -- vendedor recuerda su jornada y como se cotejan los papeles.
  order by m.fecha, m.hora, m.codigo, m.creado_en
  limit greatest(p_limite, 1);
$$;

comment on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer) is
  'Venta ticket por ticket con su jugada, para uno o varios vendedores. Marca los que repiten una jugada ya vista en el mismo sorteo.';

revoke execute on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer)
  from public, anon;
