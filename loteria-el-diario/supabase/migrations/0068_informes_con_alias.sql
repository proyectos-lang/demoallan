-- ===========================================================================
-- Los informes muestran el ALIAS del vendedor, no su nombre registrado.
--
-- POR QUÉ
-- -------
-- El nombre registrado es la razón social —«ANA CAROLINA RECINOS SOLIS»— y no
-- es como se conoce el puesto. Quien lee un informe piensa en «PULPERÍA LA
-- ESQUINA», que es lo que dice el toldo, lo que dice el ticket desde la 0064 y
-- lo que dice el vendedor cuando llama por teléfono. Obligar a traducir
-- mentalmente entre las dos identidades en cada consulta es trabajo que la
-- pantalla puede ahorrar.
--
-- QUÉ CAMBIA EXACTAMENTE, Y QUÉ NO
-- --------------------------------
-- Cambia SÓLO EL RÓTULO que se pinta. No cambia:
--
--   · El CÓDIGO, que sigue viajando en su columna y sigue siendo por lo que se
--     ordena y se busca. Es la identidad estable: el alias se cambia cuando
--     cambia el toldo, el código no cambia nunca.
--   · Lo que se AGRUPA. Todo sigue agrupándose por `vendedor_id`; el rótulo es
--     lo último que se aplica, al proyectar. Dos vendedores con el mismo alias
--     seguirían siendo dos filas, como debe ser.
--   · La AUDITORÍA ni la LIQUIDACIÓN, que guardan el nombre y el código.
--
-- Es decir: se toca la presentación, no la contabilidad.
--
-- SIN ALIAS, EL NOMBRE
-- --------------------
-- `fn_rotulo` —de la 0064— devuelve el alias si lo hay y el nombre si no. Los
-- vendedores sin alias siguen apareciendo exactamente igual que hoy, así que
-- esto no obliga a rellenar nada para que los informes sigan funcionando.
--
-- La regla vive en esa función y no repetida en cada consulta: si cada informe
-- escribiera su propio `coalesce`, bastaría con que uno se olvidara para que
-- el mismo vendedor apareciera con dos identidades según dónde se le mire.
--
-- POR QUÉ SE REESCRIBEN LAS FUNCIONES ENTERAS
-- -------------------------------------------
-- Postgres no deja cambiar una línea de una función: hay que volver a
-- declararla completa. Los cuerpos que siguen son los VIGENTES —de la 0051,
-- 0052, 0055 y 0058— copiados tal cual, con un único cambio en cada uno: donde
-- decía `v.nombre` ahora dice `public.fn_rotulo(v.alias, v.nombre)`.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Informe de gerencia
--
-- Cuerpo de la 0055, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

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
         public.fn_rotulo(v.alias, v.nombre),
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

-- --------------------------------------------------------------------------
-- Saldos por vendedor
--
-- Cuerpo de la 0051, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

create or replace function public.fn_saldos_por_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_activo       boolean,
  r_anterior     numeric,   -- pendiente de las semanas anteriores a p_desde
  r_venta        numeric,   -- lo que movió en la semana
  r_comision     numeric,
  r_premios      numeric,
  r_semana       numeric,   -- saldo de la semana: venta − comisión − premios
  r_liquidado    numeric,   -- la parte de la semana ya cerrada en un corte
  r_pendiente    numeric,   -- lo que falta de la semana
  r_actual       numeric    -- r_anterior + r_pendiente
)
language sql
stable
security definer
set search_path = public
as $$
  with fila as (
    select lq.vendedor_id,
           s.fecha,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
  ),
  -- Lo que quedó sin cerrar ANTES de la semana pedida.
  antes as (
    select vendedor_id, sum(saldo) as anterior
    from fila
    where fecha < p_desde and not pagada
    group by vendedor_id
  ),
  -- Lo de la semana, separando lo ya cerrado de lo que falta.
  semana as (
    select vendedor_id,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as liquidado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from fila
    where fecha between p_desde and p_hasta
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         coalesce(a.anterior, 0),
         coalesce(s.venta, 0),
         coalesce(s.comision, 0),
         coalesce(s.premios, 0),
         coalesce(s.saldo, 0),
         coalesce(s.liquidado, 0),
         coalesce(s.pendiente, 0),
         coalesce(a.anterior, 0) + coalesce(s.pendiente, 0)
  from public.vendedor v
  left join antes  a on a.vendedor_id = v.id
  left join semana s on s.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera dado de baja que siga debiendo o a
  -- quien se le siga debiendo: si tiene saldo, tiene que salir hasta saldarlo.
  where v.activo
     or coalesce(a.anterior, 0) <> 0
     or coalesce(s.venta, 0) <> 0
  order by v.codigo;
$$;

-- --------------------------------------------------------------------------
-- Control de vendedores
--
-- Cuerpo de la 0052, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

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
as $$
  with
  -- Los sorteos del rango, una sola vez: los demás bloques se enganchan aquí.
  sorteos as (
    select s.id, s.estado
    from public.sorteo s
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
  ),
  -- Los importes de lo YA liquidado, del agregado y no de las líneas.
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
  sin_liquidar as (
    select t.vendedor_id, sum(l.monto) as pendiente
    from sorteos s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where s.estado <> 'liquidado'
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by t.vendedor_id
  ),
  -- Conteos. Contar no obliga a sumar importes ni a ordenar nada.
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
         coalesce(q.venta, 0) + coalesce(p.pendiente, 0),
         coalesce(q.comision, 0),
         coalesce(q.premios, 0),
         coalesce(q.utilidad, 0),
         coalesce(p.pendiente, 0)
  from public.vendedor v
  -- Externos: un vendedor sin ventas en el rango debe aparecer con ceros, no
  -- desaparecer de la comparación. Es justo lo que hay que ver de él.
  left join liquidado    q on q.vendedor_id = v.id
  left join sin_liquidar p on p.vendedor_id = v.id
  left join conteos      c on c.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(q.venta, 0) + coalesce(p.pendiente, 0) desc, v.codigo;
$$;

-- --------------------------------------------------------------------------
-- Detalle de venta
--
-- Cuerpo de la 0058, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

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
           -- Con nombre EXPLÍCITO: dentro de un CTE la columna hereda el
           -- nombre de la columna proyectada —era `nombre` cuando decía
           -- `v.nombre`—, y una expresión no hereda ninguno. Sin este alias,
           -- el `select` de abajo que dice `m.nombre` no encuentra nada.
           public.fn_rotulo(v.alias, v.nombre) as nombre,
           t.creado_en,
           t.anulado_en,
           t.motivo_anulacion,
           count(l.id)::integer      as lineas,
           sum(l.monto)              as total,
           sum(l.premio)             as premio,
           -- La jugada tal como se lee en el papel: número y monto, en orden.
           -- Entero sin decimales, con céntimos sólo si de verdad los hay.
           string_agg(
             lpad(l.numero::text, 2, '0') || ':' ||
             case when l.monto = trunc(l.monto)
                  then trunc(l.monto)::bigint::text
                  else to_char(l.monto, 'FM999999990.00')
             end,
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
             t.vendedor_id, v.codigo, v.alias, v.nombre, t.creado_en,
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

-- --------------------------------------------------------------------------
-- Resumen por vendedor (tablero)
--
-- Cuerpo de la 0028, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

create or replace function public.fn_resumen_vendedor(
  p_desde date,
  p_hasta date
) returns table (
  vendedor_id uuid,
  codigo      text,
  nombre      text,
  color       text,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with liq as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios,
           sum(lq.utilidad) as utilidad
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  pend as (
    select t.vendedor_id, sum(l.monto) as venta
    from public.sorteo s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
    group by t.vendedor_id
  )
  select v.id, v.codigo, public.fn_rotulo(v.alias, v.nombre), v.color,
         -- La venta incluye lo pendiente; comisión, premios y utilidad no,
         -- porque de un sorteo sin liquidar aún no se conocen.
         coalesce(liq.venta, 0) + coalesce(pend.venta, 0),
         coalesce(liq.comision, 0),
         coalesce(liq.premios, 0),
         coalesce(liq.utilidad, 0)
  from public.vendedor v
  left join liq  on liq.vendedor_id = v.id
  left join pend on pend.vendedor_id = v.id
  where v.activo
  order by 5 desc, v.codigo;
$$;

-- --------------------------------------------------------------------------
-- Reportes por vendedor
--
-- Cuerpo de la 0029, con `v.nombre` -> `fn_rotulo(v.alias, v.nombre)`.
-- --------------------------------------------------------------------------

create or replace function public.fn_reporte_filas(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        public.hora_sorteo default null,
  p_numero      smallint default null,
  p_limite      integer  default 80,
  p_desde_fila  integer  default 0
) returns table (
  fecha          date,
  hora           public.hora_sorteo,
  estado         public.estado_sorteo,
  numero_ganador smallint,
  vendedor_id    uuid,
  vendedor       text,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  -- Liquidado: la fila ya existe, calculada desde las líneas.
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         lq.vendedor_id, public.fn_rotulo(v.alias, v.nombre),
         lq.venta, lq.comision, lq.premios, lq.utilidad
  from public.liquidacion lq
  join public.sorteo s   on s.id = lq.sorteo_id
  join public.vendedor v on v.id = lq.vendedor_id
  where s.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora         = p_hora)
    and (p_numero      is null or s.numero_ganador = p_numero)

  union all

  -- Sin liquidar: se suma desde las líneas, que es lo único que hay. Comisión,
  -- premios y utilidad van en cero a propósito: de un sorteo abierto no se
  -- conocen, y ponerlos sería proyectar (§2).
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         t.vendedor_id, public.fn_rotulo(v.alias, v.nombre),
         sum(l.monto), 0::numeric, 0::numeric, 0::numeric
  from public.sorteo s
  join public.ticket t   on t.sorteo_id = s.id and t.anulado_en is null
  join public.linea  l   on l.ticket_id = t.id
  join public.vendedor v on v.id = t.vendedor_id
  where s.fecha between p_desde and p_hasta
    and s.estado <> 'liquidado'
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora        = p_hora)
    -- Un sorteo sin liquidar no tiene número ganador: si se filtra por número,
    -- por definición no puede aparecer.
    and p_numero is null
  group by s.fecha, s.hora, s.estado, s.numero_ganador, t.vendedor_id, v.alias, v.nombre

  -- Fecha descendente pero hora ascendente dentro del día: lo más reciente
  -- arriba, y dentro de la jornada en el orden en que ocurrió.
  order by 1 desc, 2 asc, 6 asc
  limit p_limite offset p_desde_fila;
$$;


-- --------------------------------------------------------------------------
-- Permisos y constancia.
--
-- Volver a declarar una función RESTABLECE sus permisos por omisión, así que
-- los `revoke` hay que repetirlos: sin esto, seis funciones que leen la venta
-- de todos los vendedores quedarían ejecutables por `anon`.
-- --------------------------------------------------------------------------

revoke execute on function public.fn_informe_gerencia(date, date, public.hora_sorteo)
  from public, anon;
revoke execute on function public.fn_saldos_por_vendedor(date, date)
  from public, anon;
revoke execute on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo)
  from public, anon;
revoke execute on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer)
  from public, anon;

comment on function public.fn_informe_gerencia(date, date, public.hora_sorteo) is
  'Informe de gerencia por vendedor. Muestra el alias si lo tiene; el codigo sigue siendo la identidad estable.';
comment on function public.fn_saldos_por_vendedor(date, date) is
  'Saldos por vendedor. Muestra el alias si lo tiene.';
comment on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo) is
  'Control de vendedores. Muestra el alias si lo tiene.';
comment on function public.fn_detalle_venta(date, date, uuid[], public.hora_sorteo, boolean, integer) is
  'Detalle de venta ticket a ticket. Muestra el alias del vendedor si lo tiene.';
revoke execute on function public.fn_resumen_vendedor(date, date)
  from public, anon;
revoke execute on function public.fn_reporte_filas(date, date, uuid, public.hora_sorteo, smallint, integer, integer)
  from public, anon;

comment on function public.fn_resumen_vendedor(date, date) is
  'Resumen por vendedor para el tablero. Muestra el alias si lo tiene.';
comment on function public.fn_reporte_filas(date, date, uuid, public.hora_sorteo, smallint, integer, integer) is
  'Filas de reporte por vendedor. Muestra el alias si lo tiene.';
