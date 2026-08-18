-- ===========================================================================
-- Ciclo automático de sorteos.
--
-- Hasta ahora abrir y cerrar sorteos era manual, y eso dejaba dos agujeros
-- operativos reales:
--
--   · Un sorteo podía quedar `abierto` pasada su hora de cierre. El POS lo
--     filtraba por fecha, pero la liquidación no podía avanzar hasta que
--     alguien pulsara «cerrar venta».
--   · Si nadie programaba el día, sencillamente no se podía vender.
--
-- Ahora lo hace pg_cron dentro de la propia base. Sin servicio externo, sin
-- credenciales que custodiar y sin depender de que la aplicación esté
-- levantada: si la base está viva, el ciclo corre.
-- ===========================================================================

-- --- Límite de la casa por franja -----------------------------------------
-- Estaba incrustado en un script de operación. Es un parámetro del negocio y
-- le corresponde vivir en la base, donde el cron pueda leerlo y donde quede
-- constancia de quién lo cambió.

create table if not exists allan.limite_franja (
  hora           allan.hora_sorteo primary key,
  limite_casa    numeric(14,2) not null,
  actualizado_en timestamptz not null default now(),

  constraint limite_franja_positivo check (limite_casa > 0)
);

comment on table allan.limite_franja is
  'Límite global de la casa por número, DIFERENCIADO POR FRANJA (§13). El sorteo de la noche vende bastante más que el de la mañana: un valor único ahoga una franja o sobreexpone la otra.';

insert into allan.limite_franja (hora, limite_casa) values
  ('11:00', 4000),
  ('15:00', 5000),
  ('20:00', 7000)
on conflict (hora) do nothing;

alter table allan.limite_franja enable row level security;

create policy limite_franja_lectura on allan.limite_franja
  for select to authenticated using (true);

-- --- La guarda tiene que dejar pasar al cron ------------------------------
-- pg_cron no entra por PostgREST: no hay JWT y por tanto no hay rol de
-- aplicación que comprobar. Una sesión sin claims es una conexión directa a la
-- base, que ya tiene privilegios propios — no se está ampliando nada, sólo se
-- reconoce que la comprobación de rol no aplica ahí.

create or replace function allan.fn_exige(p_roles allan.rol_usuario[])
returns void
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_rol allan.rol_usuario;
begin
  -- Conexión directa (psql, pg_cron): sin JWT no hay rol de aplicación.
  if coalesce(nullif(current_setting('request.jwt.claims', true), ''), '') = '' then
    return;
  end if;

  if allan.fn_es_servicio() then
    return;
  end if;

  v_rol := allan.fn_rol_actual();

  if v_rol is null or not (v_rol = any (p_roles)) then
    raise exception 'No tiene permiso para esta operación.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- --- El ciclo --------------------------------------------------------------
-- Idempotente por diseño: se puede correr cada minuto sin efectos duplicados.
-- Sólo actúa cuando hay algo que hacer, y nunca al revés — no reabre un sorteo
-- cerrado ni toca uno liquidado.

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
begin
  -- 1. Programar hoy y mañana. Mañana se adelanta para que la primera venta
  --    del día no dependa de que el cron haya corrido esa madrugada.
  perform allan.fn_programar_dia(v_hoy);
  perform allan.fn_programar_dia(v_manana);

  -- 2. Abrir los que ya deberían estar vendiendo: programados cuya hora de
  --    cierre todavía no llega.
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

  -- 3. Cerrar los que ya vencieron. A partir de aquí no entra ninguna venta y
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

-- El ciclo no es invocable desde la aplicación: lo dispara el cron, y las
-- acciones sueltas (abrir, cerrar) siguen disponibles para administración.
revoke execute on function allan.fn_ciclo_sorteos() from public, anon, authenticated;

-- --- Programación ----------------------------------------------------------

create extension if not exists pg_cron;

-- Cada cinco minutos. La hora de cierre es a y:50 en punto, así que el peor
-- retraso posible para cerrar la venta son cinco minutos — margen aceptable
-- frente al costo de despertar la base cada minuto.
select cron.unschedule('allan-ciclo-sorteos')
where exists (select 1 from cron.job where jobname = 'allan-ciclo-sorteos');

select cron.schedule(
  'allan-ciclo-sorteos',
  '*/5 * * * *',
  $cron$ select allan.fn_ciclo_sorteos(); $cron$
);
