-- ===========================================================================
-- DESHACER LA ANULACIÓN DE TICKETS.
--
-- Revive tickets anulados por error y les devuelve el cupo que consumían.
-- Es la marcha atrás de `fn_anular_ticket`.
--
-- ESTE GUION SÍ MODIFICA DATOS. Léalo antes de ejecutarlo, y compruebe con el
-- paso 1 qué va a tocar. El paso 2 sólo actúa sobre los tickets que el paso 1
-- lista, así que si el paso 1 muestra algo que no esperaba, PARE.
--
-- POR QUÉ NO HAY UNA FUNCIÓN PARA ESTO
-- ------------------------------------
-- La anulación se diseñó como definitiva: un ticket no se edita, se anula y se
-- vuelve a emitir. Deshacerla es una operación de corrección, no de operación
-- diaria, y por eso vive aquí y no en una pantalla — para que requiera abrir
-- el editor SQL a propósito.
--
-- LAS TRES COLUMNAS VAN JUNTAS
-- ----------------------------
-- `ticket_anulacion_completa` exige que `anulado_en` y `anulado_por` estén las
-- dos puestas o las dos vacías. Limpiar sólo una hace que la base rechace el
-- UPDATE entero, así que se limpian a la vez.
--
-- Y HAY QUE DEVOLVER EL CUPO
-- --------------------------
-- Al anular, `fn_anular_ticket` descuenta de `cupo_numero` lo que el ticket
-- consumía. Al revivirlo hay que volver a sumarlo, o el sistema creerá que
-- queda más cupo disponible del real y dejará vender de más en esos números.
-- Es el paso que se olvida y el que produce sobreventa silenciosa.
--
-- SOBRE SORTEOS LIQUIDADOS
-- ------------------------
-- No lo use sobre un sorteo ya liquidado. Revivir un ticket ahí cambiaría la
-- venta de un vendedor cuya liquidación ya está escrita, y el corte dejaría de
-- cuadrar con lo que se le pagó. El paso 1 avisa si alguno está en ese caso.
-- ===========================================================================


-- ###########################################################################
-- PASO 1. QUÉ SE VA A REVIVIR  (sólo consulta, no cambia nada)
-- ###########################################################################

select
  t.folio,
  v.codigo                          as vendedor,
  s.fecha,
  s.hora                            as sorteo,
  s.estado                          as estado_sorteo,
  t.total,
  t.anulado_en,
  t.motivo_anulacion,
  case
    when s.estado = 'liquidado'
      then 'CUIDADO: sorteo liquidado, revivirlo descuadra la liquidacion'
    else 'se puede revivir'
  end                               as advertencia
from public.ticket t
join public.sorteo   s on s.id = t.sorteo_id
join public.vendedor v on v.id = t.vendedor_id
where t.anulado_en is not null
  -- Acote aquí lo que quiere revivir. Por fecha:
  and s.fecha = date '2026-09-03'
  -- ...o por folios concretos, que es lo más seguro:
  -- and t.folio in ('V002-20260903-0005', 'V002-20260903-0010')
order by t.folio;


-- ###########################################################################
-- PASO 2. REVIVIRLOS  (esto SÍ modifica)
--
-- Todo en una transacción: o se aplica entero o no se aplica nada. Si el
-- reintegro del cupo falla a mitad, no queda un ticket vivo con el cupo sin
-- devolver.
-- ###########################################################################

begin;

-- Los tickets a revivir. El mismo filtro del paso 1: cámbielo en los DOS
-- sitios si lo ajusta, o el cupo se devolverá de unos y los tickets de otros.
create temporary table _revivir on commit drop as
select t.id, t.sorteo_id
from public.ticket t
join public.sorteo s on s.id = t.sorteo_id
where t.anulado_en is not null
  and s.fecha = date '2026-09-03'
  and s.estado <> 'liquidado';        -- nunca sobre un sorteo ya liquidado

-- 2a. Devolver el cupo que la anulación había liberado.
--     Se agrupa por número: un ticket puede repetir el mismo número en varias
--     líneas, y todas cuentan sobre la misma fila de cupo.
update public.cupo_numero c
set vendido = c.vendido + d.monto
from (
  select r.sorteo_id, l.numero, sum(l.monto) as monto
  from _revivir r
  join public.linea l on l.ticket_id = r.id
  group by r.sorteo_id, l.numero
) d
where c.sorteo_id = d.sorteo_id
  and c.numero    = d.numero;

-- 2b. Revivir los tickets. Las tres columnas a la vez: la restricción
--     `ticket_anulacion_completa` rechaza dejar una puesta y otra vacía.
update public.ticket t
set anulado_en       = null,
    anulado_por      = null,
    motivo_anulacion = null
from _revivir r
where t.id = r.id;

-- 2c. Dejar constancia. La bitácora ya tiene el «anular»; sin esto quedaría
--     un ticket vivo con una anulación registrada y ninguna explicación de
--     por qué volvió.
insert into public.auditoria (entidad, entidad_id, accion, campo, valor_anterior, valor_nuevo)
select 'ticket', r.id, 'desanular', 'anulado_en', 'anulado', null
from _revivir r;

-- Revise el recuento antes de confirmar.
select count(*) as tickets_revividos from _revivir;

commit;
-- Si algo no cuadra, escriba `rollback;` en vez de `commit;`.


-- ###########################################################################
-- PASO 3. COMPROBAR  (sólo consulta)
-- ###########################################################################

-- Que no quede ninguno anulado del día.
select count(*) as siguen_anulados
from public.ticket t
join public.sorteo s on s.id = t.sorteo_id
where s.fecha = date '2026-09-03'
  and t.anulado_en is not null;

-- Y que el cupo cuadre con las líneas vivas. Las dos columnas tienen que
-- coincidir en todas las filas; si alguna difiere, el cupo quedó descuadrado.
select c.numero,
       c.vendido                    as dice_el_cupo,
       coalesce(sum(l.monto), 0)    as suman_las_lineas,
       c.vendido - coalesce(sum(l.monto), 0) as diferencia
from public.cupo_numero c
join public.sorteo s on s.id = c.sorteo_id
left join public.ticket t on t.sorteo_id = c.sorteo_id and t.anulado_en is null
left join public.linea  l on l.ticket_id = t.id and l.numero = c.numero
where s.fecha = date '2026-09-03'
  and s.hora  = '11:00'
group by c.numero, c.vendido
having c.vendido <> coalesce(sum(l.monto), 0)
order by c.numero;
-- Sin filas = el cupo cuadra exactamente con las ventas vivas.
