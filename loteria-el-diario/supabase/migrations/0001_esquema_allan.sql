-- ===========================================================================
-- Lotería El Diario — esquema base
--
-- Principio rector: la LÍNEA es la unidad atómica. Todo indicador del sistema
-- (tablero, reportes, bitácora, simulador) es una agregación de líneas; nunca
-- un total capturado a mano ni un agregado que se mantenga por su cuenta.
--
-- Convenciones de esta base:
--   · Dinero      → numeric(14,2). Nunca float.
--   · Comisión    → FRACCIÓN, no porcentaje. 12.5 % se guarda 0.12500.
--                   Así la fórmula es `monto * comision_congelada` directa.
--   · Factor pago → multiplicador, tal cual (70.00 = paga 70 por 1).
--   · Número      → smallint 0..99. El "07" es presentación, no dato.
--   · Zona horaria→ America/Tegucigalpa (UTC-6, sin horario de verano).
-- ===========================================================================

create schema if not exists allan;

create extension if not exists pgcrypto with schema public;

-- --- Enumeraciones ---------------------------------------------------------

create type allan.rol_usuario as enum (
  'vendedor',
  'digitador',
  'administrador',
  'auditor'
);

-- Ciclo de vida del sorteo. `liquidado` es terminal: sólo se sale por una
-- reversión auditada, que es una operación administrativa explícita.
create type allan.estado_sorteo as enum (
  'programado',
  'abierto',
  'cerrado',
  'liquidado'
);

create type allan.hora_sorteo as enum ('11:00', '15:00', '20:00');

create type allan.canal_ticket as enum ('movil', 'ocr');

create type allan.estado_lote as enum (
  'cargado',
  'extraido',
  'en_revision',
  'validado',
  'rechazado'
);

-- --- Vendedores ------------------------------------------------------------

create table allan.vendedor (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nombre        text not null,
  identidad     text,
  telefono      text,
  correo        text,
  ciudad        text not null,
  barrio        text,
  zona          text not null,
  color         text not null,            -- color categórico en gráficos y mapa
  lat           double precision,
  lng           double precision,
  activo        boolean not null default true,   -- baja lógica; nunca DELETE
  creado_en     timestamptz not null default now(),

  constraint vendedor_codigo_formato check (codigo ~ '^V-[0-9]{3}$'),
  constraint vendedor_color_hex      check (color ~* '^#[0-9a-f]{6}$')
);

comment on column allan.vendedor.activo is
  'Baja lógica. Un vendedor nunca se borra: su historial de ventas debe seguir reconstruyendo el pasado.';

-- --- Parámetros versionados ------------------------------------------------
-- No se actualiza en sitio: guardar cierra la fila vigente (vigente_hasta) e
-- inserta otra. Cambiar la configuración de un vendedor jamás reescribe
-- historia; sólo afecta ventas futuras.

create table allan.parametro_vendedor (
  id              uuid primary key default gen_random_uuid(),
  vendedor_id     uuid not null references allan.vendedor(id),
  comision        numeric(6,5) not null,   -- FRACCIÓN: 0.12500 = 12.5 %
  factor_pago     numeric(6,2) not null,   -- multiplicador: 70.00
  tope_por_numero numeric(14,2) not null,  -- tope del vendedor, por número y sorteo
  vigente_desde   timestamptz not null default now(),
  vigente_hasta   timestamptz,             -- null = fila vigente
  creado_por      uuid,

  constraint parametro_comision_rango check (comision >= 0 and comision <= 0.60),
  constraint parametro_factor_rango   check (factor_pago >= 1 and factor_pago <= 200),
  constraint parametro_tope_minimo    check (tope_por_numero >= 10),
  constraint parametro_vigencia       check (vigente_hasta is null or vigente_hasta > vigente_desde)
);

-- Una sola fila vigente por vendedor, garantizado por el índice.
create unique index parametro_vendedor_vigente
  on allan.parametro_vendedor (vendedor_id)
  where vigente_hasta is null;

create index parametro_vendedor_historico
  on allan.parametro_vendedor (vendedor_id, vigente_desde desc);

-- --- Sorteos ---------------------------------------------------------------

create table allan.sorteo (
  id             uuid primary key default gen_random_uuid(),
  fecha          date not null,
  hora           allan.hora_sorteo not null,
  estado         allan.estado_sorteo not null default 'programado',
  hora_cierre    timestamptz not null,
  numero_ganador smallint,
  liquidado_en   timestamptz,
  liquidado_por  uuid,

  unique (fecha, hora),

  constraint sorteo_numero_rango check (
    numero_ganador is null or (numero_ganador between 0 and 99)
  ),

  -- El estado del sorteo es fuente única de verdad: un sorteo que no está
  -- liquidado NO tiene número ganador, y uno liquidado obligatoriamente lo
  -- tiene. Esto hace imposible que un tablero muestre premios de un sorteo
  -- todavía abierto.
  constraint sorteo_ganador_solo_liquidado check (
    (estado = 'liquidado' and numero_ganador is not null and liquidado_en is not null)
    or
    (estado <> 'liquidado' and numero_ganador is null and liquidado_en is null)
  )
);

create index sorteo_fecha on allan.sorteo (fecha desc, hora);
create index sorteo_estado on allan.sorteo (estado) where estado in ('abierto', 'cerrado');

-- --- Cupo por número -------------------------------------------------------
-- Una fila por (sorteo, número): 100 filas por sorteo. Aquí se materializa el
-- límite global de la casa DIFERENCIADO POR FRANJA HORARIA — el sorteo de las
-- 20:00 vende bastante más que el de las 11:00 y merece otro tope.
--
-- Ésta es la fila que `fn_registrar_ticket` bloquea con FOR UPDATE. Es el
-- punto donde se serializa la concurrencia: dos vendedores que compran el
-- mismo número en el mismo segundo no pueden exceder el tope entre ambos.

create table allan.cupo_numero (
  sorteo_id   uuid not null references allan.sorteo(id) on delete cascade,
  numero      smallint not null,
  limite_casa numeric(14,2) not null,
  vendido     numeric(14,2) not null default 0,

  primary key (sorteo_id, numero),
  constraint cupo_numero_rango  check (numero between 0 and 99),
  constraint cupo_no_negativo   check (vendido >= 0),
  constraint cupo_no_excedido   check (vendido <= limite_casa)
);

comment on constraint cupo_no_excedido on allan.cupo_numero is
  'Última línea de defensa contra la sobreventa: aunque la lógica de la función fallara, la base rechaza el INSERT.';

-- --- Dispositivos y cuota offline -----------------------------------------
-- Decisión de arquitectura §13: cuota descontable por dispositivo. Al abrir el
-- sorteo, cada dispositivo reserva una porción del cupo de cada número. Nada
-- de lo que el vendedor registre sin conexión puede exceder el tope, porque su
-- techo ya está apartado. Elimina la sobreventa por completo.

create table allan.dispositivo (
  id             uuid primary key default gen_random_uuid(),
  etiqueta       text not null,
  vendedor_id    uuid references allan.vendedor(id),
  ultimo_visto   timestamptz,
  version_app    text,
  activo         boolean not null default true,
  creado_en      timestamptz not null default now()
);

create table allan.cuota_dispositivo (
  sorteo_id      uuid not null references allan.sorteo(id) on delete cascade,
  dispositivo_id uuid not null references allan.dispositivo(id),
  numero         smallint not null,
  asignado       numeric(14,2) not null,
  consumido      numeric(14,2) not null default 0,

  primary key (sorteo_id, dispositivo_id, numero),
  constraint cuota_numero_rango check (numero between 0 and 99),
  constraint cuota_no_excedida  check (consumido <= asignado)
);

-- --- Tickets y líneas ------------------------------------------------------

create table allan.ticket (
  id             uuid primary key default gen_random_uuid(),
  folio          text not null unique,
  sorteo_id      uuid not null references allan.sorteo(id),
  vendedor_id    uuid not null references allan.vendedor(id),
  canal          allan.canal_ticket not null,
  total          numeric(14,2) not null,
  creado_en      timestamptz not null default now(),
  creado_por     uuid,
  lat            double precision,
  lng            double precision,
  dispositivo_id uuid references allan.dispositivo(id),
  lote_ocr_id    uuid,                     -- FK añadida más abajo (lote_ocr aún no existe)
  anulado_en     timestamptz,
  anulado_por    uuid,
  motivo_anulacion text,

  constraint ticket_total_positivo check (total > 0),
  constraint ticket_anulacion_completa check (
    (anulado_en is null and anulado_por is null)
    or (anulado_en is not null and anulado_por is not null)
  )
);

comment on table allan.ticket is
  'Inmutable. Un ticket no se edita: se anula y se vuelve a emitir, para que la historia siempre reconstruya lo ocurrido.';

create index ticket_sorteo_vendedor on allan.ticket (sorteo_id, vendedor_id);
create index ticket_vendedor_fecha  on allan.ticket (vendedor_id, creado_en desc);
create index ticket_vigentes        on allan.ticket (sorteo_id) where anulado_en is null;

create table allan.linea (
  id                 uuid primary key default gen_random_uuid(),
  ticket_id          uuid not null references allan.ticket(id) on delete cascade,
  numero             smallint not null,
  monto              numeric(14,2) not null,

  -- Parámetros CONGELADOS en el momento de la venta. Son el corazón del
  -- principio §1: cambiar la configuración de un vendedor nunca reescribe
  -- historia porque cada línea lleva consigo lo que se le prometió.
  comision_congelada numeric(6,5) not null,
  factor_congelado   numeric(6,2) not null,

  -- Se escriben en la liquidación, no en la venta.
  gana               boolean not null default false,
  premio             numeric(14,2) not null default 0,

  constraint linea_numero_rango  check (numero between 0 and 99),
  constraint linea_monto_positivo check (monto > 0),
  constraint linea_premio_coherente check (
    (gana = false and premio = 0) or (gana = true and premio > 0)
  )
);

create index linea_ticket on allan.linea (ticket_id);
create index linea_numero on allan.linea (numero);
create index linea_ganadoras on allan.linea (ticket_id) where gana;

-- --- Liquidación -----------------------------------------------------------

create table allan.liquidacion (
  id          uuid primary key default gen_random_uuid(),
  sorteo_id   uuid not null references allan.sorteo(id),
  vendedor_id uuid not null references allan.vendedor(id),
  venta       numeric(14,2) not null,
  comision    numeric(14,2) not null,
  premios     numeric(14,2) not null,
  utilidad    numeric(14,2) not null,
  generada_en timestamptz not null default now(),
  usuario_id  uuid,

  unique (sorteo_id, vendedor_id)
);

-- --- Digitalización asistida por IA ---------------------------------------

create table allan.lote_ocr (
  id               uuid primary key default gen_random_uuid(),
  imagen_path      text not null,          -- objeto en Supabase Storage
  vendedor_id      uuid not null references allan.vendedor(id),
  sorteo_id        uuid not null references allan.sorteo(id),
  total_declarado  numeric(14,2) not null, -- el total al pie de la hoja manuscrita
  confianza_global numeric(4,3),
  estado           allan.estado_lote not null default 'cargado',
  validado_por     uuid,
  validado_en      timestamptz,
  modelo           text,
  tokens_entrada   integer,
  tokens_salida    integer,
  costo_inferencia numeric(10,6),          -- USD, para vigilar el gasto del mes
  creado_en        timestamptz not null default now()
);

comment on column allan.lote_ocr.total_declarado is
  'Control de cuadre: es el único mecanismo que detecta un renglón omitido por el modelo. Sin coincidencia exacta no se crean tickets.';

alter table allan.ticket
  add constraint ticket_lote_ocr_fk
  foreign key (lote_ocr_id) references allan.lote_ocr(id);

-- --- Auditoría (append-only) ----------------------------------------------

create table allan.auditoria (
  id             bigserial primary key,
  entidad        text not null,
  entidad_id     uuid,
  campo          text,
  valor_anterior text,
  valor_nuevo    text,
  accion         text not null,
  usuario_id     uuid,
  ip             inet,
  ocurrido_en    timestamptz not null default now()
);

create index auditoria_entidad on allan.auditoria (entidad, entidad_id, ocurrido_en desc);
create index auditoria_fecha   on allan.auditoria (ocurrido_en desc);

-- --- Perfiles de usuario ---------------------------------------------------

create table allan.usuario_perfil (
  id          uuid primary key references auth.users(id) on delete cascade,
  rol         allan.rol_usuario not null,
  vendedor_id uuid references allan.vendedor(id),
  nombre      text not null,
  creado_en   timestamptz not null default now(),

  -- Un usuario con rol vendedor tiene que estar enlazado a un vendedor; los
  -- demás roles no deben estarlo.
  constraint perfil_vendedor_enlazado check (
    (rol = 'vendedor' and vendedor_id is not null)
    or (rol <> 'vendedor' and vendedor_id is null)
  )
);

-- --- Escenarios del simulador (Fase 4, opcional) --------------------------

create table allan.escenario (
  id            uuid primary key default gen_random_uuid(),
  nombre        text not null,
  desde         date not null,
  hasta         date not null,
  comision      numeric(6,5) not null,
  factor_pago   numeric(6,2) not null,
  creado_por    uuid,
  creado_en     timestamptz not null default now()
);
