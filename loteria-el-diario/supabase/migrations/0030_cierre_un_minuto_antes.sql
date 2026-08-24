-- ===========================================================================
-- La venta cierra un minuto antes del sorteo, no diez.
--
-- El margen de diez minutos venía del prototipo (20:00 cerraba 19:50) y era
-- una suposición, no una regla del negocio. En la calle el vendedor sigue
-- recibiendo apuestas hasta que empieza el sorteo, así que diez minutos de
-- venta cerrada eran diez minutos de ticket perdido, tres veces al día.
--
-- LO QUE `on conflict do nothing` NO ARREGLA
-- -----------------------------------------
-- `fn_programar_dia` es idempotente a propósito, y por eso NO recalcula el
-- `hora_cierre` de un sorteo que ya existe. Además `fn_ciclo_sorteos` programa
-- hoy Y mañana en cada pasada (0013:100-101), de modo que en el momento de
-- aplicar esta migración siempre hay al menos un día ya sembrado con el valor
-- viejo. De ahí el UPDATE de arrastre del final: sin él, mañana seguiría
-- cerrando a y:50 y el cambio parecería no haber surtido efecto.
--
-- EL CRON SIGUE EN */5, Y ESTÁ BIEN
-- --------------------------------
-- Con el cierre a y:59 y el ciclo despertando cada cinco minutos, un sorteo
-- puede quedarse en `estado = 'abierto'` hasta cinco minutos después de haber
-- dejado de vender. No importa: `fn_registrar_ticket` compara `now()` contra
-- `hora_cierre` por su cuenta (0011:74), así que la venta se corta al segundo
-- exacto. Lo que se retrasa es la etiqueta del estado, no el corte.
-- ===========================================================================

create or replace function allan.fn_programar_dia(p_fecha date)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_hora    allan.hora_sorteo;
  v_time    time;
  v_insert  integer;
  v_creados integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_hora in array array['11:00', '15:00', '20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_hora
                when '11:00' then time '11:00'
                when '15:00' then time '15:00'
                else time '20:00'
              end;

    insert into allan.sorteo (fecha, hora, hora_cierre)
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
    perform allan.fn_auditar('sorteo', null, 'programar_dia', 'fecha',
                             null, p_fecha::text);
  end if;

  return v_creados;
end;
$$;

comment on function allan.fn_programar_dia(date) is
  'Siembra los tres sorteos de una fecha. La venta cierra un minuto antes de cada sorteo.';

-- --- Arrastre --------------------------------------------------------------
-- Los sorteos ya sembrados que todavía no han cerrado se recalculan. Los
-- `cerrado` y `liquidado` se dejan como están: su hora_cierre es un hecho
-- histórico y moverla reescribiría el pasado.
update allan.sorteo s
set hora_cierre = ((s.fecha + (s.hora::text)::time - interval '1 minute')
                    at time zone 'America/Tegucigalpa')
where s.estado in ('programado', 'abierto')
  and s.fecha >= (now() at time zone 'America/Tegucigalpa')::date;
