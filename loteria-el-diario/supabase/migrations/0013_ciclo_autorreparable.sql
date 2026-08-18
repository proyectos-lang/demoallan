-- ===========================================================================
-- El ciclo repara el cupo faltante.
--
-- QUÉ PROBLEMA CIERRA
-- -------------------
-- Un sorteo puede quedar `abierto` o `cerrado` sin sus 100 filas de
-- `cupo_numero`. Se llega ahí por un borrado administrativo demasiado amplio,
-- por una restauración parcial, o por cualquier intervención manual sobre la
-- base. El síntoma es desconcertante: el sorteo aparece en venta y TODA venta
-- falla con «el sorteo no tiene cupo sembrado para el número N».
--
-- `fn_abrir_sorteo` no lo arregla porque sólo actúa sobre sorteos
-- `programado`. El ciclo, que corre cada cinco minutos, es el sitio natural
-- para detectarlo y repararlo: un trabajo periódico que sólo avanza estados y
-- no cura lo que encuentra roto deja el sistema caído hasta que alguien mire.
--
-- CÓMO RECONSTRUYE `vendido`
-- --------------------------
-- No lo pone en cero: lo suma desde las líneas de los tickets vigentes de ese
-- sorteo. Las líneas son la unidad atómica y la única fuente de verdad; poner
-- cero regalaría cupo ya consumido y permitiría sobrevender.
-- ===========================================================================

create or replace function allan.fn_reparar_cupo(p_sorteo_id uuid)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_hora    allan.hora_sorteo;
  v_estado  allan.estado_sorteo;
  v_limite  numeric(14,2);
  v_faltan  integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select s.hora, s.estado into v_hora, v_estado
  from allan.sorteo s where s.id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  -- Un sorteo programado todavía no debe tener cupo, y uno liquidado ya no
  -- admite ventas: en ninguno de los dos casos hay nada que reparar.
  if v_estado not in ('abierto', 'cerrado') then
    return 0;
  end if;

  select l.limite_casa into v_limite
  from allan.limite_franja l where l.hora = v_hora;

  insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
  select p_sorteo_id,
         n,
         coalesce(v_limite, 5000),
         -- Lo ya vendido en ese número, reconstruido desde las líneas.
         coalesce((
           select sum(li.monto)
           from allan.linea li
           join allan.ticket t on t.id = li.ticket_id
           where t.sorteo_id = p_sorteo_id
             and t.anulado_en is null
             and li.numero = n
         ), 0)
  from generate_series(0, 99) as n
  on conflict (sorteo_id, numero) do nothing;

  get diagnostics v_faltan = row_count;

  if v_faltan > 0 then
    perform allan.fn_auditar('sorteo', p_sorteo_id, 'reparar_cupo', 'numeros',
                             null, v_faltan::text);
  end if;

  return v_faltan;
end;
$$;

-- --- El ciclo, ahora autorreparable ---------------------------------------

create or replace function allan.fn_ciclo_sorteos()
returns table (accion text, fecha date, hora allan.hora_sorteo)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_hoy     date := (now() at time zone 'America/Tegucigalpa')::date;
  v_manana  date := v_hoy + 1;
  v_s       record;
  v_limite  numeric(14,2);
  v_repar   integer;
begin
  -- 1. Programar hoy y mañana. Mañana se adelanta para que la primera venta
  --    del día no dependa de que el cron haya corrido esa madrugada.
  perform allan.fn_programar_dia(v_hoy);
  perform allan.fn_programar_dia(v_manana);

  -- 2. Abrir los que ya deberían estar vendiendo.
  for v_s in
    select s.id, s.fecha, s.hora
    from allan.sorteo s
    where s.estado = 'programado'
      and s.hora_cierre > now()
      and s.fecha <= v_manana
    order by s.hora_cierre
  loop
    select l.limite_casa into v_limite
    from allan.limite_franja l where l.hora = v_s.hora;

    perform allan.fn_abrir_sorteo(v_s.id, coalesce(v_limite, 5000));

    accion := 'abrir'; fecha := v_s.fecha; hora := v_s.hora;
    return next;
  end loop;

  -- 3. Reparar el cupo de los que están en venta o cerrados y lo tengan
  --    incompleto. Va ANTES de cerrar, para que un sorteo que se cierra en
  --    esta misma pasada quede con su cupo íntegro para la liquidación.
  for v_s in
    select s.id, s.fecha, s.hora
    from allan.sorteo s
    where s.estado in ('abierto', 'cerrado')
      and (select count(*) from allan.cupo_numero c where c.sorteo_id = s.id) < 100
    order by s.fecha, s.hora
  loop
    v_repar := allan.fn_reparar_cupo(v_s.id);
    if v_repar > 0 then
      accion := 'reparar_cupo'; fecha := v_s.fecha; hora := v_s.hora;
      return next;
    end if;
  end loop;

  -- 4. Cerrar los que ya vencieron. A partir de aquí no entra ninguna venta y
  --    la liquidación puede cuadrar contra un total que ya no cambia.
  for v_s in
    select s.id, s.fecha, s.hora
    from allan.sorteo s
    where s.estado = 'abierto'
      and s.hora_cierre <= now()
    order by s.hora_cierre
  loop
    perform allan.fn_cerrar_sorteo(v_s.id);

    accion := 'cerrar'; fecha := v_s.fecha; hora := v_s.hora;
    return next;
  end loop;

  -- Los sorteos `programado` cuya hora ya pasó se quedan como están: nunca
  -- abrieron, así que no tienen ventas ni nada que liquidar. Marcarlos de otro
  -- modo sería inventar un estado que el negocio no tiene.
  return;
end;
$$;

revoke execute on function allan.fn_ciclo_sorteos() from public, anon, authenticated;
