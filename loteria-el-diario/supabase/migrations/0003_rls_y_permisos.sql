-- ===========================================================================
-- Seguridad: RLS, permisos y vista pública
--
-- Modelo: TODA escritura pasa por las funciones SECURITY DEFINER de 0002. Por
-- eso aquí sólo se conceden políticas de LECTURA. La ausencia de políticas de
-- INSERT/UPDATE/DELETE no es un olvido: es lo que impide que un cliente con la
-- llave anon escriba directamente en `linea` o `cupo_numero` y se salte la
-- validación de cupo.
-- ===========================================================================

-- --- Exposición del esquema ------------------------------------------------
-- Además de esto hay que añadir `allan` a "Exposed schemas" en
-- Dashboard → Project Settings → API. Sin ese paso PostgREST no lo ve.

grant usage on schema allan to anon, authenticated, service_role;

-- `authenticated` recibe permisos de tabla, pero RLS es la puerta real.
grant select on all tables in schema allan to authenticated;
grant execute on all routines in schema allan to authenticated;
grant usage, select on all sequences in schema allan to authenticated;

-- `anon` NO recibe acceso a ninguna tabla. Sólo a la vista pública, más abajo.

grant all on all tables in schema allan to service_role;
grant all on all routines in schema allan to service_role;
grant all on all sequences in schema allan to service_role;

alter default privileges for role postgres in schema allan
  grant select on tables to authenticated;
alter default privileges for role postgres in schema allan
  grant all on tables to service_role;
alter default privileges for role postgres in schema allan
  grant execute on routines to authenticated, service_role;
alter default privileges for role postgres in schema allan
  grant usage, select on sequences to authenticated, service_role;

-- --- RLS activo en todo ----------------------------------------------------

alter table allan.vendedor            enable row level security;
alter table allan.parametro_vendedor  enable row level security;
alter table allan.sorteo              enable row level security;
alter table allan.cupo_numero         enable row level security;
alter table allan.dispositivo         enable row level security;
alter table allan.cuota_dispositivo   enable row level security;
alter table allan.ticket              enable row level security;
alter table allan.linea               enable row level security;
alter table allan.liquidacion         enable row level security;
alter table allan.lote_ocr            enable row level security;
alter table allan.auditoria           enable row level security;
alter table allan.usuario_perfil      enable row level security;
alter table allan.escenario           enable row level security;

-- --- Perfil propio ---------------------------------------------------------

create policy perfil_propio on allan.usuario_perfil
  for select to authenticated
  using (id = auth.uid());

create policy perfil_admin on allan.usuario_perfil
  for select to authenticated
  using (allan.fn_rol_actual() in ('administrador', 'auditor'));

-- --- Catálogos visibles para todo usuario autenticado ---------------------
-- Nombres de vendedores, calendario de sorteos y cupos: los necesita hasta el
-- POS del vendedor para pintar la rejilla 00–99.

create policy vendedor_lectura on allan.vendedor
  for select to authenticated using (true);

create policy sorteo_lectura on allan.sorteo
  for select to authenticated using (true);

create policy cupo_lectura on allan.cupo_numero
  for select to authenticated using (true);

-- --- Parámetros ------------------------------------------------------------
-- El vendedor ve los suyos (su POS muestra factor y comisión); administración
-- y auditoría ven todos.

create policy parametro_propio on allan.parametro_vendedor
  for select to authenticated
  using (
    vendedor_id = allan.fn_vendedor_actual()
    or allan.fn_rol_actual() in ('administrador', 'auditor')
  );

-- --- Tickets y líneas ------------------------------------------------------
-- El vendedor es el usuario crítico pero también el más acotado: ve
-- únicamente sus propios tickets.

create policy ticket_propio on allan.ticket
  for select to authenticated
  using (
    vendedor_id = allan.fn_vendedor_actual()
    or allan.fn_rol_actual() in ('administrador', 'auditor', 'digitador')
  );

create policy linea_por_ticket on allan.linea
  for select to authenticated
  using (
    exists (
      select 1 from allan.ticket t
      where t.id = linea.ticket_id
        and (
          t.vendedor_id = allan.fn_vendedor_actual()
          or allan.fn_rol_actual() in ('administrador', 'auditor', 'digitador')
        )
    )
  );

create policy liquidacion_propia on allan.liquidacion
  for select to authenticated
  using (
    vendedor_id = allan.fn_vendedor_actual()
    or allan.fn_rol_actual() in ('administrador', 'auditor')
  );

-- --- Dispositivos y cuota --------------------------------------------------

create policy dispositivo_propio on allan.dispositivo
  for select to authenticated
  using (
    vendedor_id = allan.fn_vendedor_actual()
    or allan.fn_rol_actual() in ('administrador', 'auditor')
  );

create policy cuota_propia on allan.cuota_dispositivo
  for select to authenticated
  using (
    exists (
      select 1 from allan.dispositivo d
      where d.id = cuota_dispositivo.dispositivo_id
        and (
          d.vendedor_id = allan.fn_vendedor_actual()
          or allan.fn_rol_actual() in ('administrador', 'auditor')
        )
    )
  );

-- --- Digitalización --------------------------------------------------------
-- El digitador carga y valida lotes; no toca parámetros ni captura resultados.

create policy lote_digitador on allan.lote_ocr
  for select to authenticated
  using (allan.fn_rol_actual() in ('digitador', 'administrador', 'auditor'));

-- --- Auditoría -------------------------------------------------------------
-- Sólo lectura, y sólo para quien audita. Nadie tiene INSERT directo: se
-- escribe exclusivamente desde allan.fn_auditar.

create policy auditoria_lectura on allan.auditoria
  for select to authenticated
  using (allan.fn_rol_actual() in ('administrador', 'auditor'));

revoke insert, update, delete on allan.auditoria from authenticated;

-- --- Escenarios del simulador ---------------------------------------------

create policy escenario_lectura on allan.escenario
  for select to authenticated
  using (allan.fn_rol_actual() in ('administrador', 'auditor'));

-- --- Vista pública de resultados ------------------------------------------
-- La consulta pública no lleva autenticación. Expone EXACTAMENTE tres campos.
--
-- Deliberadamente NO se marca `security_invoker`: la vista corre con los
-- permisos de su dueño y por eso `anon` puede leerla sin tener ninguna
-- política sobre `allan.sorteo`. Es la única puerta abierta al público, y el
-- WHERE la limita a sorteos ya liquidados.
--
-- Lo que NO sale de aquí: coordenadas de venta, montos, vendedores y usuarios.
-- La coordenada es dato operativo sensible (§10) y sólo la ven perfiles
-- administrativos.

create view allan.v_resultado_publico as
  select fecha, hora, numero_ganador
  from allan.sorteo
  where estado = 'liquidado'
    and numero_ganador is not null;

grant select on allan.v_resultado_publico to anon, authenticated;

comment on view allan.v_resultado_publico is
  'Única superficie legible sin autenticación. Nunca añadir columnas de monto, vendedor o coordenada.';
