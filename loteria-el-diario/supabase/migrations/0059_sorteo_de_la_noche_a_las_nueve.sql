-- ===========================================================================
-- El sorteo de la noche pasa a las 9:00 PM; la venta cierra a las 8:59.
--
-- POR QUÉ SE RENOMBRA EL ENUM Y NO SE AÑADE UN VALOR
-- --------------------------------------------------
-- La hora del sorteo no es un dato cualquiera: es un valor de `hora_sorteo`
-- que identifica la franja en TODA la base —`sorteo.hora`, `limite_franja`,
-- los filtros de los informes— y que está guardado en cada sorteo ya creado.
--
-- Añadir un `'21:00'` nuevo dejaría los dos conviviendo: los sorteos viejos
-- seguirían diciendo `20:00`, los nuevos `21:00`, y cualquier informe que
-- agrupe por franja partiría la noche en dos series que no se suman. Un año
-- después nadie sabría por qué la noche aparece dos veces.
--
-- `alter type ... rename value` cambia la ETIQUETA sin tocar las filas: los
-- sorteos existentes pasan a decir `21:00` automáticamente, porque lo que
-- guardan es el valor del enum, no su texto. Es exactamente la operación que
-- corresponde a «este sorteo ahora se juega una hora más tarde», y no hay
-- ningún dato que reescribir.
--
-- EL CIERRE SE CALCULA SOLO
-- -------------------------
-- `fn_programar_dia` deriva la hora de cierre del propio nombre de la franja
-- —`time '21:00'` menos un minuto— así que al renombrar, los sorteos nuevos
-- salen cerrando a las 20:59 sin tocar esa cuenta. Lo único que hay que hacer
-- a mano es arrastrar los YA SEMBRADOS, porque `on conflict do nothing` no
-- recalcula lo que ya existe. Misma situación que la 0030, cuando el cierre
-- pasó de diez minutos a uno.
--
-- LO QUE NO SE TOCA
-- -----------------
-- Los sorteos ya CERRADOS o LIQUIDADOS conservan su hora de cierre: es un
-- hecho histórico —a esa hora dejó de entrar venta— y moverlo reescribiría el
-- pasado. Sólo se arrastran los que todavía no han cerrado.
-- ===========================================================================

-- 1. La etiqueta de la franja. Arrastra sola todas las filas que la usan.
alter type public.hora_sorteo rename value '20:00' to '21:00';


-- 2. `fn_programar_dia`, con la franja nueva.
--    El cuerpo es idéntico salvo el nombre de la hora: `v_time` se deriva de
--    la etiqueta, así que el cierre a las 20:59 sale de aquí sin más cuenta.
create or replace function public.fn_programar_dia(p_fecha date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hora    public.hora_sorteo;
  v_time    time;
  v_insert  integer;
  v_creados integer := 0;
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  foreach v_hora in array array['11:00', '15:00', '21:00']::public.hora_sorteo[]
  loop
    v_time := case v_hora
                when '11:00' then time '11:00'
                when '15:00' then time '15:00'
                else time '21:00'
              end;

    insert into public.sorteo (fecha, hora, hora_cierre)
    values (
      p_fecha,
      v_hora,
      ((p_fecha + v_time - interval '1 minute') at time zone 'America/Tegucigalpa')
    )
    on conflict (fecha, hora) do nothing;

    -- Lo que realmente entró, no lo que se intentó.
    get diagnostics v_insert = row_count;
    v_creados := v_creados + v_insert;
  end loop;

  -- Sólo se audita si el día se programó de verdad.
  if v_creados > 0 then
    perform public.fn_auditar('sorteo', null, 'programar_dia', 'fecha',
                             null, p_fecha::text);
  end if;

  return v_creados;
end;
$$;

comment on function public.fn_programar_dia(date) is
  'Siembra los tres sorteos de una fecha: 11:00 AM, 3:00 PM y 9:00 PM. La venta cierra un minuto antes de cada uno.';


-- 3. Arrastre de los ya sembrados.
--    `on conflict do nothing` no recalcula un sorteo que ya existe, y
--    `fn_ciclo_sorteos` siembra hoy Y mañana en cada pasada: en el momento de
--    aplicar esto siempre hay al menos un día con el cierre viejo. Sin este
--    UPDATE, mañana seguiría cerrando a las 19:59 y el cambio parecería no
--    haber surtido efecto.
update public.sorteo s
set hora_cierre = ((s.fecha + time '21:00' - interval '1 minute')
                    at time zone 'America/Tegucigalpa')
where s.hora = '21:00'
  and s.estado in ('programado', 'abierto')
  and s.fecha >= (now() at time zone 'America/Tegucigalpa')::date;


-- 4. Comprobación. Si algún sorteo futuro de la noche quedó con la hora vieja,
--    esto lo dice en vez de dar por hecho que salió bien.
do $$
declare
  v_mal integer;
begin
  select count(*) into v_mal
  from public.sorteo s
  where s.hora = '21:00'
    and s.estado in ('programado', 'abierto')
    and s.fecha >= (now() at time zone 'America/Tegucigalpa')::date
    and extract(hour from (s.hora_cierre at time zone 'America/Tegucigalpa')) <> 20;

  if v_mal > 0 then
    raise exception 'Quedaron % sorteos de la noche con la hora de cierre vieja.', v_mal;
  end if;

  raise notice 'El sorteo de la noche se juega a las 9:00 PM y cierra a las 8:59 PM.';
end $$;
