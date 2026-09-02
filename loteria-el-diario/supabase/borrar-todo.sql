-- ===========================================================================
-- VACÍA EL ESQUEMA `public`. No hay vuelta atrás.
--
-- Deja la base como estaba antes de la primera migración. Después de esto,
-- `instalar-public.sql` levanta el sistema entero desde cero.
--
-- QUÉ SE LLEVA POR DELANTE
-- ------------------------
-- Todo lo que vive en `public`: vendedores, sorteos, tickets, líneas,
-- liquidaciones, cortes, usuarios y auditoría. El `drop schema cascade` se
-- lleva también las vistas, los índices, los disparadores y las funciones sin
-- nombrarlos uno a uno.
--
-- POR QUÉ SE RECREA EL ESQUEMA EN VEZ DE SÓLO BORRARLO
-- ----------------------------------------------------
-- `public` no es un esquema cualquiera: Postgres y Supabase dan por hecho que
-- existe. Borrarlo y no recrearlo deja el proyecto inservible, no vacío. Por
-- eso el `drop` va seguido inmediatamente de su `create` y de los permisos que
-- Supabase espera encontrar.
--
-- LO QUE NO TOCA
-- --------------
-- Nada fuera de `public`. En particular no toca `auth`, `storage` ni
-- `extensions`, que son de Supabase.
--
-- El bucket de las hojas digitalizadas vive en `storage` y sobrevive a esto.
-- Si también hay que vaciarlo, se hace desde el panel de Supabase: aquí no,
-- porque un `delete` sobre `storage.objects` deja los archivos huérfanos en el
-- disco en vez de liberarlos.
--
-- EL CRON SE DESPROGRAMA ANTES
-- ----------------------------
-- `cron.schedule` guarda sus trabajos en el esquema `cron`, fuera de `public`.
-- Si no se quitan, cada cinco minutos intentarán llamar a funciones que ya no
-- existen y llenarán el registro de errores.
-- ===========================================================================

do $$
declare
  t record;
begin
  -- Sólo si la extensión está instalada: en una base recién creada no lo está.
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for t in select jobname from cron.job
             where jobname like '%diario%' or jobname like '%sorteo%'
    loop
      perform cron.unschedule(t.jobname);
      raise notice 'Desprogramado: %', t.jobname;
    end loop;
  end if;
exception
  when others then
    raise notice 'No se pudo revisar el cron (%), se continúa.', sqlerrm;
end $$;

drop schema if exists public cascade;

create schema public;

-- Los permisos que Supabase da por sentados en `public`. Sin esto, la API
-- responde pero no ve nada.
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;

-- Por si quedara la instalación vieja de un esquema propio.
drop schema if exists allan cascade;

do $$
declare
  n integer;
begin
  select count(*) into n
  from information_schema.tables
  where table_schema = 'public';

  if n = 0 then
    raise notice 'Esquema public vacío. Ahora: instalar-public.sql';
  else
    raise exception 'Quedaron % tablas en public.', n;
  end if;
end $$;
