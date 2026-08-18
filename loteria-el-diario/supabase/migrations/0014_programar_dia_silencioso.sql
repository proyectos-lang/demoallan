-- ===========================================================================
-- `fn_programar_dia` deja de mentir y de hacer ruido.
--
-- Dos defectos que sólo se hicieron visibles cuando el cron empezó a llamarla
-- cada cinco minutos:
--
--   1. Contaba mal. `v_creados` se incrementaba en cada vuelta del bucle sin
--      mirar si el `on conflict do nothing` había insertado algo, así que
--      siempre devolvía 3 — incluso cuando el día ya estaba programado y no
--      creó nada. Un contador que no cuenta es peor que no tener contador.
--
--   2. Auditaba siempre. Dos filas por pasada del ciclo, 576 al día, unas
--      210.000 al año. La bitácora existe para poder reconstruir qué pasó con
--      un sorteo o un ticket; sepultada bajo ese ruido deja de servir para
--      eso. Una acción que no cambió nada no es un hecho auditable.
--
-- El ciclo sigue siendo idempotente; ahora también lo es su rastro.
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
      ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa')
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
