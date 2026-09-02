-- ===========================================================================
-- Lotería El Diario — todas las migraciones concatenadas, en orden.
--
-- Para una instalación DESDE CERO. Si el esquema ya está aplicado, aplica
-- sólo las migraciones nuevas de migrations/.
--
-- ESTE ARCHIVO SE GENERA. La fuente de verdad es migrations/: al añadir una
-- migración hay que volver a concatenar, o este archivo se queda atrás y una
-- instalación nueva nace con un esquema viejo. Ya pasó una vez — llegó a
-- quedarse detenido en la 0012 mientras migrations/ iba por la 0029.
-- ===========================================================================


-- >>>>>>>>>>>>>>>>>>>>  migrations/0001_esquema_allan.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0002_funciones.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Funciones transaccionales
--
-- Todo lo que escribe pasa por aquí. El cliente NUNCA hace INSERT directo
-- sobre ticket, linea, cupo_numero ni sorteo.
--
-- Orden de bloqueo, respetado por todas las funciones para evitar interbloqueos:
--     sorteo  →  vendedor  →  cupo_numero (por número, ASCENDENTE)
--
-- Todas son SECURITY DEFINER con `search_path` fijado: si no se fija, un
-- usuario podría anteponer un esquema propio y secuestrar la resolución de
-- nombres dentro de la función.
-- ===========================================================================

-- --- Auditoría -------------------------------------------------------------

create or replace function allan.fn_auditar(
  p_entidad        text,
  p_entidad_id     uuid,
  p_accion         text,
  p_campo          text default null,
  p_valor_anterior text default null,
  p_valor_nuevo    text default null
) returns void
language sql
security definer
set search_path = allan, public
as $$
  insert into allan.auditoria (
    entidad, entidad_id, accion, campo, valor_anterior, valor_nuevo, usuario_id
  ) values (
    p_entidad, p_entidad_id, p_accion, p_campo, p_valor_anterior, p_valor_nuevo, auth.uid()
  );
$$;

-- --- Rol del usuario actual ------------------------------------------------

create or replace function allan.fn_rol_actual()
returns allan.rol_usuario
language sql
stable
security definer
set search_path = allan, public
as $$
  select rol from allan.usuario_perfil where id = auth.uid();
$$;

create or replace function allan.fn_vendedor_actual()
returns uuid
language sql
stable
security definer
set search_path = allan, public
as $$
  select vendedor_id from allan.usuario_perfil where id = auth.uid();
$$;

-- --- Abrir un sorteo y sembrar su cupo ------------------------------------
-- Siembra las 100 filas de cupo_numero. `p_limite_por_numero` es el límite
-- global de la casa PARA ESTA FRANJA: se pasa distinto para 11:00, 15:00 y
-- 20:00, que es la decisión tomada en §13.

create or replace function allan.fn_abrir_sorteo(
  p_sorteo_id          uuid,
  p_limite_por_numero  numeric
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado is null then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'programado' then
    raise exception 'Sólo se puede abrir un sorteo programado; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
  select p_sorteo_id, n, p_limite_por_numero, 0
  from generate_series(0, 99) as n
  on conflict (sorteo_id, numero) do nothing;

  update allan.sorteo set estado = 'abierto' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'abrir', 'estado',
                           v_estado::text, 'abierto');
end;
$$;

-- --- Cerrar la venta -------------------------------------------------------

create or replace function allan.fn_cerrar_sorteo(p_sorteo_id uuid)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se puede cerrar un sorteo abierto; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.sorteo set estado = 'cerrado' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'cerrar', 'estado', 'abierto', 'cerrado');
end;
$$;

-- --- Registrar un ticket ---------------------------------------------------
-- El corazón del sistema. La verificación del cupo y la inserción ocurren en
-- la MISMA transacción, con la fila de cupo bloqueada. Nunca se consulta antes
-- y se inserta después: eso permitiría sobreventa bajo concurrencia.
--
-- p_lineas: jsonb  [{"numero": 47, "monto": 50}, ...]
--
-- Devuelve el ticket creado. Si algún número no tiene cupo, lanza excepción y
-- la transacción entera se deshace: no se registran tickets a medias.

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (id uuid, folio text, total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado <> 'abierto' then
    raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
      using errcode = 'invalid_parameter_value';
  end if;

  if now() >= v_sorteo.hora_cierre then
    raise exception 'La venta de este sorteo cerró a las %.', v_sorteo.hora_cierre
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V003-20260817-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  insert into allan.ticket (
    folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  )
  returning allan.ticket.id into v_ticket_id;

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

-- --- Reservar cuota para un dispositivo -----------------------------------

create or replace function allan.fn_reservar_cuota(
  p_sorteo_id      uuid,
  p_dispositivo_id uuid,
  p_monto_por_numero numeric
) returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_filas integer;
begin
  insert into allan.cuota_dispositivo (sorteo_id, dispositivo_id, numero, asignado)
  select p_sorteo_id, p_dispositivo_id, c.numero,
         least(p_monto_por_numero, c.limite_casa - c.vendido)
  from allan.cupo_numero c
  where c.sorteo_id = p_sorteo_id
  on conflict (sorteo_id, dispositivo_id, numero) do nothing;

  get diagnostics v_filas = row_count;

  perform allan.fn_auditar('cuota_dispositivo', p_dispositivo_id, 'reservar',
                           'sorteo_id', null, p_sorteo_id::text);
  return v_filas;
end;
$$;

-- --- Liquidar un sorteo ----------------------------------------------------
-- Transacción única: marca las líneas ganadoras, calcula el premio con el
-- factor congelado DE CADA LÍNEA, genera las liquidaciones por vendedor y
-- bloquea el sorteo.
--
-- El premio es `monto * factor_congelado`, sin tope y sin ajustes para cuadrar
-- contra ningún agregado: el agregado se deriva de las líneas, nunca al revés.

create or replace function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (vendedores integer, lineas_ganadoras integer, premios numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado    allan.estado_sorteo;
  v_ganadoras integer;
  v_premios   numeric(14,2);
  v_vendedores integer;
begin
  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE: nadie puede vender ni volver a liquidar mientras esto corre.
  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1. Marcar ganadoras y calcular el premio con el factor de cada línea.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  -- 2. Liquidación por vendedor, agregando desde las líneas.
  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select t.sorteo_id,
         t.vendedor_id,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         auth.uid()
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.sorteo_id, t.vendedor_id;

  get diagnostics v_vendedores = row_count;

  select coalesce(sum(l.premio), 0) into v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  -- 3. Bloquear el sorteo. El CHECK del esquema obliga a que estado,
  --    numero_ganador y liquidado_en viajen juntos.
  update allan.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$$;

-- --- Anular un ticket ------------------------------------------------------
-- Los tickets no se editan: se anulan y se vuelven a emitir. Devuelve el cupo
-- consumido para que el número vuelva a estar disponible.

create or replace function allan.fn_anular_ticket(
  p_ticket_id uuid,
  p_motivo    text
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_ticket allan.ticket%rowtype;
  v_estado allan.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from allan.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = v_ticket.sorteo_id
  for share;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- Devolver el cupo, número por número en orden ascendente.
  for v_linea in
    select numero, sum(monto) as monto
    from allan.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update allan.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update allan.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update allan.ticket
  set anulado_en = now(), anulado_por = auth.uid(), motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform allan.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo);
end;
$$;

-- --- Guardar parámetros de un vendedor -------------------------------------
-- Versionado: cierra la fila vigente e inserta una nueva. Nunca UPDATE en
-- sitio, para que las ventas ya registradas conserven lo que se les prometió.

create or replace function allan.fn_guardar_parametros(
  p_vendedor_id     uuid,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_anterior allan.parametro_vendedor%rowtype;
  v_nuevo_id uuid;
begin
  if p_comision < 0 or p_comision > 0.60 then
    raise exception 'La comisión debe estar entre 0 y 60%%.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_factor_pago < 1 or p_factor_pago > 200 then
    raise exception 'El factor de pago debe estar entre 1 y 200.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_tope_por_numero < 10 then
    raise exception 'El tope por número debe ser al menos L 10.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_anterior
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  for update;

  -- Sin cambios reales: no se versiona por versionar.
  if found
     and v_anterior.comision = p_comision
     and v_anterior.factor_pago = p_factor_pago
     and v_anterior.tope_por_numero = p_tope_por_numero then
    return v_anterior.id;
  end if;

  if found then
    update allan.parametro_vendedor
    set vigente_hasta = now()
    where id = v_anterior.id;
  end if;

  insert into allan.parametro_vendedor (
    vendedor_id, comision, factor_pago, tope_por_numero, creado_por
  ) values (
    p_vendedor_id, p_comision, p_factor_pago, p_tope_por_numero, auth.uid()
  )
  returning id into v_nuevo_id;

  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'comision',
    coalesce(v_anterior.comision::text, '—'), p_comision::text
  );
  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'factor_pago',
    coalesce(v_anterior.factor_pago::text, '—'), p_factor_pago::text
  );
  perform allan.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'actualizar', 'tope_por_numero',
    coalesce(v_anterior.tope_por_numero::text, '—'), p_tope_por_numero::text
  );

  return v_nuevo_id;
end;
$$;

-- --- Cupo disponible (consulta, NO autoritativa) --------------------------
-- Lo que la interfaz muestra al teclear el número. Es un dato de conveniencia:
-- la verificación que manda es la de fn_registrar_ticket, dentro de la
-- transacción. Entre esta lectura y el INSERT el saldo puede haber cambiado.

create or replace function allan.fn_cupo_disponible(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_numero      smallint
) returns numeric
language sql
stable
security definer
set search_path = allan, public
as $$
  select greatest(
    least(
      -- disponible de la casa
      (select c.limite_casa - c.vendido
       from allan.cupo_numero c
       where c.sorteo_id = p_sorteo_id and c.numero = p_numero),
      -- disponible del vendedor
      (select p.tope_por_numero
       from allan.parametro_vendedor p
       where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null)
      - coalesce((
          select sum(l.monto)
          from allan.linea l
          join allan.ticket t on t.id = l.ticket_id
          where t.sorteo_id = p_sorteo_id
            and t.vendedor_id = p_vendedor_id
            and t.anulado_en is null
            and l.numero = p_numero
        ), 0)
    ),
    0
  );
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0003_rls_y_permisos.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0004_correcciones_funciones.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Corrección: colisión de nombres entre las columnas de salida y las columnas
-- de las tablas dentro de las funciones plpgsql.
--
-- `returns table (id uuid, folio text, total numeric)` declara variables OUT
-- llamadas id/folio/total. A partir de ahí, dentro del cuerpo, cualquier
-- `where id = ...` o `returning ... into ...` es ambiguo: PostgreSQL no sabe si
-- «id» es la columna de la tabla o la variable de salida, y aborta con
-- 42702 «column reference "id" is ambiguous».
--
-- Se corrige de dos formas complementarias:
--   1. Los nombres de salida llevan prefijo y ya no coinciden con ninguna
--      columna (`ticket_id`, `total_premios`, …).
--   2. El id del ticket se genera explícitamente en vez de recuperarlo con
--      RETURNING, que era el punto exacto del choque.
--
-- Cambia el tipo de retorno, así que hay que soltar la función antes de
-- recrearla: CREATE OR REPLACE no puede alterar la firma de salida.
-- ===========================================================================

drop function if exists allan.fn_registrar_ticket(
  uuid, uuid, jsonb, double precision, double precision, uuid, allan.canal_ticket, uuid
);

create function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado <> 'abierto' then
    raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
      using errcode = 'invalid_parameter_value';
  end if;

  if now() >= v_sorteo.hora_cierre then
    raise exception 'La venta de este sorteo cerró a las %.', v_sorteo.hora_cierre
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V901-20990101-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  -- El id se genera aquí en vez de recuperarlo con RETURNING: así no hay
  -- ninguna referencia a la columna `id` dentro del cuerpo de la función.
  v_ticket_id := gen_random_uuid();

  insert into allan.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  );

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

-- --- Liquidación: mismo endurecimiento en los nombres de salida -----------
-- `premios` coincidía con la columna de allan.liquidacion.

drop function if exists allan.fn_liquidar_sorteo(uuid, smallint);

create function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (
  total_vendedores       integer,
  total_lineas_ganadoras integer,
  total_premios          numeric
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado     allan.estado_sorteo;
  v_ganadoras  integer;
  v_premios    numeric(14,2);
  v_vendedores integer;
begin
  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE: nadie puede vender ni volver a liquidar mientras esto corre.
  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1. Marcar ganadoras y calcular el premio con el factor de cada línea.
  --    Sin tope y sin ajustes para cuadrar contra ningún agregado.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  -- 2. Liquidación por vendedor, agregando desde las líneas.
  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select t.sorteo_id,
         t.vendedor_id,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         auth.uid()
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.sorteo_id, t.vendedor_id;

  get diagnostics v_vendedores = row_count;

  select coalesce(sum(l.premio), 0) into v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  -- 3. Bloquear el sorteo.
  update allan.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0005_autorizacion_y_altas.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Autorización dentro de las funciones + altas de vendedor y de sorteos.
--
-- HUECO QUE CIERRA ESTA MIGRACIÓN
-- -------------------------------
-- Las funciones de 0002/0004 son SECURITY DEFINER y tienen EXECUTE concedido a
-- `authenticated`. SECURITY DEFINER significa que corren con los permisos del
-- dueño y por tanto SE SALTAN RLS — que era justo la intención para poder
-- escribir en tablas sin políticas de escritura.
--
-- El problema es que ninguna comprobaba QUIÉN llamaba. Con sólo estar
-- autenticado, un vendedor podía llamar a fn_guardar_parametros y subirse la
-- comisión, liquidar un sorteo, o insertar filas inventadas en auditoría.
-- RLS no lo impedía porque estas funciones existen precisamente para eludirlo.
--
-- La corrección es comprobar el rol DENTRO de cada función. Se recrean con el
-- cuerpo íntegro (la firma no cambia, así que basta CREATE OR REPLACE) y una
-- guarda al principio.
-- ===========================================================================

-- --- Guardas ---------------------------------------------------------------

-- ¿La llamada viene con la llave de servicio? Los scripts de operación y el
-- cron entran por ahí y no tienen perfil en usuario_perfil.
--
-- Se mira el CLAIM del JWT, no `current_user`, y la diferencia importa: dentro
-- de una función SECURITY DEFINER `current_user` es el dueño de la función
-- (postgres), no quien llamó. Usarlo haría que fn_guardar_parametros negara el
-- paso al propio service_role en cuanto se la invoca desde otra función.
-- `request.jwt.claims` es un ajuste de la transacción y sí sobrevive al salto.
create or replace function allan.fn_es_servicio()
returns boolean
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
    ''
  ) = 'service_role';
$$;

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

-- La auditoría es append-only y la escriben las demás funciones. Que un
-- cliente pueda llamarla directamente permitiría fabricar historia.
revoke execute on function allan.fn_auditar(text, uuid, text, text, text, text)
  from authenticated;

-- --- Guardas sobre las funciones existentes -------------------------------

create or replace function allan.fn_abrir_sorteo(
  p_sorteo_id          uuid,
  p_limite_por_numero  numeric
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado is null then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'programado' then
    raise exception 'Sólo se puede abrir un sorteo programado; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
  select p_sorteo_id, n, p_limite_por_numero, 0
  from generate_series(0, 99) as n
  on conflict (sorteo_id, numero) do nothing;

  update allan.sorteo set estado = 'abierto' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'abrir', 'estado', v_estado::text, 'abierto');
end;
$$;

create or replace function allan.fn_cerrar_sorteo(p_sorteo_id uuid)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado allan.estado_sorteo;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se puede cerrar un sorteo abierto; éste está en estado %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.sorteo set estado = 'cerrado' where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'cerrar', 'estado', 'abierto', 'cerrado');
end;
$$;

create or replace function allan.fn_guardar_parametros(
  p_vendedor_id     uuid,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_anterior allan.parametro_vendedor%rowtype;
  v_nuevo_id uuid;
begin
  -- Sin esta guarda, un vendedor podía cambiarse su propia comisión.
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_comision < 0 or p_comision > 0.60 then
    raise exception 'La comisión debe estar entre 0 y 60%%.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_factor_pago < 1 or p_factor_pago > 200 then
    raise exception 'El factor de pago debe estar entre 1 y 200.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_tope_por_numero < 10 then
    raise exception 'El tope por número debe ser al menos L 10.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_anterior
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  for update;

  if found
     and v_anterior.comision = p_comision
     and v_anterior.factor_pago = p_factor_pago
     and v_anterior.tope_por_numero = p_tope_por_numero then
    return v_anterior.id;
  end if;

  if found then
    update allan.parametro_vendedor
    set vigente_hasta = now()
    where id = v_anterior.id;
  end if;

  insert into allan.parametro_vendedor (
    vendedor_id, comision, factor_pago, tope_por_numero, creado_por
  ) values (
    p_vendedor_id, p_comision, p_factor_pago, p_tope_por_numero, auth.uid()
  )
  returning id into v_nuevo_id;

  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'comision',
    coalesce(v_anterior.comision::text, '—'), p_comision::text);
  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'factor_pago',
    coalesce(v_anterior.factor_pago::text, '—'), p_factor_pago::text);
  perform allan.fn_auditar('parametro_vendedor', p_vendedor_id, 'actualizar', 'tope_por_numero',
    coalesce(v_anterior.tope_por_numero::text, '—'), p_tope_por_numero::text);

  return v_nuevo_id;
end;
$$;

create or replace function allan.fn_reservar_cuota(
  p_sorteo_id        uuid,
  p_dispositivo_id   uuid,
  p_monto_por_numero numeric
) returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_filas integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  insert into allan.cuota_dispositivo (sorteo_id, dispositivo_id, numero, asignado)
  select p_sorteo_id, p_dispositivo_id, c.numero,
         least(p_monto_por_numero, c.limite_casa - c.vendido)
  from allan.cupo_numero c
  where c.sorteo_id = p_sorteo_id
  on conflict (sorteo_id, dispositivo_id, numero) do nothing;

  get diagnostics v_filas = row_count;

  perform allan.fn_auditar('cuota_dispositivo', p_dispositivo_id, 'reservar',
                           'sorteo_id', null, p_sorteo_id::text);
  return v_filas;
end;
$$;

create or replace function allan.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (
  total_vendedores       integer,
  total_lineas_ganadoras integer,
  total_premios          numeric
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_estado     allan.estado_sorteo;
  v_ganadoras  integer;
  v_premios    numeric(14,2);
  v_vendedores integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador;

  get diagnostics v_ganadoras = row_count;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select t.sorteo_id,
         t.vendedor_id,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         auth.uid()
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.sorteo_id, t.vendedor_id;

  get diagnostics v_vendedores = row_count;

  select coalesce(sum(l.premio), 0) into v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  update allan.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$$;

create or replace function allan.fn_anular_ticket(
  p_ticket_id uuid,
  p_motivo    text
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_ticket allan.ticket%rowtype;
  v_estado allan.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from allan.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  -- Un vendedor sólo puede anular lo suyo; administración, cualquiera.
  if not allan.fn_es_servicio()
     and allan.fn_rol_actual() is distinct from 'administrador'
     and v_ticket.vendedor_id is distinct from allan.fn_vendedor_actual() then
    raise exception 'No tiene permiso para anular este ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from allan.sorteo where id = v_ticket.sorteo_id
  for share;

  if v_estado <> 'abierto' then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  for v_linea in
    select numero, sum(monto) as monto
    from allan.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update allan.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update allan.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update allan.ticket
  set anulado_en = now(), anulado_por = auth.uid(), motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform allan.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo);
end;
$$;

-- --- Alta de vendedor ------------------------------------------------------
-- El código se genera DENTRO de la transacción, con la tabla bloqueada, para
-- que dos altas simultáneas no produzcan dos V-006.

create or replace function allan.fn_crear_vendedor(
  p_nombre          text,
  p_telefono        text,
  p_correo          text,
  p_identidad       text,
  p_ciudad          text,
  p_barrio          text,
  p_lat             double precision,
  p_lng             double precision,
  p_color           text,
  p_comision        numeric,
  p_factor_pago     numeric,
  p_tope_por_numero numeric
) returns table (vendedor_id uuid, vendedor_codigo text)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_id        uuid;
  v_siguiente integer;
  v_codigo    text;
  v_barrio    text := nullif(btrim(p_barrio), '');
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if length(btrim(p_nombre)) < 5 then
    raise exception 'Escriba el nombre completo del vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  if btrim(p_telefono) !~ '^\d{4}-\d{4}$' then
    raise exception 'Teléfono en formato 9999-9999.'
      using errcode = 'invalid_parameter_value';
  end if;

  if btrim(p_correo) !~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
    raise exception 'Correo electrónico no válido.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serializa la generación del código entre altas concurrentes.
  lock table allan.vendedor in share row exclusive mode;

  select coalesce(max(substring(codigo from 3)::integer), 0) + 1
  into v_siguiente
  from allan.vendedor;

  v_codigo := 'V-' || lpad(v_siguiente::text, 3, '0');
  v_id := gen_random_uuid();

  insert into allan.vendedor (
    id, codigo, nombre, identidad, telefono, correo, ciudad, barrio, zona, color, lat, lng
  ) values (
    v_id, v_codigo, btrim(p_nombre), nullif(btrim(p_identidad), ''), btrim(p_telefono),
    btrim(p_correo), p_ciudad, v_barrio,
    p_ciudad || ' · ' || coalesce(v_barrio, 'sin barrio asignado'),
    p_color, p_lat, p_lng
  );

  -- Sin parámetros vigentes el vendedor no puede vender: fn_registrar_ticket
  -- los exige para congelarlos en cada línea. Van en la misma transacción.
  perform allan.fn_guardar_parametros(v_id, p_comision, p_factor_pago, p_tope_por_numero);

  perform allan.fn_auditar('vendedor', v_id, 'crear', 'codigo', null, v_codigo);

  return query select v_id, v_codigo;
end;
$$;

-- --- Programación del día --------------------------------------------------
-- Crea los tres sorteos de una fecha. La venta cierra 10 minutos antes de cada
-- sorteo, que es la convención del prototipo (20:00 cierra 19:50).

create or replace function allan.fn_programar_dia(p_fecha date)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_hora   allan.hora_sorteo;
  v_time   time;
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

    v_creados := v_creados + 1;
  end loop;

  perform allan.fn_auditar('sorteo', null, 'programar_dia', 'fecha', null, p_fecha::text);
  return v_creados;
end;
$$;

-- --- Registro de ticket: quién puede vender a nombre de quién --------------
-- Se recrea con el cuerpo íntegro (CREATE OR REPLACE exige el cuerpo completo)
-- para anteponerle la guarda de rol.

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- Un vendedor sólo registra ventas a su propio nombre. Administración y
  -- digitación pueden hacerlo por cualquiera (la digitalización crea tickets
  -- de la hoja de otro vendedor).
  if not allan.fn_es_servicio() then
    if allan.fn_rol_actual() = 'vendedor'
       and p_vendedor_id is distinct from allan.fn_vendedor_actual() then
      raise exception 'No puede registrar ventas a nombre de otro vendedor.'
        using errcode = 'insufficient_privilege';
    end if;
    perform allan.fn_exige(array['vendedor','digitador','administrador']::allan.rol_usuario[]);
  end if;

  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado <> 'abierto' then
    raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
      using errcode = 'invalid_parameter_value';
  end if;

  if now() >= v_sorteo.hora_cierre then
    raise exception 'La venta de este sorteo cerró a las %.', v_sorteo.hora_cierre
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V901-20990101-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  -- El id se genera aquí en vez de recuperarlo con RETURNING: así no hay
  -- ninguna referencia a la columna `id` dentro del cuerpo de la función.
  v_ticket_id := gen_random_uuid();

  insert into allan.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  );

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0006_revocar_public.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Cierre del EXECUTE implícito a PUBLIC.
--
-- PostgreSQL concede EXECUTE a PUBLIC en TODA función recién creada. Como
-- `anon` y `authenticated` son miembros de PUBLIC, el
--
--     revoke execute on function allan.fn_auditar(...) from authenticated;
--
-- de 0005 no servía de nada: la función seguía siendo llamable, porque el
-- permiso no venía del rol sino de PUBLIC. Verificado con una sesión de rol
-- vendedor, que consiguió insertar una fila de auditoría inventada.
--
-- La corrección es quitar el permiso de PUBLIC — de todo el esquema, no sólo
-- de fn_auditar — y dejar únicamente las concesiones explícitas de 0003.
-- ===========================================================================

-- 1. Fuera el permiso implícito de todas las funciones existentes.
revoke execute on all functions in schema allan from public;
revoke execute on all routines in schema allan from public;

-- `anon` no debe poder ejecutar nada: su única superficie es la vista pública
-- de resultados, que es una vista, no una función.
revoke execute on all functions in schema allan from anon;
revoke execute on all routines in schema allan from anon;

-- 2. Y de las que se creen en el futuro, para que esto no se repita al añadir
--    una función nueva.
alter default privileges for role postgres in schema allan
  revoke execute on routines from public;

-- 3. La auditoría es append-only y la escriben las demás funciones, que al ser
--    SECURITY DEFINER corren como su dueño y no necesitan este permiso. Ningún
--    cliente debe poder llamarla: sería poder fabricar historia.
revoke execute on function allan.fn_auditar(text, uuid, text, text, text, text)
  from authenticated;

-- 4. Las guardas tampoco tienen por qué ser invocables desde fuera.
revoke execute on function allan.fn_exige(allan.rol_usuario[]) from authenticated;
revoke execute on function allan.fn_es_servicio() from authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0007_impacto_sorteo.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Impacto económico de un sorteo.
--
-- Sirve a la pantalla de captura del número ganador: antes de liquidar hay que
-- poder ver cuánto se pagaría con ese número. Se agrega en el servidor porque
-- traer todas las líneas del sorteo al navegador para sumarlas no escala, y
-- porque el cálculo debe salir de un único sitio: si el tablero y esta
-- pantalla sumaran por su cuenta, acabarían discrepando.
--
-- Ambas funciones son de LECTURA. No mutan nada y no liquidan: la liquidación
-- sigue siendo fn_liquidar_sorteo.
-- ===========================================================================

-- --- Impacto de un número candidato ---------------------------------------
-- Con `p_numero` nulo devuelve sólo venta, comisión y tickets — que es el
-- resumen de cabecera del sorteo, sin premios, porque un sorteo no liquidado
-- no tiene premios sino proyecciones.

create or replace function allan.fn_impacto_numero(
  p_sorteo_id uuid,
  p_numero    smallint default null
) returns table (
  venta            numeric,
  comision         numeric,
  tickets          integer,
  lineas_ganadoras integer,
  pago             numeric,
  utilidad         numeric
)
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_venta    numeric(14,2) := 0;
  v_comision numeric(14,2) := 0;
  v_tickets  integer := 0;
  v_ganan    integer := 0;
  v_pago     numeric(14,2) := 0;
begin
  perform allan.fn_exige(array['administrador', 'auditor']::allan.rol_usuario[]);

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         count(distinct t.id)
  into v_venta, v_comision, v_tickets
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null;

  if p_numero is not null then
    -- El pago usa el factor congelado DE CADA LÍNEA, no un factor único: dos
    -- líneas del mismo número pueden llevar factores distintos si el vendedor
    -- cambió de parámetros entre una venta y otra.
    select count(*), coalesce(sum(l.monto * l.factor_congelado), 0)
    into v_ganan, v_pago
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
      and l.numero = p_numero;
  end if;

  return query
    select v_venta, v_comision, v_tickets, v_ganan, v_pago,
           v_venta - v_comision - v_pago;
end;
$$;

-- --- Peor escenario --------------------------------------------------------
-- El número que más costaría si saliera. Es la regla de §5:
--     peor escenario = venta − comisión − máx(premio potencial de cada número)
-- Sirve para vigilar la exposición mientras el sorteo sigue abierto.

create or replace function allan.fn_peor_escenario(p_sorteo_id uuid)
returns table (
  numero        smallint,
  pago          numeric,
  utilidad_peor numeric
)
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_venta    numeric(14,2) := 0;
  v_comision numeric(14,2) := 0;
begin
  perform allan.fn_exige(array['administrador', 'auditor']::allan.rol_usuario[]);

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0)
  into v_venta, v_comision
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  return query
    select p.numero,
           p.pago,
           v_venta - v_comision - p.pago
    from (
      select l.numero as numero,
             sum(l.monto * l.factor_congelado) as pago
      from allan.linea l
      join allan.ticket t on t.id = l.ticket_id
      where t.sorteo_id = p_sorteo_id and t.anulado_en is null
      group by l.numero
      order by 2 desc
      limit 1
    ) p;
end;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0008_agregados.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Agregados analíticos.
--
-- POR QUÉ NO SON VISTAS MATERIALIZADAS
-- ------------------------------------
-- El plan contemplaba materializar. Con los volúmenes reales del negocio
-- —5 vendedores, 3 sorteos diarios, del orden de 90 000 líneas por año— la
-- agregación en vivo es inmediata para PostgreSQL, y materializar traería
-- maquinaria de refresco y ventanas de desfase. Un tablero que enseña cifras
-- de hace cinco minutos mientras el reporte enseña las de ahora es exactamente
-- la contradicción que el §2 prohíbe.
--
-- Se agrega en vivo desde `linea`, que es la unidad atómica. Si algún día los
-- volúmenes lo piden, materializar es un cambio local a este archivo: las
-- pantallas no saben de dónde salen los números.
--
-- LIQUIDADO Y PENDIENTE VAN SEPARADOS
-- -----------------------------------
-- Mientras un sorteo no esté liquidado, sus premios y su utilidad son
-- proyección (§5). Estas funciones nunca los suman con los definitivos: los
-- devuelven en campos aparte para que la interfaz los rotule como lo que son.
-- ===========================================================================

-- --- Vista base ------------------------------------------------------------
-- Una fila por (sorteo, vendedor). `security_invoker` hace que respete RLS:
-- un vendedor sólo ve las suyas, administración las ve todas.

create or replace view allan.v_agregado_sorteo_vendedor
with (security_invoker = true) as
  select s.id            as sorteo_id,
         s.fecha,
         s.hora,
         s.estado,
         s.numero_ganador,
         t.vendedor_id,
         count(distinct t.id)                        as tickets,
         sum(l.monto)                                as venta,
         sum(l.monto * l.comision_congelada)         as comision,
         sum(l.premio)                               as premios,
         sum(l.monto)
           - sum(l.monto * l.comision_congelada)
           - sum(l.premio)                           as utilidad
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.anulado_en is null
  group by s.id, s.fecha, s.hora, s.estado, s.numero_ganador, t.vendedor_id;

comment on view allan.v_agregado_sorteo_vendedor is
  'Todo indicador del sistema sale de aquí, y esto sale de las líneas. Ningún total se captura a mano.';

grant select on allan.v_agregado_sorteo_vendedor to authenticated;

-- Índices que sostienen la agregación.
create index if not exists linea_ticket_numero on allan.linea (ticket_id, numero);
create index if not exists ticket_sorteo_vigente on allan.ticket (sorteo_id) where anulado_en is null;

-- --- Totales de un rango ---------------------------------------------------

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select
    coalesce(sum(a.venta), 0),
    coalesce(sum(a.comision), 0),
    coalesce(sum(a.tickets), 0)::integer,
    coalesce(sum(a.venta)    filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
    coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0),
    coalesce(count(distinct a.sorteo_id) filter (where a.estado =  'liquidado'), 0)::integer,
    coalesce(count(distinct a.sorteo_id) filter (where a.estado <> 'liquidado'), 0)::integer
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta;
$$;

-- --- Serie mensual ---------------------------------------------------------
-- Alimenta el gráfico de utilidad mes por mes. La utilidad sólo cuenta sorteos
-- liquidados; `venta_pendiente` permite avisar de que el mes aún no cerró.

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from a.fecha)::integer,
         extract(month from a.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0)
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta
  group by 1, 2
  order by 1, 2;
$$;

-- --- Por vendedor ----------------------------------------------------------

create or replace function allan.fn_resumen_vendedor(
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
set search_path = allan, public
as $$
  select v.id, v.codigo, v.nombre, v.color,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0)
  from allan.vendedor v
  left join allan.v_agregado_sorteo_vendedor a
    on a.vendedor_id = v.id and a.fecha between p_desde and p_hasta
  where v.activo
  group by v.id, v.codigo, v.nombre, v.color
  order by 5 desc;
$$;

-- --- Un día, sorteo por sorteo --------------------------------------------

create or replace function allan.fn_resumen_dia(p_fecha date)
returns table (
  sorteo_id      uuid,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  numero_ganador smallint,
  tickets        integer,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select s.id, s.hora, s.estado, s.numero_ganador,
         coalesce(sum(a.tickets), 0)::integer,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision), 0),
         coalesce(sum(a.premios), 0),
         coalesce(sum(a.utilidad), 0)
  from allan.sorteo s
  left join allan.v_agregado_sorteo_vendedor a on a.sorteo_id = s.id
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

-- --- Un día, desglose por vendedor y sorteo -------------------------------

create or replace function allan.fn_desglose_dia(p_fecha date)
returns table (
  vendedor_id uuid,
  nombre      text,
  hora        allan.hora_sorteo,
  estado      allan.estado_sorteo,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select a.vendedor_id, v.nombre, a.hora, a.estado,
         a.venta, a.comision, a.premios, a.utilidad
  from allan.v_agregado_sorteo_vendedor a
  join allan.vendedor v on v.id = a.vendedor_id
  where a.fecha = p_fecha
  order by v.codigo, a.hora;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0009_reportes.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Reporte filtrable.
--
-- Dos funciones y no una, a propósito: las filas se paginan pero los
-- SUBTOTALES SE CALCULAN SOBRE EL FILTRO COMPLETO. La tabla enseña las
-- primeras 80 filas; el encabezado de subtotales suma las que sean. Mezclarlas
-- en una sola llamada llevaría tarde o temprano a sumar sólo lo visible, que es
-- el error clásico de este tipo de pantalla.
--
-- Ambas corren como el invocador: RLS filtra, así que un vendedor que abra el
-- reporte ve únicamente sus propias filas y unos subtotales coherentes con
-- ellas.
--
-- El filtro por número ganador sólo puede casar con sorteos liquidados — un
-- sorteo sin liquidar no tiene número. Es correcto que los excluya.
-- ===========================================================================

create or replace function allan.fn_reporte_filas(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null,
  p_limite      integer  default 80,
  p_desde_fila  integer  default 0
) returns table (
  fecha          date,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
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
set search_path = allan, public
as $$
  select a.fecha, a.hora, a.estado, a.numero_ganador,
         a.vendedor_id, v.nombre,
         a.venta, a.comision, a.premios, a.utilidad
  from allan.v_agregado_sorteo_vendedor a
  join allan.vendedor v on v.id = a.vendedor_id
  where a.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or a.vendedor_id = p_vendedor_id)
    and (p_hora        is null or a.hora        = p_hora)
    and (p_numero      is null or a.numero_ganador = p_numero)
  -- Fecha descendente pero hora ascendente dentro del día: lo más reciente
  -- arriba, y dentro de la jornada en el orden en que ocurrió.
  order by a.fecha desc, a.hora asc, v.codigo asc
  limit p_limite offset p_desde_fila;
$$;

create or replace function allan.fn_reporte_totales(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null
) returns table (
  registros           integer,
  dias                integer,
  venta               numeric,
  comision            numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  registros_pendientes integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select count(*)::integer,
         count(distinct a.fecha)::integer,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.premios)  filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.utilidad) filter (where a.estado = 'liquidado'), 0),
         coalesce(sum(a.venta)    filter (where a.estado <> 'liquidado'), 0),
         count(*) filter (where a.estado <> 'liquidado')::integer
  from allan.v_agregado_sorteo_vendedor a
  where a.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or a.vendedor_id = p_vendedor_id)
    and (p_hora        is null or a.hora        = p_hora)
    and (p_numero      is null or a.numero_ganador = p_numero);
$$;

-- --- Bitácora de un vendedor ----------------------------------------------
-- La única vista del sistema que baja a la línea individual (§ control de
-- vendedores). Devuelve la hora exacta, el número, el monto y el punto de
-- venta de cada línea.

create or replace function allan.fn_bitacora_vendedor(
  p_vendedor_id uuid,
  p_fecha       date,
  p_hora        allan.hora_sorteo default null
) returns table (
  creado_en      timestamptz,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  folio          text,
  numero         smallint,
  monto          numeric,
  gana           boolean,
  premio         numeric,
  lat            double precision,
  lng            double precision
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.creado_en, s.hora, s.estado, t.folio,
         l.numero, l.monto, l.gana, l.premio, t.lat, t.lng
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha = p_fecha
    and t.anulado_en is null
    and (p_hora is null or s.hora = p_hora)
  order by t.creado_en, l.numero;
$$;

-- --- Actividad por hora del día -------------------------------------------
-- Alimenta las barras de «actividad por hora» del control de vendedores.

create or replace function allan.fn_actividad_horaria(
  p_vendedor_id uuid,
  p_fecha       date
) returns table (
  hora_reloj integer,
  monto      numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(hour from t.creado_en at time zone 'America/Tegucigalpa')::integer,
         sum(l.monto)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha = p_fecha
    and t.anulado_en is null
  group by 1
  order by 1;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0010_digitalizacion.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Digitalización asistida por IA.
--
-- Principio §1: la IA no registra, propone. Nada de lo que devuelve el modelo
-- llega a `linea` sin pasar por dos filtros:
--
--   1. Revisión humana — el operador corrige los renglones dudosos.
--   2. CONTROL DE CUADRE — la suma de los renglones debe coincidir exactamente
--      con el total que el vendedor escribió al pie de la hoja. Es el único
--      mecanismo capaz de detectar un renglón que el modelo omitió: si falta
--      una apuesta, la suma no da y la confirmación queda bloqueada.
--
-- Y una vez superados, los tickets se crean llamando a fn_registrar_ticket —
-- la misma función que usa la venta móvil. La validación de cupo no se
-- reimplementa aquí: un ticket digitalizado está sujeto exactamente a los
-- mismos topes que uno vendido en la calle.
-- ===========================================================================

create or replace function allan.fn_crear_lote_ocr(
  p_imagen_path      text,
  p_vendedor_id      uuid,
  p_sorteo_id        uuid,
  p_total_declarado  numeric,
  p_confianza_global numeric,
  p_modelo           text,
  p_tokens_entrada   integer,
  p_tokens_salida    integer,
  p_costo            numeric
) returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_id uuid;
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  insert into allan.lote_ocr (
    imagen_path, vendedor_id, sorteo_id, total_declarado, confianza_global,
    estado, modelo, tokens_entrada, tokens_salida, costo_inferencia
  ) values (
    p_imagen_path, p_vendedor_id, p_sorteo_id, p_total_declarado, p_confianza_global,
    'extraido', p_modelo, p_tokens_entrada, p_tokens_salida, p_costo
  )
  returning id into v_id;

  perform allan.fn_auditar('lote_ocr', v_id, 'extraer', 'costo_inferencia',
                           null, p_costo::text);
  return v_id;
end;
$$;

-- --- Validación y creación de tickets -------------------------------------
-- p_lineas: [{"numero": 7, "monto": 50}, ...] ya corregidas por el operador.

create or replace function allan.fn_validar_lote_ocr(
  p_lote_id uuid,
  p_lineas  jsonb
) returns table (ticket_id uuid, ticket_folio text, lineas integer)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_lote    allan.lote_ocr%rowtype;
  v_suma    numeric(14,2);
  v_ticket  record;
  v_n       integer;
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  select * into v_lote
  from allan.lote_ocr where id = p_lote_id
  for update;

  if not found then
    raise exception 'El lote % no existe.', p_lote_id
      using errcode = 'no_data_found';
  end if;

  if v_lote.estado = 'validado' then
    raise exception 'Este lote ya fue validado; sus tickets están creados.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El lote no tiene renglones.'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(sum((l->>'monto')::numeric), 0) into v_suma
  from jsonb_array_elements(p_lineas) as l;

  -- El control de cuadre. Sin coincidencia exacta no se crea nada: la
  -- diferencia casi siempre significa un renglón que el modelo no vio.
  if v_suma <> v_lote.total_declarado then
    raise exception 'Descuadre: los renglones suman % y la hoja declara %. Diferencia de %.',
      v_suma, v_lote.total_declarado, v_suma - v_lote.total_declarado
      using errcode = 'check_violation';
  end if;

  -- Los tickets se crean por la misma puerta que una venta móvil, con sus
  -- mismos topes de cupo y su mismo congelamiento de parámetros.
  select * into v_ticket
  from allan.fn_registrar_ticket(
    v_lote.sorteo_id,
    v_lote.vendedor_id,
    p_lineas,
    null, null, null,
    'ocr'::allan.canal_ticket,
    p_lote_id
  );

  select jsonb_array_length(p_lineas) into v_n;

  update allan.lote_ocr
  set estado = 'validado', validado_por = auth.uid(), validado_en = now()
  where id = p_lote_id;

  perform allan.fn_auditar('lote_ocr', p_lote_id, 'validar', 'folio',
                           null, v_ticket.ticket_folio);

  return query select v_ticket.ticket_id, v_ticket.ticket_folio, v_n;
end;
$$;

-- --- Rechazo ---------------------------------------------------------------

create or replace function allan.fn_rechazar_lote_ocr(
  p_lote_id uuid,
  p_motivo  text
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
begin
  perform allan.fn_exige(array['digitador', 'administrador']::allan.rol_usuario[]);

  update allan.lote_ocr
  set estado = 'rechazado', validado_por = auth.uid(), validado_en = now()
  where id = p_lote_id and estado <> 'validado';

  if not found then
    raise exception 'El lote no existe o ya fue validado.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform allan.fn_auditar('lote_ocr', p_lote_id, 'rechazar', 'motivo', null, p_motivo);
end;
$$;

-- --- Gasto de inferencia ---------------------------------------------------
-- §8 pide vigilar tanto la calidad como el gasto. Esto alimenta la tarjeta de
-- «gasto del mes» de la pantalla.

create or replace function allan.fn_gasto_ocr(
  p_desde date,
  p_hasta date
) returns table (
  lotes             integer,
  imagenes_validadas integer,
  costo_total       numeric,
  confianza_media   numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select count(*)::integer,
         count(*) filter (where estado = 'validado')::integer,
         coalesce(sum(costo_inferencia), 0),
         coalesce(avg(confianza_global), 0)
  from allan.lote_ocr
  where creado_en::date between p_desde and p_hasta;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0011_hora_honduras_y_simulador.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Hora de Honduras en los mensajes, y el simulador de escenarios.
--
-- EL HUSO NO ES COSMÉTICO
-- ------------------------
-- Los timestamptz se guardan en UTC, que es lo correcto. Pero al MOSTRARLOS
-- hay que convertirlos: el mensaje decía «cerró a las 20:50» cuando en
-- Honduras fueron las 14:50. A un vendedor al que se le rechaza una venta con
-- una hora que no reconoce no le queda forma de saber si se equivocó él o el
-- sistema.
--
-- La conversión va explícita a America/Tegucigalpa (UTC−6 todo el año, sin
-- horario de verano) y no al huso del servidor, que en producción es UTC.
-- ===========================================================================

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- Un vendedor sólo registra ventas a su propio nombre. Administración y
  -- digitación pueden hacerlo por cualquiera (la digitalización crea tickets
  -- de la hoja de otro vendedor).
  if not allan.fn_es_servicio() then
    if allan.fn_rol_actual() = 'vendedor'
       and p_vendedor_id is distinct from allan.fn_vendedor_actual() then
      raise exception 'No puede registrar ventas a nombre de otro vendedor.'
        using errcode = 'insufficient_privilege';
    end if;
    perform allan.fn_exige(array['vendedor','digitador','administrador']::allan.rol_usuario[]);
  end if;

  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_sorteo.estado <> 'abierto' then
    raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
      using errcode = 'invalid_parameter_value';
  end if;

  if now() >= v_sorteo.hora_cierre then
    raise exception 'La venta de este sorteo cerró a las % (hora de Honduras).',
      to_char(v_sorteo.hora_cierre at time zone 'America/Tegucigalpa', 'HH24:MI')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V901-20990101-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  -- El id se genera aquí en vez de recuperarlo con RETURNING: así no hay
  -- ninguna referencia a la columna `id` dentro del cuerpo de la función.
  v_ticket_id := gen_random_uuid();

  insert into allan.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total, auth.uid(),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id
  );

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

-- ===========================================================================
-- Simulador de escenarios (Fase 4)
--
-- Recorre las líneas históricas y las recalcula con una comisión y un factor
-- alternos, mes por mes.
--
-- POR QUÉ ES EXACTO Y NO UNA APROXIMACIÓN
-- ---------------------------------------
-- El prototipo reescalaba los premios con una regla de tres sobre el factor
-- promedio ponderado del rango, porque sólo tenía agregados. Aquí tenemos las
-- líneas: el premio simulado es la suma de los montos GANADORES multiplicada
-- por el factor alterno. Sin promedios y sin error de aproximación.
--
-- SU SUPUESTO, QUE NO ES PEQUEÑO
-- ------------------------------
-- Se asume que el volumen de venta no cambia. Es una referencia cuantitativa
-- de qué habría pasado con otros parámetros sobre las mismas apuestas, no un
-- pronóstico: en la realidad, cambiar la comisión cambia el comportamiento de
-- los vendedores, y cambiar el factor cambia el de los apostadores.
--
-- Sólo entran sorteos LIQUIDADOS. Uno sin liquidar no tiene número ganador, y
-- sin él no hay premio que recalcular.
-- ===========================================================================

create or replace function allan.fn_simular(
  p_desde    date,
  p_hasta    date,
  p_comision numeric,   -- fracción: 0.13 para 13 %
  p_factor   numeric
) returns table (
  anio           integer,
  mes            integer,
  dias           integer,
  venta          numeric,
  comision_real  numeric,
  premios_real   numeric,
  utilidad_real  numeric,
  comision_sim   numeric,
  premios_sim    numeric,
  utilidad_sim   numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from s.fecha)::integer,
         extract(month from s.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         count(distinct s.fecha)::integer,
         sum(l.monto),
         sum(l.monto * l.comision_congelada),
         sum(l.premio),
         sum(l.monto) - sum(l.monto * l.comision_congelada) - sum(l.premio),
         -- Comisión alterna sobre la misma venta.
         sum(l.monto) * p_comision,
         -- Premio alterno: los mismos aciertos, con otro factor.
         sum(l.monto) filter (where l.gana) * p_factor,
         sum(l.monto)
           - sum(l.monto) * p_comision
           - coalesce(sum(l.monto) filter (where l.gana), 0) * p_factor
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and s.estado = 'liquidado'
    and t.anulado_en is null
  group by 1, 2
  order by 1, 2;
$$;

-- --- Los parámetros reales del rango, ponderados por venta -----------------
-- Es la referencia contra la que se compara el escenario: no sirve el promedio
-- simple de los vendedores, porque uno que vende poco no debe pesar igual que
-- uno que vende mucho.

create or replace function allan.fn_parametros_ponderados(
  p_desde date,
  p_hasta date
) returns table (
  comision_ponderada numeric,
  factor_ponderado   numeric,
  venta              numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select case when sum(l.monto) > 0
              then sum(l.monto * l.comision_congelada) / sum(l.monto)
              else 0 end,
         case when sum(l.monto) filter (where l.gana) > 0
              then sum(l.premio) / sum(l.monto) filter (where l.gana)
              else 0 end,
         coalesce(sum(l.monto), 0)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and s.estado = 'liquidado'
    and t.anulado_en is null;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0012_ciclo_automatico.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0013_ciclo_autorreparable.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0014_programar_dia_silencioso.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0015_historico_demostracion.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Histórico sintético para demostración.
--
-- QUÉ ES Y QUÉ NO ES
-- ------------------
-- Datos INVENTADOS con la forma de los reales. Sirven para enseñar el sistema
-- funcionando con volumen; no son operación. Todo lo que crea queda marcado:
-- los vendedores de demostración van del V-101 en adelante, y `fn_borrar_demo`
-- lo retira entero. Que la retirada exista desde el primer día es deliberado:
-- un juego de datos de demo sin forma de quitarlo termina confundido con la
-- operación real.
--
-- DE DÓNDE SALEN LOS NÚMEROS
-- --------------------------
-- Los montos por línea replican los de dos hojas manuscritas reales: moda
-- entre 5 y 30 L, cola hasta 500. La concentración también es de las hojas —
-- en una de ellas la decena del 90 llevaba de 200 a 500 L por número mientras
-- el resto iba a 30.
--
-- Esa concentración es lo que hace que el negocio pierda: si sale un número
-- cargado, el premio se dispara. Sin ella el resultado mensual sería casi
-- constante y la demostración mentiría sobre el riesgo del negocio.
--
-- SIN TOPE POR NÚMERO
-- -------------------
-- Por decisión explícita, el histórico se genera sin tope efectivo: el interés
-- es ver el movimiento, no cuánto se habría rechazado. `limite_casa` se fija
-- absurdamente alto para que la restricción `cupo_no_excedido` no estorbe.
-- ===========================================================================

-- --- Padrón de demostración ------------------------------------------------

create or replace function allan.fn_sembrar_vendedores_demo(p_cuantos integer default 25)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_nombres text[] := array[
    'Ana L. Interiano','Marvin O. Cáceres','Yolanda Sabillón','Óscar R. Turcios',
    'Karla P. Mejía','Wilmer A. Discua','Suyapa Banegas','Élmer J. Fajardo',
    'Nolvia E. Barahona','Rigoberto Mencía','Xiomara Pineda','Denis A. Corrales',
    'Blanca R. Hernández','Osman F. Velásquez','Iris N. Maldonado','Gerson Aguilar',
    'Lourdes A. Cárcamo','Fredy O. Palma','Mirna S. Portillo','Allan D. Bustillo',
    'Reina I. Zúniga','Héctor M. Andino','Delmy A. Rivera','Josué E. Pavón',
    'Sandra L. Guevara','Erick A. Bonilla','Marlen O. Castellanos','Tito R. Lanza',
    'Norma E. Alvarado','Julio C. Sierra'];
  v_zonas text[] := array[
    'SPS · Centro','SPS · Guamilito','SPS · Río de Piedras','SPS · Cofradía',
    'SPS · Satélite','SPS · Medina','SPS · Bella Vista','SPS · Sunseri',
    'SPS · El Benque','SPS · Las Palmas','SPS · Suyapa','SPS · Barandillas',
    'SPS · Cabañas','SPS · La Guardia',
    'Choloma · Centro','Choloma · López Arellano','Choloma · Las Brisas',
    'Choloma · Buenos Aires','Choloma · Sector 3','Choloma · El Higuero',
    'Choloma · Zona Norte',
    'Villanueva · Centro','Villanueva · Cofradía','Villanueva · Búfalo',
    'Villanueva · Río Blanco',
    'La Lima · Centro','La Lima · Campo Rojo','La Lima · Planta',
    'Puerto Cortés · Centro','Puerto Cortés · Laguna'];
  v_ciudades text[] := array[
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula',
    'Choloma','Choloma','Choloma','Choloma','Choloma','Choloma','Choloma',
    'Villanueva','Villanueva','Villanueva','Villanueva',
    'La Lima','La Lima','La Lima',
    'Puerto Cortés','Puerto Cortés'];
  -- Centro aproximado de cada zona, para que el mapa no amontone a todo el
  -- padrón en un mismo punto.
  v_lat numeric[] := array[
    15.5045,15.5120,15.4980,15.4560,15.5310,15.5180,15.5240,15.4420,
    15.4890,15.5390,15.5070,15.4950,15.5150,15.4790,
    15.6120,15.5980,15.6210,15.6050,15.6180,15.5890,15.6340,
    15.3160,15.3040,15.3280,15.2950,
    15.4340,15.4210,15.4460,
    15.8420,15.8310];
  v_lng numeric[] := array[
    -88.0250,-88.0310,-88.0180,-88.0890,-88.0210,-88.0340,-88.0120,-88.0760,
    -88.0430,-88.0290,-88.0380,-88.0150,-88.0470,-88.0620,
    -87.9510,-87.9620,-87.9430,-87.9580,-87.9390,-87.9670,-87.9480,
    -87.9980,-88.0120,-87.9860,-88.0230,
    -87.9110,-87.9240,-87.8980,
    -87.9450,-87.9560];
  v_colores text[] := array['#2563eb','#0891b2','#e11d48','#7c3aed','#059669',
                            '#d97706','#0d9488','#4f46e5','#ea580c','#be123c'];
  i         integer;
  v_id      uuid;
  v_creados integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  for i in 1..least(p_cuantos, array_length(v_nombres, 1)) loop
    v_id := null;

    insert into allan.vendedor (codigo, nombre, ciudad, barrio, zona, color,
                                lat, lng, telefono)
    values (
      'V-' || lpad((100 + i)::text, 3, '0'),
      v_nombres[i],
      v_ciudades[i],
      split_part(v_zonas[i], ' · ', 2),
      v_zonas[i],
      v_colores[1 + (i % 10)],
      -- Dispersión de kilómetro y medio alrededor del centro de la zona.
      v_lat[i] + (random() - 0.5) * 0.028,
      v_lng[i] + (random() - 0.5) * 0.028,
      '9' || lpad((floor(random() * 9999999))::int::text, 7, '0')
    )
    on conflict (codigo) do nothing
    returning id into v_id;

    if v_id is not null then
      -- Comisión de 10 % a 13 % y factor de 70 a 72, que es lo que se ve en la
      -- plaza. El tope del vendedor va altísimo: el histórico se pidió sin tope.
      insert into allan.parametro_vendedor
        (vendedor_id, comision, factor_pago, tope_por_numero, vigente_desde)
      values (
        v_id,
        round((0.10 + random() * 0.03)::numeric, 5),
        70 + floor(random() * 3),
        9000000,
        '2025-12-31 00:00:00-06'::timestamptz
      );
      v_creados := v_creados + 1;
    end if;
  end loop;

  return v_creados;
end;
$$;

-- --- Un día de histórico ---------------------------------------------------
-- Se siembra día a día en lugar de por todo el rango: cada llamada es corta, el
-- avance se ve, y si algo se corta se reanuda donde iba. Un único statement de
-- setecientas mil filas se arriesga a agotar el tiempo límite.

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  -- Montos exactos de las hojas manuscritas. Repetir un valor es cómo se
  -- pondera: el 5 y el 10 salen cuatro veces más que el 150.
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_dec     integer;
  v_hot1    integer;
  v_hot2    integer;
  v_cargado integer;
  v_pcarga  numeric;
  v_inicio  timestamptz;
  v_dur     interval;
  v_n       integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_h in array array['11:00','15:00','20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_h when '11:00' then time '11:00'
                       when '15:00' then time '15:00'
                       else time '20:00' end;

    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    values (p_fecha, v_h,
            ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
            'abierto')
    on conflict (fecha, hora) do nothing;

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    -- Idempotente: un sorteo que ya tiene ventas no se vuelve a sembrar.
    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    -- `do update`, no `do nothing`: los sorteos que ya existían traen el tope
    -- de su franja (4.000 a 7.000 L) y la restricción `cupo_no_excedido` haría
    -- fallar la carga en cuanto un número pasara de ahí.
    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    -- Un sorteo que se quedó en `programado` no se puede cerrar ni liquidar
    -- después. Se pasa a `abierto`, que es el estado que le corresponde a un
    -- sorteo con ventas.
    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    -- Perfil de apuesta del sorteo.
    v_dec  := floor(random() * 10)::int * 10;   -- decena de moda
    v_hot1 := floor(random() * 100)::int;       -- dos números perseguidos
    v_hot2 := floor(random() * 100)::int;

    -- Uno de cada diez sorteos "corre el dato" y un número se lleva una tajada
    -- enorme. Es el suceso que produce los meses en pérdida: sin él, con
    -- noventa sorteos al mes la ley de los grandes números aplana el resultado
    -- y nunca se vería un mes malo.
    if random() < 0.10 then
      v_cargado := floor(random() * 100)::int;
      v_pcarga  := 0.25 + random() * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    -- La venta ocurre en las cinco horas previas al cierre.
    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    create temp table _tk (id uuid, vendedor_id uuid);

    -- 1. Tickets. `total` entra en 1 porque la restricción exige > 0; el valor
    --    de verdad se calcula en el paso 3, desde las líneas.
    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (random() * v_dur),
        -- El vendedor se mueve por su zona; no vende siempre en el mismo metro.
        v.lat + (random() - 0.5) * 0.012,
        v.lng + (random() - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1, greatest(1, round(8 * (0.4 + random() * 1.2))::int)) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- 2. Líneas, con los parámetros del vendedor CONGELADOS (§1). Aunque esto
    --    no pase por `fn_registrar_ticket`, el congelamiento se respeta: es lo
    --    que hace que la utilidad histórica no se reescriba nunca.
    insert into allan.linea
      (ticket_id, numero, monto, comision_congelada, factor_congelado)
    select
      t.id,
      case
        when v_cargado is not null and x.r < v_pcarga then v_cargado
        when x.r < v_pcarga + 0.15 then v_dec + floor(x.r2 * 10)::int
        when x.r < v_pcarga + 0.45 then case when x.r2 < 0.5 then v_hot1 else v_hot2 end
        else floor(x.r2 * 100)::int
      end,
      v_montos[1 + floor(x.r3 * array_length(v_montos, 1))::int],
      p.comision,
      p.factor_pago
    from _tk t
    join allan.parametro_vendedor p
      on p.vendedor_id = t.vendedor_id and p.vigente_hasta is null
    cross join lateral generate_series(1, 1 + floor(random() * 8)::int) g
    -- Los tres azares se materializan una sola vez por línea. Escribir
    -- random() varias veces en la expresión daría un valor distinto en cada
    -- aparición y la mezcla de probabilidades dejaría de sumar 1.
    cross join lateral (select random() r, random() r2, random() r3) x;

    -- 3. Total del ticket = suma de sus líneas.
    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    -- 4. Contador de cupo, que es lo que leen el control y la liquidación.
    update allan.cupo_numero c
    set vendido = c.vendido + s.suma
    from (select l.numero, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.numero) s
    where c.sorteo_id = v_sorteo and c.numero = s.numero;

    select count(*)::int into v_n from _tk;
    select count(*)::int, coalesce(sum(l.monto), 0)
      into lineas, venta
      from allan.linea l join _tk k on k.id = l.ticket_id;

    hora := v_h;
    tickets := v_n;
    return next;

    drop table _tk;
  end loop;
end;
$$;

-- --- Retirada --------------------------------------------------------------

create or replace function allan.fn_borrar_demo()
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_t integer := 0;
  v_l integer := 0;
  v_s integer := 0;
  v_v integer := 0;
  v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  delete from allan.linea l
  where l.ticket_id in (
    select t.id from allan.ticket t
    join allan.vendedor v on v.id = t.vendedor_id
    where v.codigo ~ '^V-1[0-9]{2}$');
  get diagnostics v_l = row_count;

  delete from allan.ticket t
  using allan.vendedor v
  where v.id = t.vendedor_id and v.codigo ~ '^V-1[0-9]{2}$';
  get diagnostics v_t = row_count;

  -- Sorteos que quedaron sin una sola venta, anteriores a hoy. Los de hoy y los
  -- futuros son de la operación y no se tocan.
  delete from allan.liquidacion lq
  where lq.sorteo_id in (
    select s.id from allan.sorteo s
    where s.fecha < v_hoy
      and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id));

  delete from allan.cupo_numero c
  where c.sorteo_id in (
    select s.id from allan.sorteo s
    where s.fecha < v_hoy
      and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id));

  delete from allan.sorteo s
  where s.fecha < v_hoy
    and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id);
  get diagnostics v_s = row_count;

  delete from allan.parametro_vendedor p
  using allan.vendedor v
  where v.id = p.vendedor_id and v.codigo ~ '^V-1[0-9]{2}$';

  delete from allan.vendedor v where v.codigo ~ '^V-1[0-9]{2}$';
  get diagnostics v_v = row_count;

  return format('retirado: %s líneas, %s tickets, %s sorteos, %s vendedores',
                v_l, v_t, v_s, v_v);
end;
$$;

revoke execute on function allan.fn_sembrar_vendedores_demo(integer) from public, anon, authenticated;
revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;
revoke execute on function allan.fn_borrar_demo() from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0016_demo_hora_ambigua.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Corrige «column reference "hora" is ambiguous» en fn_sembrar_dia_demo.
--
-- La función declara `returns table (hora allan.hora_sorteo, …)`, así que
-- `hora` es también una variable de salida. En
--
--     on conflict (fecha, hora) do nothing
--
-- PostgreSQL no puede decidir si `hora` es la columna de `allan.sorteo` o la
-- variable, y un destino de conflicto NO admite cualificación: no se puede
-- escribir `on conflict (s.fecha, s.hora)`.
--
-- Es el mismo choque que arregló la 0004 en `fn_registrar_ticket`. Allí se
-- renombraron las columnas de salida; aquí basta con evitar el `on conflict`,
-- porque un `where not exists` sí se puede cualificar y deja la firma intacta
-- —lo que permite un `create or replace` sin tener que soltar la función—.
-- ===========================================================================

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  -- Montos exactos de las hojas manuscritas. Repetir un valor es cómo se
  -- pondera: el 5 y el 10 salen cuatro veces más que el 150.
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_dec     integer;
  v_hot1    integer;
  v_hot2    integer;
  v_cargado integer;
  v_pcarga  numeric;
  v_inicio  timestamptz;
  v_dur     interval;
  v_n       integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_h in array array['11:00','15:00','20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_h when '11:00' then time '11:00'
                       when '15:00' then time '15:00'
                       else time '20:00' end;

    -- `where not exists` en lugar de `on conflict (fecha, hora)`: aquí las
    -- columnas sí se pueden cualificar y desaparece la ambigüedad con la
    -- variable de salida `hora`.
    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    select p_fecha, v_h,
           ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
           'abierto'
    where not exists (
      select 1 from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h);

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    -- Idempotente: un sorteo que ya tiene ventas no se vuelve a sembrar.
    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    -- `do update`, no `do nothing`: los sorteos que ya existían traen el tope
    -- de su franja (4.000 a 7.000 L) y la restricción `cupo_no_excedido` haría
    -- fallar la carga en cuanto un número pasara de ahí.
    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    -- Un sorteo que se quedó en `programado` no se puede cerrar ni liquidar
    -- después. Se pasa a `abierto`, que es el estado que corresponde a un
    -- sorteo con ventas.
    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    -- Perfil de apuesta del sorteo.
    v_dec  := floor(random() * 10)::int * 10;   -- decena de moda
    v_hot1 := floor(random() * 100)::int;       -- dos números perseguidos
    v_hot2 := floor(random() * 100)::int;

    -- Uno de cada diez sorteos "corre el dato" y un número se lleva una tajada
    -- enorme. Es el suceso que produce los meses en pérdida: sin él, con
    -- noventa sorteos al mes la ley de los grandes números aplana el resultado
    -- y nunca se vería un mes malo.
    if random() < 0.10 then
      v_cargado := floor(random() * 100)::int;
      v_pcarga  := 0.25 + random() * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    -- La venta ocurre en las cinco horas previas al cierre.
    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    create temp table _tk (id uuid, vendedor_id uuid);

    -- 1. Tickets. `total` entra en 1 porque la restricción exige > 0; el valor
    --    de verdad se calcula en el paso 3, desde las líneas.
    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (random() * v_dur),
        -- El vendedor se mueve por su zona; no vende siempre en el mismo metro.
        v.lat + (random() - 0.5) * 0.012,
        v.lng + (random() - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1, greatest(1, round(8 * (0.4 + random() * 1.2))::int)) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- 2. Líneas, con los parámetros del vendedor CONGELADOS (§1). Aunque esto
    --    no pase por `fn_registrar_ticket`, el congelamiento se respeta: es lo
    --    que hace que la utilidad histórica no se reescriba nunca.
    insert into allan.linea
      (ticket_id, numero, monto, comision_congelada, factor_congelado)
    select
      t.id,
      case
        when v_cargado is not null and x.r < v_pcarga then v_cargado
        when x.r < v_pcarga + 0.15 then v_dec + floor(x.r2 * 10)::int
        when x.r < v_pcarga + 0.45 then case when x.r2 < 0.5 then v_hot1 else v_hot2 end
        else floor(x.r2 * 100)::int
      end,
      v_montos[1 + floor(x.r3 * array_length(v_montos, 1))::int],
      p.comision,
      p.factor_pago
    from _tk t
    join allan.parametro_vendedor p
      on p.vendedor_id = t.vendedor_id and p.vigente_hasta is null
    cross join lateral generate_series(1, 1 + floor(random() * 8)::int) g
    -- Los tres azares se materializan una sola vez por línea. Escribir
    -- random() varias veces en la expresión daría un valor distinto en cada
    -- aparición y la mezcla de probabilidades dejaría de sumar 1.
    cross join lateral (select random() r, random() r2, random() r3) x;

    -- 3. Total del ticket = suma de sus líneas.
    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    -- 4. Contador de cupo, que es lo que leen el control y la liquidación.
    update allan.cupo_numero c
    set vendido = c.vendido + s.suma
    from (select l.numero, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.numero) s
    where c.sorteo_id = v_sorteo and c.numero = s.numero;

    select count(*)::int into v_n from _tk;
    select count(*)::int, coalesce(sum(l.monto), 0)
      into lineas, venta
      from allan.linea l join _tk k on k.id = l.ticket_id;

    hora := v_h;
    tickets := v_n;
    return next;

    drop table _tk;
  end loop;
end;
$$;

revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0017_demo_azar_por_fila.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El azar del generador se evaluaba UNA VEZ por sentencia, no por fila.
--
-- SÍNTOMA
-- -------
-- El primer día sembrado salió así:
--
--     11:00   390 tickets   390 líneas   L 1,950     -> 1 línea por ticket, todas de 5 L
--     15:00   120 tickets   960 líneas   L 96,000    -> 8 líneas por ticket, todas de 100 L
--     20:00   120 tickets   720 líneas   L 36,000    -> 6 líneas por ticket, todas de 50 L
--
-- Cada sorteo con un único monto repetido y un único número de líneas. No es
-- una distribución improbable: es una constante.
--
-- CAUSA
-- -----
-- Los `cross join lateral` no referenciaban la fila externa:
--
--     cross join lateral generate_series(1, 1 + floor(random() * 8)::int) g
--     cross join lateral (select random() r, random() r2, random() r3) x
--
-- Al no depender de nada de fuera, el planificador los trata como invariantes
-- y los evalúa una sola vez para toda la inserción. `random()` es VOLATILE,
-- pero eso sólo obliga a reevaluarla por cada fila DEL SUBPLAN — y el subplan
-- se ejecuta una vez. En la lista de salida de un SELECT sí se evalúa por
-- fila; dentro de un lateral no correlacionado, no.
--
-- ARREGLO
-- -------
-- Se sustituye `random()` por un azar DERIVADO DE LA PROPIA FILA: el md5 del
-- identificador del ticket más una sal. Como la entrada cambia en cada fila, el
-- valor cambia en cada fila y no hay nada que elevar.
--
-- Efecto secundario que conviene: el histórico pasa a ser reproducible. Volver
-- a sembrarlo da exactamente las mismas cifras, que es lo que uno quiere si el
-- gerente pregunta mañana por un número que vio hoy.
-- ===========================================================================

-- Azar determinista en [0,1) a partir de un texto. Los primeros 8 dígitos
-- hexadecimales del md5 son 32 bits, que se llevan a fracción.
create or replace function allan.fn_azar(p_semilla text)
returns double precision
language sql
immutable
set search_path = allan, public
as $$
  select (('x' || substr(md5(p_semilla), 1, 8))::bit(32)::bigint)::double precision
         / 4294967296.0;
$$;

comment on function allan.fn_azar(text) is
  'Azar reproducible por fila. Sustituye a random() dentro de LATERAL: una expresión que depende de la fila no puede elevarse fuera del bucle.';

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  -- Montos exactos de las hojas manuscritas. Repetir un valor es cómo se
  -- pondera: el 5 y el 10 salen cuatro veces más que el 150.
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_sal     text;            -- semilla del sorteo, para que cada uno difiera
  v_dec     integer;
  v_hot1    integer;
  v_hot2    integer;
  v_cargado integer;
  v_pcarga  numeric;
  v_inicio  timestamptz;
  v_dur     interval;
  v_n       integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_h in array array['11:00','15:00','20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_h when '11:00' then time '11:00'
                       when '15:00' then time '15:00'
                       else time '20:00' end;

    -- `where not exists` en lugar de `on conflict (fecha, hora)`: el destino de
    -- un conflicto no admite cualificación y `hora` es también variable de
    -- salida de esta función.
    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    select p_fecha, v_h,
           ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
           'abierto'
    where not exists (
      select 1 from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h);

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    -- Idempotente: un sorteo que ya tiene ventas no se vuelve a sembrar.
    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    -- Perfil de apuesta del sorteo, derivado de su fecha y hora para que sea
    -- reproducible pero distinto en cada sorteo.
    v_sal  := p_fecha::text || v_h::text;
    v_dec  := floor(allan.fn_azar(v_sal || 'dec') * 10)::int * 10;
    v_hot1 := floor(allan.fn_azar(v_sal || 'h1') * 100)::int;
    v_hot2 := floor(allan.fn_azar(v_sal || 'h2') * 100)::int;

    -- Uno de cada diez sorteos "corre el dato" y un número se lleva una tajada
    -- enorme. Es el suceso que produce los meses en pérdida: sin él, con
    -- noventa sorteos al mes la ley de los grandes números aplana el resultado.
    if allan.fn_azar(v_sal || 'carga') < 0.10 then
      v_cargado := floor(allan.fn_azar(v_sal || 'cn') * 100)::int;
      v_pcarga  := 0.25 + allan.fn_azar(v_sal || 'cp') * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    create temp table _tk (id uuid, vendedor_id uuid);

    -- 1. Tickets. El número por vendedor sale de su identificador, así que
    --    varía de vendedor a vendedor y de sorteo a sorteo.
    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (allan.fn_azar(v.id::text || v_sal || g::text || 'h') * v_dur),
        -- El vendedor se mueve por su zona; no vende siempre en el mismo metro.
        v.lat + (allan.fn_azar(v.id::text || v_sal || g::text || 'la') - 0.5) * 0.012,
        v.lng + (allan.fn_azar(v.id::text || v_sal || g::text || 'ln') - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1,
        greatest(1, round(8 * (0.4 + allan.fn_azar(v.id::text || v_sal || 'nt') * 1.2))::int)
      ) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- 2. Líneas, con los parámetros del vendedor CONGELADOS (§1).
    --    Cada azar se deriva del ticket y del índice de línea: depende de la
    --    fila, y por eso no puede evaluarse una sola vez.
    insert into allan.linea
      (ticket_id, numero, monto, comision_congelada, factor_congelado)
    select
      t.id,
      case
        when v_cargado is not null and x.r < v_pcarga then v_cargado
        when x.r < v_pcarga + 0.15 then v_dec + floor(x.r2 * 10)::int
        when x.r < v_pcarga + 0.45 then case when x.r2 < 0.5 then v_hot1 else v_hot2 end
        else floor(x.r2 * 100)::int
      end,
      v_montos[1 + floor(x.r3 * array_length(v_montos, 1))::int],
      p.comision,
      p.factor_pago
    from _tk t
    join allan.parametro_vendedor p
      on p.vendedor_id = t.vendedor_id and p.vigente_hasta is null
    cross join lateral generate_series(
      1, 1 + floor(allan.fn_azar(t.id::text || 'nl') * 8)::int) g
    cross join lateral (
      select allan.fn_azar(t.id::text || g::text || 'a') r,
             allan.fn_azar(t.id::text || g::text || 'b') r2,
             allan.fn_azar(t.id::text || g::text || 'c') r3
    ) x;

    -- 3. Total del ticket = suma de sus líneas.
    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    -- 4. Contador de cupo, que es lo que leen el control y la liquidación.
    update allan.cupo_numero c
    set vendido = c.vendido + s.suma
    from (select l.numero, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.numero) s
    where c.sorteo_id = v_sorteo and c.numero = s.numero;

    select count(*)::int into v_n from _tk;
    select count(*)::int, coalesce(sum(l.monto), 0)
      into lineas, venta
      from allan.linea l join _tk k on k.id = l.ticket_id;

    hora := v_h;
    tickets := v_n;
    return next;

    drop table _tk;
  end loop;
end;
$$;

revoke execute on function allan.fn_azar(text) from public, anon;
revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0018_demo_estadisticas_temporal.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El sembrado se degradaba hasta agotar el tiempo límite.
--
-- SÍNTOMA
-- -------
-- Los primeros días tardaban ~450 ms. Hacia el día 207, con `allan.linea` ya en
-- 650 mil filas, una llamada superó el `statement_timeout` y abortó:
--
--     2026-07-26: canceling statement due to statement timeout
--
-- CAUSA
-- -----
-- La tabla temporal `_tk` se crea vacía y se llena en la misma transacción, así
-- que NUNCA tiene estadísticas. El planificador le supone un tamaño por defecto
-- —del orden de mil filas— y con esa estimación decide que, para
--
--     from allan.linea l join _tk k on k.id = l.ticket_id
--
-- sale más barato recorrer `allan.linea` entera y hacer un hash join que
-- entrar por el índice `linea_ticket`. Cuando `linea` tenía diez mil filas ese
-- recorrido era gratis; con 650 mil, multiplicado por los tres sorteos del día,
-- deja de serlo. El plan no empeoró: siempre fue el mismo, y lo que creció fue
-- lo que costaba.
--
-- ARREGLO
-- -------
-- Clave primaria en `_tk` —que da índice para el join— y un `analyze` en cuanto
-- se llena, para que el planificador conozca su tamaño real y elija el bucle
-- anidado por índice.
-- ===========================================================================

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_sal     text;
  v_dec     integer;
  v_hot1    integer;
  v_hot2    integer;
  v_cargado integer;
  v_pcarga  numeric;
  v_inicio  timestamptz;
  v_dur     interval;
  v_n       integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_h in array array['11:00','15:00','20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_h when '11:00' then time '11:00'
                       when '15:00' then time '15:00'
                       else time '20:00' end;

    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    select p_fecha, v_h,
           ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
           'abierto'
    where not exists (
      select 1 from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h);

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    v_sal  := p_fecha::text || v_h::text;
    v_dec  := floor(allan.fn_azar(v_sal || 'dec') * 10)::int * 10;
    v_hot1 := floor(allan.fn_azar(v_sal || 'h1') * 100)::int;
    v_hot2 := floor(allan.fn_azar(v_sal || 'h2') * 100)::int;

    if allan.fn_azar(v_sal || 'carga') < 0.10 then
      v_cargado := floor(allan.fn_azar(v_sal || 'cn') * 100)::int;
      v_pcarga  := 0.25 + allan.fn_azar(v_sal || 'cp') * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    -- Con clave primaria: el join contra `allan.linea` tiene por dónde entrar.
    create temp table _tk (id uuid primary key, vendedor_id uuid);

    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (allan.fn_azar(v.id::text || v_sal || g::text || 'h') * v_dur),
        v.lat + (allan.fn_azar(v.id::text || v_sal || g::text || 'la') - 0.5) * 0.012,
        v.lng + (allan.fn_azar(v.id::text || v_sal || g::text || 'ln') - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1,
        greatest(1, round(8 * (0.4 + allan.fn_azar(v.id::text || v_sal || 'nt') * 1.2))::int)
      ) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- Sin esto el planificador le supone un tamaño por defecto y prefiere
    -- recorrer `allan.linea` entera antes que entrar por `linea_ticket`.
    analyze _tk;

    insert into allan.linea
      (ticket_id, numero, monto, comision_congelada, factor_congelado)
    select
      t.id,
      case
        when v_cargado is not null and x.r < v_pcarga then v_cargado
        when x.r < v_pcarga + 0.15 then v_dec + floor(x.r2 * 10)::int
        when x.r < v_pcarga + 0.45 then case when x.r2 < 0.5 then v_hot1 else v_hot2 end
        else floor(x.r2 * 100)::int
      end,
      v_montos[1 + floor(x.r3 * array_length(v_montos, 1))::int],
      p.comision,
      p.factor_pago
    from _tk t
    join allan.parametro_vendedor p
      on p.vendedor_id = t.vendedor_id and p.vigente_hasta is null
    cross join lateral generate_series(
      1, 1 + floor(allan.fn_azar(t.id::text || 'nl') * 8)::int) g
    cross join lateral (
      select allan.fn_azar(t.id::text || g::text || 'a') r,
             allan.fn_azar(t.id::text || g::text || 'b') r2,
             allan.fn_azar(t.id::text || g::text || 'c') r3
    ) x;

    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    update allan.cupo_numero c
    set vendido = c.vendido + s.suma
    from (select l.numero, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.numero) s
    where c.sorteo_id = v_sorteo and c.numero = s.numero;

    select count(*)::int into v_n from _tk;
    select count(*)::int, coalesce(sum(l.monto), 0)
      into lineas, venta
      from allan.linea l join _tk k on k.id = l.ticket_id;

    hora := v_h;
    tickets := v_n;
    return next;

    drop table _tk;
  end loop;
end;
$$;

revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0019_utilidad_por_numero.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Utilidad por número, y marcha atrás de una liquidación de demostración.
--
-- POR QUÉ HACE FALTA LA PRIMERA
-- -----------------------------
-- `fn_peor_escenario` devuelve UNA fila: el número que más pagaría. Hace
-- exactamente lo que su nombre dice, y para el panel de exposición es lo
-- correcto. Pero el sembrado del histórico la usó como si devolviera los cien,
-- y con noventa y nueve casillas en cero eligió los ganadores a ciegas: los
-- meses salían en cero salvo cuando el azar caía en la única con dato.
--
-- NOMBRES DE SALIDA CON PREFIJO
-- -----------------------------
-- Las columnas de salida se llaman `r_numero`, `r_pago`, `r_utilidad` y no
-- `numero`, `pago`, `utilidad`. En una función `returns table (…)` esos nombres
-- son también variables, y chocan con las columnas homónimas de `allan.linea`
-- en cuanto aparecen sin cualificar —o donde no se PUEDE cualificar—. Es el
-- mismo choque que ya obligó a la 0004 (`fn_registrar_ticket`) y a la 0016
-- (`on conflict (fecha, hora)`). Con prefijo, la clase entera de error
-- desaparece en lugar de esquivarse caso por caso.
-- ===========================================================================

create or replace function allan.fn_utilidad_por_numero(p_sorteo_id uuid)
returns table (r_numero smallint, r_pago numeric, r_utilidad numeric)
language plpgsql
stable
security definer
set search_path = allan, public
as $$
declare
  v_venta    numeric(14,2) := 0;
  v_comision numeric(14,2) := 0;
begin
  perform allan.fn_exige(array['administrador', 'auditor']::allan.rol_usuario[]);

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0)
  into v_venta, v_comision
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id and t.anulado_en is null;

  -- Los cien números, incluidos los que nadie jugó: que un número no tenga
  -- apuestas es información —ahí la casa se queda con la venta entera— y
  -- omitirlo dejaría huecos que quien consuma esto tendría que rellenar.
  return query
  with jugado as (
    select l.numero                             as num,
           sum(l.monto * l.factor_congelado)    as pgo
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id and t.anulado_en is null
    group by l.numero
  )
  select g.i::smallint,
         coalesce(j.pgo, 0)::numeric,
         (v_venta - v_comision - coalesce(j.pgo, 0))::numeric
  from generate_series(0, 99) as g(i)
  left join jugado j on j.num = g.i
  order by g.i;
end;
$$;

comment on function allan.fn_utilidad_por_numero(uuid) is
  'Utilidad del sorteo para cada uno de los 100 números posibles. A diferencia de fn_peor_escenario, que devuelve sólo el peor, aquí están todos.';

-- ===========================================================================
-- Marcha atrás de una liquidación. SÓLO SOBRE DATOS DE DEMOSTRACIÓN.
--
-- Un sorteo liquidado es terminal por diseño (§2): tiene número ganador,
-- premios calculados y liquidación por vendedor, y nada de eso debe poder
-- reescribirse. Esa regla es la que impide que un tablero contradiga a un
-- reporte, y no se toca.
--
-- Esta función existe porque el histórico sintético se liquidó con números
-- elegidos por un guion defectuoso y hay que rehacerlo. Se protege de dos
-- maneras: sólo actúa sobre sorteos cuyas ventas son ÍNTEGRAMENTE de vendedores
-- de demostración (V-101 en adelante), y deja constancia en la bitácora. Un
-- sorteo con una sola venta real queda fuera de su alcance.
-- ===========================================================================

create or replace function allan.fn_desliquidar_demo(p_sorteo_id uuid)
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_total  integer := 0;
  v_reales integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select count(*),
         count(*) filter (where v.codigo !~ '^V-1[0-9]{2}$')
  into v_total, v_reales
  from allan.ticket t
  join allan.vendedor v on v.id = t.vendedor_id
  where t.sorteo_id = p_sorteo_id;

  if v_total = 0 then
    return 'sin ventas: nada que deshacer';
  end if;

  if v_reales > 0 then
    raise exception
      'El sorteo tiene % ventas de vendedores reales. Deshacer una liquidación sólo se permite sobre datos de demostración.',
      v_reales
      using errcode = 'insufficient_privilege';
  end if;

  update allan.linea l
  set gana = false, premio = 0
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and l.gana;

  delete from allan.liquidacion lq where lq.sorteo_id = p_sorteo_id;

  update allan.sorteo s
  set estado = 'cerrado',
      numero_ganador = null,
      liquidado_en = null,
      liquidado_por = null
  where s.id = p_sorteo_id
    and s.estado = 'liquidado';

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'desliquidar_demo', 'estado',
                           'liquidado', 'cerrado');

  return 'deshecho';
end;
$$;

revoke execute on function allan.fn_utilidad_por_numero(uuid) from public, anon;
revoke execute on function allan.fn_desliquidar_demo(uuid) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0020_desliquidar_por_folio.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El guardián de `fn_desliquidar_demo` miraba el marcador equivocado.
--
-- Comprobaba que ningún ticket del sorteo fuera de un vendedor real (V-001 a
-- V-005), y rechazaba todo con:
--
--     El sorteo tiene 47 ventas de vendedores reales.
--
-- La comprobación era correcta; la premisa, no. El generador siembra para
-- TODOS los vendedores activos, los cinco originales incluidos — que es lo
-- deseable: un padrón donde cinco de treinta no tienen historia se ve raro en
-- el mapa y en los reportes.
--
-- El marcador fiable es el FOLIO, no el vendedor. `fn_registrar_ticket` los
-- compone como `V001-20260819-0001`, siempre empezando por el código del
-- vendedor; el generador de demostración los estampa con `D` y la fecha. Son
-- espacios de nombres disjuntos, y el prefijo identifica el origen del dato
-- sin depender de quién lo vendió.
-- ===========================================================================

create or replace function allan.fn_desliquidar_demo(p_sorteo_id uuid)
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_total  integer := 0;
  v_reales integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  -- Un ticket es de demostración si su folio empieza por 'D'. Los que emite
  -- `fn_registrar_ticket` empiezan por el código del vendedor (V001-…), así
  -- que los dos espacios de nombres no se solapan.
  select count(*),
         count(*) filter (where t.folio !~ '^D[0-9]{6}')
  into v_total, v_reales
  from allan.ticket t
  where t.sorteo_id = p_sorteo_id;

  if v_total = 0 then
    return 'sin ventas: nada que deshacer';
  end if;

  if v_reales > 0 then
    raise exception
      'El sorteo tiene % ventas que no son de demostración. Deshacer una liquidación sólo se permite sobre datos sintéticos.',
      v_reales
      using errcode = 'insufficient_privilege';
  end if;

  update allan.linea l
  set gana = false, premio = 0
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and l.gana;

  delete from allan.liquidacion lq where lq.sorteo_id = p_sorteo_id;

  update allan.sorteo s
  set estado = 'cerrado',
      numero_ganador = null,
      liquidado_en = null,
      liquidado_por = null
  where s.id = p_sorteo_id
    and s.estado = 'liquidado';

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'desliquidar_demo', 'estado',
                           'liquidado', 'cerrado');

  return 'deshecho';
end;
$$;

-- --- La retirada, por el mismo criterio ------------------------------------
-- `fn_borrar_demo` borraba por código de vendedor, así que habría dejado atrás
-- todos los tickets sintéticos de los cinco vendedores originales.

create or replace function allan.fn_borrar_demo()
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_t integer := 0;
  v_l integer := 0;
  v_s integer := 0;
  v_v integer := 0;
  v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  delete from allan.linea l
  where l.ticket_id in (
    select t.id from allan.ticket t where t.folio ~ '^D[0-9]{6}');
  get diagnostics v_l = row_count;

  delete from allan.liquidacion lq
  where lq.sorteo_id in (
    select s.id from allan.sorteo s where s.fecha < v_hoy);

  delete from allan.ticket t where t.folio ~ '^D[0-9]{6}';
  get diagnostics v_t = row_count;

  -- Sorteos que quedaron sin una sola venta, anteriores a hoy. Los de hoy y los
  -- futuros son de la operación y no se tocan.
  delete from allan.cupo_numero c
  where c.sorteo_id in (
    select s.id from allan.sorteo s
    where s.fecha < v_hoy
      and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id));

  delete from allan.sorteo s
  where s.fecha < v_hoy
    and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id);
  get diagnostics v_s = row_count;

  delete from allan.parametro_vendedor p
  using allan.vendedor v
  where v.id = p.vendedor_id and v.codigo ~ '^V-1[0-9]{2}$';

  delete from allan.vendedor v where v.codigo ~ '^V-1[0-9]{2}$';
  get diagnostics v_v = row_count;

  return format('retirado: %s líneas, %s tickets, %s sorteos, %s vendedores',
                v_l, v_t, v_s, v_v);
end;
$$;

revoke execute on function allan.fn_desliquidar_demo(uuid) from public, anon, authenticated;
revoke execute on function allan.fn_borrar_demo() from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0021_indices_para_volumen.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Índices que el volumen real hizo necesarios.
--
-- Con el histórico completo cargado —166 mil tickets y 746 mil líneas— dos
-- consultas de uso diario se volvieron inaceptables:
--
--     fn_reporte_totales (8 meses)   6403 ms
--     tickets de un día (mapa geo)   2022 ms
--
-- Con los datos de prueba anteriores, de unos pocos miles de filas, ninguna
-- pasaba de unas decenas de milisegundos: el plan malo no se notaba. Es el
-- mismo patrón que ya apareció al sembrar, donde una tabla temporal sin
-- estadísticas acabó agotando el tiempo límite. Un índice que falta no duele
-- hasta que la tabla crece.
-- ===========================================================================

-- --- Tickets por instante --------------------------------------------------
-- El mapa y la actividad por hora filtran por `creado_en` sin vendedor. El
-- único índice que lo incluía era `ticket_vendedor_fecha (vendedor_id,
-- creado_en)`, inservible sin el vendedor por delante: PostgreSQL no puede
-- saltar la primera columna de un índice compuesto.

create index if not exists ticket_creado_en
  on allan.ticket (creado_en desc);

-- --- Líneas, sin ir a la tabla ---------------------------------------------
-- Todo agregado recorre linea -> ticket -> sorteo y sólo necesita el importe y
-- los parámetros congelados. Con INCLUDE, el índice ya los lleva y la consulta
-- se resuelve sin tocar la tabla: 746 mil visitas al montón de datos que
-- desaparecen.
--
-- Cuesta espacio, y es un intercambio deliberado: esta base se lee mucho más
-- de lo que se escribe, y las escrituras van de tres en tres mil por día.

create index if not exists linea_agregados
  on allan.linea (ticket_id)
  include (numero, monto, comision_congelada, factor_congelado, gana, premio);

-- --- Sorteos por fecha ascendente ------------------------------------------
-- `sorteo_fecha` es (fecha DESC, hora), perfecto para "los últimos". Los
-- reportes por rango recorren en ascendente; el índice sirve igual porque
-- PostgreSQL lo puede leer al revés, así que no se añade otro.

analyze allan.linea;
analyze allan.ticket;
analyze allan.sorteo;
analyze allan.cupo_numero;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0022_consultas_para_volumen.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Tres consultas que el volumen dejó inservibles.
--
-- Con el histórico cargado, las pantallas tardaban esto en responder:
--
--     simulador        17,3 s
--     geo              16,4 s
--     punto de venta    8,8 s
--     tablero           8,7 s
--     reportes          7,1 s
--
-- Ninguna de las tres causas es «hay muchos datos»: las tres son consultas que
-- traen filas para trabajarlas fuera de la base, o que impiden a PostgreSQL
-- filtrar antes de agregar. Con unos miles de filas no se notaba.
-- ===========================================================================

-- --- 1. Un LEFT JOIN que impedía filtrar -----------------------------------
--
-- `fn_resumen_dia` tardaba 8,4 s para UN día. Tres sorteos y unas diez mil
-- líneas no pueden costar eso.
--
-- La causa: `left join v_agregado_sorteo_vendedor a on a.sorteo_id = s.id`
-- con el filtro `where s.fecha = p_fecha` en el lado IZQUIERDO. En un LEFT
-- JOIN, PostgreSQL no puede empujar esa condición dentro de la vista agrupada
-- —hacerlo cambiaría el resultado, porque las filas sin pareja deben
-- conservarse—, así que agrega las 746 mil líneas enteras y sólo después junta.
--
-- `fn_desglose_dia`, que filtra la vista directamente, tardaba 354 ms.
--
-- El arreglo es repetir la fecha en el ON. Ahí sí se puede empujar: la
-- restricción se aplica a la vista antes de agregar, y el LEFT JOIN sigue
-- devolviendo los sorteos sin ventas.

create or replace function allan.fn_resumen_dia(p_fecha date)
returns table (
  sorteo_id      uuid,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
  numero_ganador smallint,
  tickets        integer,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select s.id, s.hora, s.estado, s.numero_ganador,
         coalesce(sum(a.tickets), 0)::integer,
         coalesce(sum(a.venta), 0),
         coalesce(sum(a.comision), 0),
         coalesce(sum(a.premios), 0),
         coalesce(sum(a.utilidad), 0)
  from allan.sorteo s
  left join allan.v_agregado_sorteo_vendedor a
    on a.sorteo_id = s.id
   and a.fecha = p_fecha        -- <- redundante en lógica, decisivo en plan
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

-- --- 2. El mapa contaba líneas en el navegador -----------------------------
--
-- La pantalla de geo pedía los tickets del día y después TODAS las líneas de
-- esos ~700 tickets, sólo para contar cuántas tenía cada uno. Eran unas tres
-- mil filas por la red y un recorrido de `allan.linea` por cada carga.
--
-- Contar es exactamente lo que la base hace mejor.

create or replace function allan.fn_mapa_dia(
  p_fecha       date,
  p_vendedor_id uuid default null
)
returns table (
  r_folio       text,
  r_lat         double precision,
  r_lng         double precision,
  r_total       numeric,
  r_creado_en   timestamptz,
  r_vendedor_id uuid,
  r_hora        allan.hora_sorteo,
  r_lineas      integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.folio, t.lat, t.lng, t.total, t.creado_en, t.vendedor_id, s.hora,
         count(l.id)::integer
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.anulado_en is null
    and t.lat is not null
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
  group by t.folio, t.lat, t.lng, t.total, t.creado_en, t.vendedor_id, s.hora;
$$;

comment on function allan.fn_mapa_dia(date, uuid) is
  'Un punto por ticket para el mapa, con su número de líneas ya contado. Sustituye a traer las líneas y contarlas en el cliente.';

-- --- 3. El punto de venta sumaba diez mil líneas en el navegador -----------
--
-- Traía todas las líneas del sorteo —unas diez mil con treinta vendedores—
-- para repartirlas en un vector de cien casillas por vendedor. El resultado son
-- como mucho 30 × 100 filas: agregarlas en SQL manda tres mil filas en vez de
-- diez mil, y el trabajo lo hace quien tiene los índices.

create or replace function allan.fn_vendido_por_vendedor(p_sorteo_id uuid)
returns table (
  r_vendedor_id uuid,
  r_numero      smallint,
  r_vendido     numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select t.vendedor_id, l.numero, sum(l.monto)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
  group by t.vendedor_id, l.numero;
$$;

comment on function allan.fn_vendido_por_vendedor(uuid) is
  'Lo vendido por cada vendedor en cada número de un sorteo. Es el dato que el POS usa para mostrar el saldo al teclear; sigue sin ser autoritativo (§3): la venta la valida fn_registrar_ticket con la fila bloqueada.';

revoke execute on function allan.fn_mapa_dia(date, uuid) from public, anon;
revoke execute on function allan.fn_vendido_por_vendedor(uuid) from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0023_rls_y_agregados_rapidos.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Lo que de verdad hacía lentas las pantallas: RLS evaluado fila por fila.
--
-- Medido con `service_role` —que se salta RLS— el simulador tardaba 5,1 s. La
-- misma pantalla, con una sesión de administrador, tardaba 17. La diferencia no
-- estaba en la consulta: estaba en la política.
--
--     create policy linea_por_ticket on allan.linea
--       using (
--         exists (
--           select 1 from allan.ticket t
--           where t.id = linea.ticket_id
--             and ( t.vendedor_id = allan.fn_vendedor_actual()
--                   or allan.fn_rol_actual() in (...) )))
--
-- Ese EXISTS se ejecuta UNA VEZ POR FILA. Sobre 746 mil líneas son 746 mil
-- subconsultas más un millón y medio de llamadas a función — para un
-- administrador, que puede verlo todo y para quien la respuesta es siempre sí.
--
-- Dos cambios, ambos conocidos y ninguno relaja la seguridad:
--
--   1. La comprobación de ROL va primero. Es una comparación contra un valor
--      único; el EXISTS sólo hace falta para un vendedor, que además ve pocas
--      filas.
--   2. Las llamadas a función se envuelven en `(select …)`. Así PostgreSQL las
--      evalúa una sola vez como InitPlan en lugar de por fila. El resultado es
--      idéntico —el rol no cambia a mitad de consulta— y el costo pasa de
--      lineal a constante.
--
-- Quién ve qué no cambia en absoluto: las mismas dos condiciones, unidas por el
-- mismo OR.
-- ===========================================================================

drop policy if exists ticket_propio on allan.ticket;

create policy ticket_propio on allan.ticket
  for select to authenticated
  using (
    (select allan.fn_rol_actual()) in ('administrador', 'auditor', 'digitador')
    or vendedor_id = (select allan.fn_vendedor_actual())
  );

drop policy if exists linea_por_ticket on allan.linea;

create policy linea_por_ticket on allan.linea
  for select to authenticated
  using (
    (select allan.fn_rol_actual()) in ('administrador', 'auditor', 'digitador')
    or exists (
      select 1 from allan.ticket t
      where t.id = linea.ticket_id
        and t.vendedor_id = (select allan.fn_vendedor_actual())
    )
  );

-- ===========================================================================
-- Agregados de rango largo, sin `count(distinct)`.
--
-- `v_agregado_sorteo_vendedor` calcula `count(distinct t.id)` siempre, aunque
-- quien la consulta no lo necesite. Sobre ocho meses eso es una agregación
-- distinta sobre 746 mil filas, y era lo que dejaba a `fn_resumen_mensual` en
-- 8,2 s.
--
-- Las tres funciones de rango largo pasan a leer las tablas base y a contar los
-- tickets donde contar es barato: en la tabla `ticket`, donde cada fila ya es
-- un ticket. La vista se queda como está — para un día es rápida y es la
-- definición canónica de los agregados (§2).
-- ===========================================================================

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with dinero as (
    select
      coalesce(sum(l.monto), 0)                                                    as venta,
      coalesce(sum(l.monto * l.comision_congelada), 0)                             as comision,
      coalesce(sum(l.monto) filter (where s.estado = 'liquidado'), 0)              as venta_liq,
      coalesce(sum(l.monto * l.comision_congelada)
               filter (where s.estado = 'liquidado'), 0)                           as comision_liq,
      coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0)             as premios,
      coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)             as venta_pend
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
  ),
  conteos as (
    select
      (select count(*)
       from allan.ticket t
       join allan.sorteo s on s.id = t.sorteo_id
       where s.fecha between p_desde and p_hasta
         and t.anulado_en is null)::integer as tickets,
      -- Sorteos CON ventas, que es lo que la vista contaba.
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado = 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as liquidados,
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado <> 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as pendientes
  )
  select d.venta, d.comision, c.tickets,
         d.venta_liq, d.comision_liq, d.premios,
         d.venta_liq - d.comision_liq - d.premios,
         d.venta_pend, c.liquidados, c.pendientes
  from dinero d, conteos c;
$$;

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  select extract(year  from s.fecha)::integer,
         extract(month from s.fecha)::integer - 1,   -- 0–11, como espera la interfaz
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto - l.monto * l.comision_congelada - l.premio)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where s.fecha between p_desde and p_hasta
    and t.anulado_en is null
  group by 1, 2
  order by 1, 2;
$$;

-- `fn_resumen_vendedor` se deja como está: ya filtra la fecha dentro del ON, no
-- usa el conteo distinto, y su costo debería caer solo con el arreglo de RLS.
-- Reescribir lo que no está roto es cómo se introducen fallos.

-- >>>>>>>>>>>>>>>>>>>>  migrations/0024_usuarios_propios.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Usuarios en tabla propia, fuera de Supabase Auth.
--
-- QUÉ CAMBIA, DICHO SIN ADORNOS
-- -----------------------------
-- Hasta ahora la seguridad vivía en la BASE: cada consulta llevaba el JWT que
-- emite Supabase Auth, y RLS recortaba las filas leyendo el rol de ese JWT. Un
-- vendedor no veía los tickets de otro porque la base no se los daba, hiciera
-- lo que hiciera la aplicación.
--
-- Sin `auth` no hay JWT, y sin JWT `fn_rol_actual()` no tiene de dónde leer. La
-- aplicación pasa a hablar con la base como servicio, y el recorte por rol
-- pasa a ser responsabilidad SUYA. Es una frontera más frágil: un olvido en
-- una consulta ya no lo ataja la base.
--
-- Lo que sostiene el cambio es que el navegador nunca habla con PostgREST —
-- todo va por componentes de servidor y acciones de servidor—, así que la
-- llave de servicio no sale del servidor y la aplicación es de hecho el único
-- cliente. Las políticas de RLS se dejan puestas: no estorban, y si algún día
-- se vuelve a un modelo con JWT siguen ahí.
--
-- LO QUE NO SE TOCA
-- -----------------
-- La validación de cupo con la fila bloqueada dentro de la transacción, el
-- congelamiento de parámetros por línea y la liquidación como estado terminal
-- no dependían nunca del JWT. Siguen intactos, que es lo que de verdad protege
-- el dinero.
-- ===========================================================================

create extension if not exists pgcrypto;

create table if not exists allan.usuario (
  id             uuid primary key default gen_random_uuid(),
  usuario        text not null unique,          -- lo que se teclea al entrar
  nombre         text not null,
  rol            allan.rol_usuario not null,
  vendedor_id    uuid references allan.vendedor(id),
  -- bcrypt de pgcrypto. Nunca la contraseña en claro, ni siquiera aquí: quien
  -- lea la tabla no debe poder entrar con lo que ve.
  hash           text not null,
  activo         boolean not null default true,
  debe_cambiar   boolean not null default true, -- la primera es de un solo uso
  ultimo_acceso  timestamptz,
  creado_en      timestamptz not null default now(),
  creado_por     uuid,

  constraint usuario_formato check (usuario ~ '^[a-z0-9._@-]{3,60}$'),
  constraint usuario_vendedor_enlazado check (
    (rol <> 'vendedor') or (vendedor_id is not null)
  )
);

comment on table allan.usuario is
  'Cuentas de acceso. Sustituye a auth.users. La contraseña se guarda como bcrypt (pgcrypto), nunca en claro.';

-- Un vendedor, una cuenta. Dos personas vendiendo bajo el mismo código serían
-- indistinguibles en la bitácora, que es justo lo que la bitácora evita.
create unique index if not exists usuario_vendedor_unico
  on allan.usuario (vendedor_id) where vendedor_id is not null;

alter table allan.usuario enable row level security;
-- Sin políticas: la tabla no se lee nunca desde un cliente. Todo pasa por las
-- funciones de abajo, que jamás devuelven el hash.

-- --- Alta -------------------------------------------------------------------

create or replace function allan.fn_crear_usuario(
  p_usuario     text,
  p_contrasena  text,
  p_nombre      text,
  p_rol         allan.rol_usuario,
  p_vendedor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_id uuid;
begin
  if length(coalesce(p_contrasena, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_rol = 'vendedor' and p_vendedor_id is null then
    raise exception 'Una cuenta de vendedor tiene que ir enlazada a un vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.usuario (usuario, nombre, rol, vendedor_id, hash)
  values (lower(trim(p_usuario)), p_nombre, p_rol, p_vendedor_id,
          crypt(p_contrasena, gen_salt('bf', 10)))
  returning id into v_id;

  -- La contraseña NO entra en la bitácora, evidentemente.
  perform allan.fn_auditar('usuario', v_id, 'crear', 'rol', null, p_rol::text);

  return v_id;
end;
$$;

-- --- Autenticación ----------------------------------------------------------
-- Devuelve el perfil o nada. No distingue entre usuario inexistente y
-- contraseña incorrecta: decirlo permitiría averiguar qué cuentas existen.
--
-- `crypt(p_contrasena, u.hash)` vuelve a cifrar con la MISMA sal que lleva el
-- hash guardado; si coincide, la contraseña es la buena. La comparación la hace
-- bcrypt, no una igualdad de textos.

create or replace function allan.fn_autenticar(p_usuario text, p_contrasena text)
returns table (
  r_id          uuid,
  r_nombre      text,
  r_rol         allan.rol_usuario,
  r_vendedor_id uuid,
  r_debe_cambiar boolean
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_id uuid;
begin
  select u.id into v_id
  from allan.usuario u
  where u.usuario = lower(trim(p_usuario))
    and u.activo
    and u.hash = crypt(p_contrasena, u.hash);

  if v_id is null then
    return;   -- sin filas: credenciales incorrectas
  end if;

  update allan.usuario set ultimo_acceso = now() where id = v_id;

  return query
    select u.id, u.nombre, u.rol, u.vendedor_id, u.debe_cambiar
    from allan.usuario u where u.id = v_id;
end;
$$;

-- --- Cambio de contraseña ---------------------------------------------------

create or replace function allan.fn_cambiar_contrasena(
  p_usuario_id  uuid,
  p_actual      text,
  p_nueva       text
)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña nueva debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se exige la actual aunque quien llame ya tenga sesión: así una sesión
  -- robada no basta para quedarse con la cuenta.
  if not exists (select 1 from allan.usuario u
                 where u.id = p_usuario_id and u.hash = crypt(p_actual, u.hash)) then
    raise exception 'La contraseña actual no es correcta.'
      using errcode = 'invalid_password';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = false
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'cambiar_contrasena', 'hash',
                           null, null);
end;
$$;

/** Restablecimiento por administración: no exige la actual, la deja de un solo uso. */
create or replace function allan.fn_restablecer_contrasena(
  p_usuario_id uuid,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = true,
      activo = true
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'restablecer_contrasena', 'hash',
                           null, null);
end;
$$;

-- --- Consulta ---------------------------------------------------------------

create or replace function allan.fn_usuario(p_id uuid)
returns table (
  r_id          uuid,
  r_usuario     text,
  r_nombre      text,
  r_rol         allan.rol_usuario,
  r_vendedor_id uuid,
  r_activo      boolean,
  r_debe_cambiar boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select u.id, u.usuario, u.nombre, u.rol, u.vendedor_id, u.activo, u.debe_cambiar
  from allan.usuario u where u.id = p_id;
$$;

/** Qué vendedores ya tienen acceso, para no ofrecer el alta dos veces. */
create or replace function allan.fn_accesos_vendedor()
returns table (r_vendedor_id uuid, r_usuario text, r_activo boolean)
language sql
stable
security definer
set search_path = allan, public
as $$
  select u.vendedor_id, u.usuario, u.activo
  from allan.usuario u
  where u.vendedor_id is not null;
$$;

-- --- El día del vendedor ----------------------------------------------------
-- El filtro por vendedor va EXPLÍCITO. Antes lo ponía RLS leyendo el JWT; sin
-- JWT hay que decirlo, y decirlo aquí —una sola vez, en la base— es mejor que
-- repetirlo en cada pantalla.

create or replace function allan.fn_mi_dia(p_vendedor_id uuid, p_fecha date)
returns table (
  r_sorteo_id uuid,
  r_hora      allan.hora_sorteo,
  r_estado    allan.estado_sorteo,
  r_ganador   smallint,
  r_tickets   integer,
  r_venta     numeric,
  r_comision  numeric,
  r_premios   numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.id, s.hora, s.estado, s.numero_ganador,
         count(distinct t.id)::integer,
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
  from allan.sorteo s
  left join allan.ticket t
    on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
  group by s.id, s.hora, s.estado, s.numero_ganador
  order by s.hora;
$$;

create or replace function allan.fn_mis_tickets(
  p_vendedor_id uuid,
  p_fecha       date,
  p_limite      integer default 40
)
returns table (
  r_folio     text,
  r_hora      allan.hora_sorteo,
  r_creado_en timestamptz,
  r_total     numeric,
  r_lineas    integer,
  r_premio    numeric,
  r_anulado   boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select t.folio, s.hora, t.creado_en, t.total,
         count(l.id)::integer,
         coalesce(sum(l.premio), 0),
         t.anulado_en is not null
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha = p_fecha
    and t.vendedor_id = p_vendedor_id
  group by t.folio, s.hora, t.creado_en, t.total, t.anulado_en
  order by t.creado_en desc
  limit p_limite;
$$;

-- Ninguna de estas es invocable desde un cliente: todas se llaman desde el
-- servidor de la aplicación con la llave de servicio.
revoke execute on function allan.fn_crear_usuario(text, text, text, allan.rol_usuario, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_autenticar(text, text) from public, anon, authenticated;
revoke execute on function allan.fn_cambiar_contrasena(uuid, text, text) from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text) from public, anon, authenticated;
revoke execute on function allan.fn_usuario(uuid) from public, anon, authenticated;
revoke execute on function allan.fn_accesos_vendedor() from public, anon, authenticated;
revoke execute on function allan.fn_mi_dia(uuid, date) from public, anon, authenticated;
revoke execute on function allan.fn_mis_tickets(uuid, date, integer) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0025_pgcrypto_en_el_camino.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- «function gen_salt(unknown, integer) does not exist»
--
-- pgcrypto está instalado, pero en el esquema `extensions` — que es donde
-- Supabase pone las extensiones, no en `public`. Por eso el
-- `create extension if not exists pgcrypto` de la 0024 no hizo nada: la
-- encontró y siguió.
--
-- Las funciones declaran `set search_path = allan, public`, así que `crypt` y
-- `gen_salt` quedaban fuera de su alcance. Fijar el search_path no es opcional
-- en una función `security definer` —sin él, quien la llama podría anteponer un
-- esquema con funciones suyas y ejecutarlas con los privilegios del dueño—, así
-- que la salida no es quitarlo sino añadir `extensions`.
-- ===========================================================================

create or replace function allan.fn_crear_usuario(
  p_usuario     text,
  p_contrasena  text,
  p_nombre      text,
  p_rol         allan.rol_usuario,
  p_vendedor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
declare
  v_id uuid;
begin
  if length(coalesce(p_contrasena, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_rol = 'vendedor' and p_vendedor_id is null then
    raise exception 'Una cuenta de vendedor tiene que ir enlazada a un vendedor.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into allan.usuario (usuario, nombre, rol, vendedor_id, hash)
  values (lower(trim(p_usuario)), p_nombre, p_rol, p_vendedor_id,
          crypt(p_contrasena, gen_salt('bf', 10)))
  returning id into v_id;

  perform allan.fn_auditar('usuario', v_id, 'crear', 'rol', null, p_rol::text);

  return v_id;
end;
$$;

create or replace function allan.fn_autenticar(p_usuario text, p_contrasena text)
returns table (
  r_id           uuid,
  r_nombre       text,
  r_rol          allan.rol_usuario,
  r_vendedor_id  uuid,
  r_debe_cambiar boolean
)
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
declare
  v_id uuid;
begin
  select u.id into v_id
  from allan.usuario u
  where u.usuario = lower(trim(p_usuario))
    and u.activo
    and u.hash = crypt(p_contrasena, u.hash);

  if v_id is null then
    return;   -- sin filas: credenciales incorrectas
  end if;

  update allan.usuario set ultimo_acceso = now() where id = v_id;

  return query
    select u.id, u.nombre, u.rol, u.vendedor_id, u.debe_cambiar
    from allan.usuario u where u.id = v_id;
end;
$$;

create or replace function allan.fn_cambiar_contrasena(
  p_usuario_id uuid,
  p_actual     text,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña nueva debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from allan.usuario u
                 where u.id = p_usuario_id and u.hash = crypt(p_actual, u.hash)) then
    raise exception 'La contraseña actual no es correcta.'
      using errcode = 'invalid_password';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = false
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'cambiar_contrasena', 'hash',
                           null, null);
end;
$$;

create or replace function allan.fn_restablecer_contrasena(
  p_usuario_id uuid,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = true,
      activo = true
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'restablecer_contrasena', 'hash',
                           null, null);
end;
$$;

revoke execute on function allan.fn_crear_usuario(text, text, text, allan.rol_usuario, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_autenticar(text, text) from public, anon, authenticated;
revoke execute on function allan.fn_cambiar_contrasena(uuid, text, text) from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text) from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0026_control_por_rango.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Control de vendedores por rango de fechas y varios vendedores a la vez.
--
-- Las funciones que había —`fn_bitacora_vendedor`, `fn_actividad_horaria`—
-- reciben UN vendedor y UN día. Servían cuando el padrón eran cinco personas;
-- con treinta, la pregunta que se hace de verdad es «cómo fueron estos cuatro
-- en la última quincena», y contestarla a base de treinta consultas de un día
-- no es contestarla.
--
-- Las viejas se conservan: la bitácora de un día suelto sigue siendo la vista
-- más útil cuando ya se sabe a quién y cuándo mirar.
--
-- `p_vendedores` es un arreglo y admite NULL para decir «todos». Un arreglo
-- vacío significaría «ninguno», que no es lo mismo, y confundirlos es cómo se
-- acaba enseñando un tablero en blanco sin saber por qué.
-- ===========================================================================

create or replace function allan.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
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
set search_path = allan, public
as $$
  select v.id, v.codigo, v.nombre, v.zona, v.color,
         count(distinct t.id)::integer,
         count(l.id)::integer,
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio) filter (where s.estado = 'liquidado'), 0),
         -- La utilidad sólo existe donde hay premio calculado: mezclar sorteos
         -- sin liquidar la inflaría con una venta cuyo premio aún no se conoce.
         coalesce(sum(l.monto - l.monto * l.comision_congelada - l.premio)
                  filter (where s.estado = 'liquidado'), 0),
         coalesce(sum(l.monto) filter (where s.estado <> 'liquidado'), 0)
  from allan.vendedor v
  left join allan.ticket t
    on t.vendedor_id = v.id and t.anulado_en is null
  left join allan.sorteo s
    on s.id = t.sorteo_id
   and s.fecha between p_desde and p_hasta
   and (p_hora is null or s.hora = p_hora)
  left join allan.linea l
    on l.ticket_id = t.id and s.id is not null
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  group by v.id, v.codigo, v.nombre, v.zona, v.color
  order by 8 desc, v.codigo;
$$;

comment on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo) is
  'Totales por vendedor en un rango. p_vendedores nulo = todos los activos.';

/** Venta por día del conjunto elegido, para la serie del gráfico. */
create or replace function allan.fn_control_serie(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
)
returns table (r_fecha date, r_venta numeric, r_tickets integer)
language sql
stable
security definer
set search_path = allan, public
as $$
  -- `generate_series` y no sólo los días con venta: un día sin ventas es un
  -- dato, y omitirlo dejaría la línea del gráfico saltando de martes a jueves
  -- como si el miércoles no hubiera existido.
  select d::date,
         coalesce(sum(l.monto), 0),
         count(distinct t.id)::integer
  from generate_series(p_desde, p_hasta, interval '1 day') d
  left join allan.sorteo s
    on s.fecha = d::date and (p_hora is null or s.hora = p_hora)
  left join allan.ticket t
    on t.sorteo_id = s.id
   and t.anulado_en is null
   and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
  left join allan.linea l on l.ticket_id = t.id
  group by d
  order by d;
$$;

/** Actividad por hora del reloj, agregada del conjunto elegido. */
create or replace function allan.fn_control_actividad(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null
)
returns table (r_hora integer, r_monto numeric)
language sql
stable
security definer
set search_path = allan, public
as $$
  select extract(hour from t.creado_en at time zone 'America/Tegucigalpa')::integer,
         coalesce(sum(l.monto), 0)
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  join allan.linea l on l.ticket_id = t.id
  where s.fecha between p_desde and p_hasta
    and t.anulado_en is null
    and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
  group by 1
  order by 1;
$$;

/** La bitácora, ahora por rango. Sigue siendo la única vista que baja a la línea. */
create or replace function allan.fn_bitacora_rango(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date,
  p_hora        allan.hora_sorteo default null,
  p_limite      integer default 300
)
returns table (
  r_fecha     date,
  r_creado_en timestamptz,
  r_hora      allan.hora_sorteo,
  r_estado    allan.estado_sorteo,
  r_folio     text,
  r_numero    smallint,
  r_monto     numeric,
  r_gana      boolean,
  r_premio    numeric,
  r_lat       double precision,
  r_lng       double precision
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.fecha, t.creado_en, s.hora, s.estado, t.folio,
         l.numero, l.monto, l.gana, l.premio, t.lat, t.lng
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
    and t.anulado_en is null
    and (p_hora is null or s.hora = p_hora)
  order by t.creado_en desc, l.numero
  limit p_limite;
$$;

revoke execute on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
revoke execute on function allan.fn_control_serie(date, date, uuid[], allan.hora_sorteo)
  from public, anon;
revoke execute on function allan.fn_control_actividad(date, date, uuid[]) from public, anon;
revoke execute on function allan.fn_bitacora_rango(uuid, date, date, allan.hora_sorteo, integer)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0027_control_filtra_antes.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- `fn_control_vendedores` ignoraba el rango al recorrer.
--
-- Pedir catorce días tardaba lo mismo que pedir ocho meses: 3,1 s. La causa
-- estaba en el orden de los enlaces:
--
--     from allan.vendedor v
--     left join allan.ticket t on t.vendedor_id = v.id and t.anulado_en is null
--     left join allan.sorteo s on s.id = t.sorteo_id
--                             and s.fecha between p_desde and p_hasta
--     left join allan.linea  l on l.ticket_id = t.id and s.id is not null
--
-- El enlace con `ticket` no lleva ninguna condición de fecha —la fecha vive en
-- `sorteo`, un enlace más allá—, así que arranca tomando los 166 mil tickets de
-- todo el histórico y sus 746 mil líneas, y recorta al final. Con LEFT JOIN el
-- planificador no puede adelantar el filtro: las filas sin pareja tienen que
-- conservarse, y adelantarlo cambiaría el resultado.
--
-- El arreglo es invertir el orden: primero los sorteos del rango, y de ahí a
-- los tickets y a las líneas con enlaces internos. Los vendedores se añaden
-- después con un LEFT JOIN, que es lo único que de verdad necesita serlo — para
-- que un vendedor sin ventas en el rango siga apareciendo con sus ceros.
-- ===========================================================================

create or replace function allan.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       allan.hora_sorteo default null
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
set search_path = allan, public
as $$
  with datos as (
    -- Se empieza por el sorteo, que es donde vive la fecha. Todo lo que sigue
    -- son enlaces internos, así que el rango recorta antes de recorrer nada.
    select t.vendedor_id                                   as vendedor_id,
           count(distinct t.id)                            as tickets,
           count(l.id)                                     as lineas,
           sum(l.monto)                                    as venta,
           sum(l.monto * l.comision_congelada)             as comision,
           sum(l.premio) filter (where s.estado = 'liquidado')  as premios,
           sum(l.monto - l.monto * l.comision_congelada - l.premio)
             filter (where s.estado = 'liquidado')         as utilidad,
           sum(l.monto) filter (where s.estado <> 'liquidado')  as pendiente
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
    group by t.vendedor_id
  )
  select v.id, v.codigo, v.nombre, v.zona, v.color,
         coalesce(d.tickets, 0)::integer,
         coalesce(d.lineas, 0)::integer,
         coalesce(d.venta, 0),
         coalesce(d.comision, 0),
         coalesce(d.premios, 0),
         coalesce(d.utilidad, 0),
         coalesce(d.pendiente, 0)
  from allan.vendedor v
  -- Éste sí tiene que ser externo: un vendedor sin ventas en el rango debe
  -- aparecer con ceros, no desaparecer de la comparación.
  left join datos d on d.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(d.venta, 0) desc, v.codigo;
$$;

revoke execute on function allan.fn_control_vendedores(date, date, uuid[], allan.hora_sorteo)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0028_resumenes_desde_liquidacion.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Los resúmenes leen de `liquidacion`, no de las 746 mil líneas.
--
-- El consolidado mensual acabó fallando con
--
--     canceling statement due to statement timeout
--
-- Recorrer todas las líneas y agruparlas por mes son varios segundos, y bajo
-- carga supera el máximo que la base permite.
--
-- POR QUÉ ESTO NO ROMPE EL PRINCIPIO §2
-- -------------------------------------
-- `allan.liquidacion` no es un total capturado a mano: lo escribe
-- `fn_liquidar_sorteo` sumando las líneas, en la misma transacción en que el
-- sorteo pasa a `liquidado`. Es una fila por sorteo y vendedor —20.700 en vez
-- de 746.245, treinta y seis veces menos— y sigue derivando de la línea, que
-- es la unidad atómica. Leerla no es capturar un total: es leer el mismo
-- cálculo, ya hecho, sobre datos que por definición ya no cambian.
--
-- Un sorteo liquidado es terminal: ni entran tickets ni se recalculan premios.
-- Por eso su agregado no puede quedar obsoleto.
--
-- LO PENDIENTE SÍ SE CUENTA DESDE LAS LÍNEAS
-- ------------------------------------------
-- Un sorteo sin liquidar no tiene fila en `liquidacion` —no la puede tener, su
-- premio aún no existe— así que su venta se suma desde las líneas. Son los
-- sorteos del día: unos miles de filas, no cientos de miles.
-- ===========================================================================

create or replace function allan.fn_resumen_mensual(
  p_desde date,
  p_hasta date
) returns table (
  anio            integer,
  mes             integer,
  venta           numeric,
  comision        numeric,
  premios         numeric,
  utilidad        numeric,
  venta_pendiente numeric
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select extract(year  from s.fecha)::integer                as a,
           extract(month from s.fecha)::integer - 1            as m,  -- 0–11
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios,
           sum(lq.utilidad) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by 1, 2
  ),
  pend as (
    select extract(year  from s.fecha)::integer     as a,
           extract(month from s.fecha)::integer - 1 as m,
           sum(l.monto)                             as venta
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
    group by 1, 2
  )
  -- FULL JOIN: un mes puede tener sólo liquidado, sólo pendiente, o ambos.
  select coalesce(liq.a, pend.a),
         coalesce(liq.m, pend.m),
         coalesce(liq.venta, 0) + coalesce(pend.venta, 0),
         coalesce(liq.comision, 0),
         coalesce(liq.premios, 0),
         coalesce(liq.utilidad, 0),
         coalesce(pend.venta, 0)
  from liq
  full join pend on liq.a = pend.a and liq.m = pend.m
  order by 1, 2;
$$;

create or replace function allan.fn_resumen_periodo(
  p_desde date,
  p_hasta date
) returns table (
  venta               numeric,
  comision            numeric,
  tickets             integer,
  venta_liquidada     numeric,
  comision_liquidada  numeric,
  premios             numeric,
  utilidad            numeric,
  venta_pendiente     numeric,
  sorteos_liquidados  integer,
  sorteos_pendientes  integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select coalesce(sum(lq.venta), 0)    as venta,
           coalesce(sum(lq.comision), 0) as comision,
           coalesce(sum(lq.premios), 0)  as premios,
           coalesce(sum(lq.utilidad), 0) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
  ),
  pend as (
    select coalesce(sum(l.monto), 0)                     as venta,
           coalesce(sum(l.monto * l.comision_congelada), 0) as comision
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
  ),
  conteos as (
    select
      (select count(*)
       from allan.ticket t
       join allan.sorteo s on s.id = t.sorteo_id
       where s.fecha between p_desde and p_hasta
         and t.anulado_en is null)::integer as tickets,
      (select count(distinct lq.sorteo_id)
       from allan.liquidacion lq
       join allan.sorteo s on s.id = lq.sorteo_id
       where s.fecha between p_desde and p_hasta)::integer as liquidados,
      (select count(*) from allan.sorteo s
       where s.fecha between p_desde and p_hasta
         and s.estado <> 'liquidado'
         and exists (select 1 from allan.ticket t
                     where t.sorteo_id = s.id and t.anulado_en is null))::integer as pendientes
  )
  select liq.venta + pend.venta,
         liq.comision + pend.comision,
         c.tickets,
         liq.venta,
         liq.comision,
         liq.premios,
         liq.utilidad,
         pend.venta,
         c.liquidados,
         c.pendientes
  from liq, pend, conteos c;
$$;

create or replace function allan.fn_resumen_vendedor(
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
set search_path = allan, public
as $$
  with liq as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios,
           sum(lq.utilidad) as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  pend as (
    select t.vendedor_id, sum(l.monto) as venta
    from allan.sorteo s
    join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join allan.linea  l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
      and s.estado <> 'liquidado'
    group by t.vendedor_id
  )
  select v.id, v.codigo, v.nombre, v.color,
         -- La venta incluye lo pendiente; comisión, premios y utilidad no,
         -- porque de un sorteo sin liquidar aún no se conocen.
         coalesce(liq.venta, 0) + coalesce(pend.venta, 0),
         coalesce(liq.comision, 0),
         coalesce(liq.premios, 0),
         coalesce(liq.utilidad, 0)
  from allan.vendedor v
  left join liq  on liq.vendedor_id = v.id
  left join pend on pend.vendedor_id = v.id
  where v.activo
  order by 5 desc, v.codigo;
$$;

-- El índice que hace barata la unión con el rango de fechas.
create index if not exists liquidacion_sorteo on allan.liquidacion (sorteo_id);

analyze allan.liquidacion;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0029_reportes_desde_liquidacion.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Reportes también leen de `liquidacion`, por dos razones.
--
-- 1. COHERENCIA. Desde la 0028 el tablero suma `liquidacion` y los reportes
--    seguían sumando líneas. Las cifras no coincidían:
--
--       enero, tablero  utilidad  1.981.759,69
--       enero, reportes utilidad  1.981.759,14
--
--    Cincuenta y cinco centavos sobre casi dos millones — nada que nadie note,
--    y exactamente lo que el §2 prohíbe: que un tablero contradiga a un
--    reporte. La diferencia no es un error de cálculo: `liquidacion` guarda
--    numeric(14,2) por sorteo y vendedor, así que sumar veinte mil filas ya
--    redondeadas no da lo mismo que redondear la suma de setecientas mil.
--
--    Con las dos pantallas leyendo lo mismo, la pregunta de cuál tiene razón
--    deja de existir.
--
-- 2. VELOCIDAD. `fn_reporte_totales` tardaba 2,4 s por el mismo motivo que el
--    consolidado: recorría todas las líneas.
--
-- El detalle por sorteo y vendedor de un sorteo liquidado ES la fila de
-- `liquidacion`: la escribe `fn_liquidar_sorteo` desde las líneas y no puede
-- quedar obsoleta, porque un sorteo liquidado ya no admite cambios.
-- ===========================================================================

create or replace function allan.fn_reporte_filas(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null,
  p_limite      integer  default 80,
  p_desde_fila  integer  default 0
) returns table (
  fecha          date,
  hora           allan.hora_sorteo,
  estado         allan.estado_sorteo,
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
set search_path = allan, public
as $$
  -- Liquidado: la fila ya existe, calculada desde las líneas.
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         lq.vendedor_id, v.nombre,
         lq.venta, lq.comision, lq.premios, lq.utilidad
  from allan.liquidacion lq
  join allan.sorteo s   on s.id = lq.sorteo_id
  join allan.vendedor v on v.id = lq.vendedor_id
  where s.fecha between p_desde and p_hasta
    and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora         = p_hora)
    and (p_numero      is null or s.numero_ganador = p_numero)

  union all

  -- Sin liquidar: se suma desde las líneas, que es lo único que hay. Comisión,
  -- premios y utilidad van en cero a propósito: de un sorteo abierto no se
  -- conocen, y ponerlos sería proyectar (§2).
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         t.vendedor_id, v.nombre,
         sum(l.monto), 0::numeric, 0::numeric, 0::numeric
  from allan.sorteo s
  join allan.ticket t   on t.sorteo_id = s.id and t.anulado_en is null
  join allan.linea  l   on l.ticket_id = t.id
  join allan.vendedor v on v.id = t.vendedor_id
  where s.fecha between p_desde and p_hasta
    and s.estado <> 'liquidado'
    and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
    and (p_hora        is null or s.hora        = p_hora)
    -- Un sorteo sin liquidar no tiene número ganador: si se filtra por número,
    -- por definición no puede aparecer.
    and p_numero is null
  group by s.fecha, s.hora, s.estado, s.numero_ganador, t.vendedor_id, v.nombre

  -- Fecha descendente pero hora ascendente dentro del día: lo más reciente
  -- arriba, y dentro de la jornada en el orden en que ocurrió.
  order by 1 desc, 2 asc, 6 asc
  limit p_limite offset p_desde_fila;
$$;

create or replace function allan.fn_reporte_totales(
  p_desde       date,
  p_hasta       date,
  p_vendedor_id uuid    default null,
  p_hora        allan.hora_sorteo default null,
  p_numero      smallint default null
) returns table (
  registros            integer,
  dias                 integer,
  venta                numeric,
  comision             numeric,
  premios              numeric,
  utilidad             numeric,
  venta_pendiente      numeric,
  registros_pendientes integer
)
language sql
stable
security invoker
set search_path = allan, public
as $$
  with liq as (
    select count(*)                         as registros,
           count(distinct s.fecha)          as dias,
           coalesce(sum(lq.venta), 0)       as venta,
           coalesce(sum(lq.comision), 0)    as comision,
           coalesce(sum(lq.premios), 0)     as premios,
           coalesce(sum(lq.utilidad), 0)    as utilidad
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
      and (p_hora        is null or s.hora         = p_hora)
      and (p_numero      is null or s.numero_ganador = p_numero)
  ),
  pend as (
    select count(*)                    as registros,
           count(distinct x.fecha)     as dias,
           coalesce(sum(x.venta), 0)   as venta
    from (
      select s.fecha, s.id, t.vendedor_id, sum(l.monto) as venta
      from allan.sorteo s
      join allan.ticket t on t.sorteo_id = s.id and t.anulado_en is null
      join allan.linea  l on l.ticket_id = t.id
      where s.fecha between p_desde and p_hasta
        and s.estado <> 'liquidado'
        and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id)
        and (p_hora        is null or s.hora        = p_hora)
        and p_numero is null
      group by s.fecha, s.id, t.vendedor_id
    ) x
  )
  select (liq.registros + pend.registros)::integer,
         -- Los días se cuentan sobre el conjunto, no sumando los dos: un mismo
         -- día puede tener sorteos liquidados y pendientes a la vez.
         (select count(distinct d)::integer from (
            select s.fecha as d
            from allan.sorteo s
            where s.fecha between p_desde and p_hasta
              and (p_hora is null or s.hora = p_hora)
              and exists (select 1 from allan.ticket t
                          where t.sorteo_id = s.id and t.anulado_en is null
                            and (p_vendedor_id is null or t.vendedor_id = p_vendedor_id))
          ) q),
         liq.venta + pend.venta,
         liq.comision,
         liq.premios,
         liq.utilidad,
         pend.venta,
         pend.registros::integer
  from liq, pend;
$$;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0030_cierre_un_minuto_antes.sql  <<<<<<<<<<<<<<<<<<<<

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

-- >>>>>>>>>>>>>>>>>>>>  migrations/0031_baja_de_vendedores.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Dar de baja a un vendedor, y que la baja le cierre la sesión.
--
-- `allan.vendedor.activo` existe desde 0001 con un comentario explícito —
-- «Baja lógica. Un vendedor nunca se borra» — y hasta hoy NINGUNA función,
-- acción ni pantalla la ponía en `false`. Era un contrato declarado y sin
-- implementar: seis consultas leen la columna, nadie la escribe.
--
-- DOS ESTADOS, NO UNO
-- -------------------
-- Inactivar es reversible (el vendedor se va unas semanas y vuelve). Eliminar
-- no lo es, pero tampoco borra: marca `eliminado_en` y saca al vendedor del
-- padrón para siempre. En ninguno de los dos casos se toca un ticket, una
-- línea ni una liquidación — el histórico tiene que seguir reconstruyendo el
-- pasado, y ahí es donde el vendedor sigue existiendo.
--
-- POR QUÉ LA SESIÓN NO SE CIERRA SOLA
-- -----------------------------------
-- La sesión es una cookie autofirmada con HMAC y doce horas de vigencia
-- (lib/sesion.ts). No hay almacén de sesiones en el servidor: poner
-- `usuario.activo = false` sólo impide el PRÓXIMO ingreso, y el vendedor
-- recién dado de baja podría seguir vendiendo media jornada. `fn_sesion_vigente`
-- es el gancho que faltaba: la aplicación la consulta al renderizar cada
-- página y antes de cada venta, y con eso la baja surte efecto en la siguiente
-- navegación.
-- ===========================================================================

alter table allan.vendedor add column if not exists eliminado_en timestamptz;

comment on column allan.vendedor.eliminado_en is
  'Baja definitiva. El vendedor sale del padrón pero su historial queda intacto: nunca se hace DELETE.';

create index if not exists vendedor_vigente
  on allan.vendedor (codigo) where eliminado_en is null;

-- --- Bajas y altas ---------------------------------------------------------

create or replace function allan.fn_desactivar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  if v_vendedor.eliminado_en is not null then
    raise exception 'Ese vendedor ya fue eliminado.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not v_vendedor.activo then
    return;   -- idempotente: inactivar dos veces no es un error
  end if;

  update allan.vendedor set activo = false where id = p_vendedor_id;
  update allan.usuario   set activo = false where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'inactivar', 'activo',
                           'true', 'false');
end;
$$;

create or replace function allan.fn_activar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- Eliminar es definitivo. Si hiciera falta recuperarlo, se da de alta uno
  -- nuevo: reactivar un código eliminado confundiría el histórico.
  if v_vendedor.eliminado_en is not null then
    raise exception 'Un vendedor eliminado no se puede reactivar. Cree uno nuevo.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_vendedor.activo then
    return;
  end if;

  update allan.vendedor set activo = true where id = p_vendedor_id;
  update allan.usuario   set activo = true where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'reactivar', 'activo',
                           'false', 'true');
end;
$$;

create or replace function allan.fn_eliminar_vendedor(
  p_vendedor_id uuid,
  p_usuario_id  uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_vendedor allan.vendedor%rowtype;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  select * into v_vendedor
  from allan.vendedor where id = p_vendedor_id
  for update;

  if not found then
    raise exception 'El vendedor % no existe.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  if v_vendedor.eliminado_en is not null then
    return;
  end if;

  update allan.vendedor
  set activo = false, eliminado_en = now()
  where id = p_vendedor_id;

  update allan.usuario set activo = false where vendedor_id = p_vendedor_id;

  perform allan.fn_auditar('vendedor', p_vendedor_id, 'eliminar', 'eliminado_en',
                           null, now()::text);
end;
$$;

comment on function allan.fn_eliminar_vendedor(uuid, uuid) is
  'Baja definitiva del padrón. No borra ni una fila de historial: tickets, líneas y liquidaciones siguen donde estaban.';

-- --- El gancho que cierra la sesión ----------------------------------------

create or replace function allan.fn_sesion_vigente(p_usuario_id uuid)
returns boolean
language sql
stable
security definer
set search_path = allan, public
as $$
  select exists (
    select 1
    from allan.usuario u
    left join allan.vendedor v on v.id = u.vendedor_id
    where u.id = p_usuario_id
      and u.activo
      and (u.vendedor_id is null or (v.activo and v.eliminado_en is null))
  );
$$;

comment on function allan.fn_sesion_vigente(uuid) is
  'Si la cuenta sigue sirviendo. La cookie de sesión es autofirmada y no se puede revocar: esto es lo que la invalida.';

-- --- Un efecto colateral que ahora estorba ---------------------------------
-- `fn_restablecer_contrasena` ponía `activo = true` de paso. Con las bajas ya
-- implementadas, restablecerle la clave a un vendedor dado de baja lo
-- resucitaría sin que nadie lo pidiera. La reactivación tiene su propia
-- función y su propio botón.

create or replace function allan.fn_restablecer_contrasena(
  p_usuario_id uuid,
  p_nueva      text
)
returns void
language plpgsql
security definer
set search_path = allan, public, extensions
as $$
begin
  if length(coalesce(p_nueva, '')) < 8 then
    raise exception 'La contraseña debe tener al menos 8 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;

  update allan.usuario
  set hash = crypt(p_nueva, gen_salt('bf', 10)),
      debe_cambiar = true
  where id = p_usuario_id;

  perform allan.fn_auditar('usuario', p_usuario_id, 'restablecer_contrasena', 'hash',
                           null, null);
end;
$$;

revoke execute on function allan.fn_desactivar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_activar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_eliminar_vendedor(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_sesion_vigente(uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_restablecer_contrasena(uuid, text)
  from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0032_liquidacion_semanal.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Liquidación semanal por vendedor, con pagos parciales.
--
-- `fn_liquidar_sorteo` ya deja una fila por (sorteo, vendedor) en
-- allan.liquidacion con venta, comisión, premios y utilidad. Lo que no existía
-- en ninguna parte es la marca de que a un vendedor YA SE LE PAGÓ un sorteo.
-- Sin ella, sacar el informe de la semana siguiente volvía a mostrar el lunes
-- que se cerró el martes, y sólo la memoria del administrador impedía pagarlo
-- dos veces.
--
-- EL GRANO ES LA LIQUIDACIÓN, NO LA FECHA
-- ---------------------------------------
-- Se podría haber guardado «pagado hasta el día X» y filtrar por fecha. No
-- sirve: un corte parcial real es «lunes y martes sí, miércoles todavía no» y
-- puede saltarse un sorteo suelto de en medio. allan.liquidacion ya es única
-- por (sorteo_id, vendedor_id), así que esa fila es la unidad natural de pago.
--
-- LA GARANTÍA LA DA LA BASE
-- -------------------------
-- `unique (liquidacion_id)` en corte_detalle es lo que hace imposible pagar
-- dos veces el mismo sorteo, incluso si dos administradores cargan el informe
-- a la vez y confirman ambos. El `not exists` de fn_liquidacion_pendiente es
-- comodidad de pantalla; la integridad es del índice.
-- ===========================================================================

create table if not exists allan.corte_vendedor (
  id          uuid primary key default gen_random_uuid(),
  vendedor_id uuid not null references allan.vendedor(id),
  desde       date not null,
  hasta       date not null,
  sorteos     integer not null,
  venta       numeric(14,2) not null,
  comision    numeric(14,2) not null,
  premios     numeric(14,2) not null,
  saldo       numeric(14,2) not null,
  nota        text,
  pagado_en   timestamptz not null default now(),
  usuario_id  uuid,

  constraint corte_rango_coherente check (hasta >= desde)
);

comment on table allan.corte_vendedor is
  'Un pago cerrado con un vendedor. desde/hasta son el rango que se consultó, no el criterio: lo pagado son las filas de corte_detalle.';

comment on column allan.corte_vendedor.saldo is
  'venta menos comision menos premios. Positivo: el vendedor entrega. Negativo: la casa le paga.';

create table if not exists allan.corte_detalle (
  corte_id       uuid not null references allan.corte_vendedor(id) on delete cascade,
  liquidacion_id uuid not null references allan.liquidacion(id),

  primary key (corte_id, liquidacion_id),
  unique (liquidacion_id)
);

comment on table allan.corte_detalle is
  'Qué liquidaciones entraron en cada corte. El unique de liquidacion_id es la regla entera del pago parcial: una liquidación se paga una sola vez.';

create index if not exists corte_vendedor_por_vendedor
  on allan.corte_vendedor (vendedor_id, pagado_en desc);

alter table allan.corte_vendedor enable row level security;
alter table allan.corte_detalle  enable row level security;
-- Sin políticas: estas dos tablas no se leen nunca desde un cliente.

-- --- Lo que queda por pagar ------------------------------------------------

create or replace function allan.fn_liquidacion_pendiente(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_liquidacion_id uuid,
  r_sorteo_id      uuid,
  r_fecha          date,
  r_hora           allan.hora_sorteo,
  r_numero_ganador smallint,
  r_venta          numeric,
  r_comision       numeric,
  r_premios        numeric,
  r_saldo          numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select lq.id,
         s.id,
         s.fecha,
         s.hora,
         s.numero_ganador,
         lq.venta,
         lq.comision,
         lq.premios,
         lq.utilidad
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  where lq.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
    and not exists (
      select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
    )
  order by s.fecha, s.hora;
$$;

comment on function allan.fn_liquidacion_pendiente(uuid, date, date) is
  'Sorteos ya liquidados del rango que todavia no se le han pagado al vendedor.';

-- --- El pago ---------------------------------------------------------------

create or replace function allan.fn_registrar_corte(
  p_vendedor_id     uuid,
  p_liquidacion_ids uuid[],
  p_desde           date,
  p_hasta           date,
  p_nota            text default null,
  p_usuario_id      uuid default null
) returns table (
  r_corte_id uuid,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_saldo    numeric
)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_corte_id uuid := gen_random_uuid();
  v_ajenas   integer;
  v_sorteos  integer;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  if p_liquidacion_ids is null or array_length(p_liquidacion_ids, 1) is null then
    raise exception 'No se eligió ningún sorteo para pagar.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se bloquean antes de sumarlas: si otra transacción está registrando un
  -- corte con alguna de ellas, ésta espera y luego choca contra el índice
  -- único, en vez de sumar sobre un dato que ya cambió debajo.
  perform 1
  from allan.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
  order by lq.id
  for update;

  -- Ninguna liquidación ajena se cuela en el corte de otro vendedor.
  select count(*) into v_ajenas
  from allan.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
    and lq.vendedor_id is distinct from p_vendedor_id;

  if v_ajenas > 0 then
    raise exception 'El corte incluye % liquidaciones de otro vendedor.', v_ajenas
      using errcode = 'invalid_parameter_value';
  end if;

  -- Los totales SIEMPRE se recalculan aquí. Lo que manda el navegador es una
  -- vista previa, no un dato: si llegara alterado, el corte guardaría una
  -- cifra que no corresponde a ningún sorteo.
  select count(*),
         coalesce(sum(lq.venta), 0),
         coalesce(sum(lq.comision), 0),
         coalesce(sum(lq.premios), 0)
    into v_sorteos, v_venta, v_comision, v_premios
  from allan.liquidacion lq
  where lq.id = any (p_liquidacion_ids);

  if v_sorteos <> array_length(p_liquidacion_ids, 1) then
    raise exception 'Alguna de las liquidaciones elegidas ya no existe.'
      using errcode = 'no_data_found';
  end if;

  insert into allan.corte_vendedor (
    id, vendedor_id, desde, hasta, sorteos, venta, comision, premios, saldo,
    nota, usuario_id
  ) values (
    v_corte_id, p_vendedor_id, p_desde, p_hasta, v_sorteos,
    v_venta, v_comision, v_premios, v_venta - v_comision - v_premios,
    nullif(trim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  begin
    insert into allan.corte_detalle (corte_id, liquidacion_id)
    select v_corte_id, unnest(p_liquidacion_ids);
  exception when unique_violation then
    raise exception 'Uno de los sorteos elegidos ya se había pagado. Vuelva a cargar el informe.'
      using errcode = 'check_violation';
  end;

  perform allan.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'saldo',
                           null, (v_venta - v_comision - v_premios)::text);

  return query
    select v_corte_id, v_sorteos, v_venta, v_comision, v_premios,
           v_venta - v_comision - v_premios;
end;
$$;

comment on function allan.fn_registrar_corte(uuid, uuid[], date, date, text, uuid) is
  'Cierra el pago de un conjunto de liquidaciones. Recalcula los totales desde la base; no acepta los del cliente.';

-- --- Historial -------------------------------------------------------------

create or replace function allan.fn_cortes_vendedor(
  p_vendedor_id uuid,
  p_limite      integer default 20
) returns table (
  r_corte_id  uuid,
  r_desde     date,
  r_hasta     date,
  r_sorteos   integer,
  r_venta     numeric,
  r_comision  numeric,
  r_premios   numeric,
  r_saldo     numeric,
  r_nota      text,
  r_pagado_en timestamptz
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select c.id, c.desde, c.hasta, c.sorteos, c.venta, c.comision, c.premios,
         c.saldo, c.nota, c.pagado_en
  from allan.corte_vendedor c
  where c.vendedor_id = p_vendedor_id
  order by c.pagado_en desc
  limit greatest(p_limite, 1);
$$;

comment on function allan.fn_cortes_vendedor(uuid, integer) is
  'Cortes ya pagados a un vendedor, del más reciente al más antiguo.';

-- --- Vendedores con saldo sin pagar ----------------------------------------
-- El selector del módulo NO puede filtrar por `activo`: a un vendedor dado de
-- baja con saldo pendiente hay que poder pagarle. Esta función devuelve el
-- padrón que corresponde: los activos, más los inactivos que aún deben cuentas.

create or replace function allan.fn_vendedores_liquidables()
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_activo      boolean,
  r_eliminado   boolean,
  r_pendientes  integer
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select v.id,
         v.codigo,
         v.nombre,
         v.activo,
         v.eliminado_en is not null,
         coalesce(p.pendientes, 0)::integer
  from allan.vendedor v
  left join (
    select lq.vendedor_id, count(*) as pendientes
    from allan.liquidacion lq
    where not exists (
      select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
    )
    group by lq.vendedor_id
  ) p on p.vendedor_id = v.id
  where v.activo or coalesce(p.pendientes, 0) > 0
  order by v.codigo;
$$;

comment on function allan.fn_vendedores_liquidables() is
  'Padrón del módulo de liquidación: los activos, más los de baja que todavía tienen sorteos sin pagar.';

revoke execute on function allan.fn_liquidacion_pendiente(uuid, date, date)
  from public, anon, authenticated;
revoke execute on function allan.fn_registrar_corte(uuid, uuid[], date, date, text, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_cortes_vendedor(uuid, integer)
  from public, anon, authenticated;
revoke execute on function allan.fn_vendedores_liquidables()
  from public, anon, authenticated;

analyze allan.liquidacion;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0033_venta_de_administracion_y_tanda.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Dos cosas que el punto de venta necesitaba de la base.
--
-- 1. VENTA DESPUÉS DEL CIERRE, SÓLO PARA ADMINISTRACIÓN
--    Una apuesta rezagada llega, y hoy no hay forma de meterla: la venta se
--    corta al segundo y el rechazo es el mismo para el vendedor que para el
--    dueño. Se abre una puerta explícita, `p_forzar`, y se deja rastro de por
--    dónde entró: `ticket.forzado`, `creado_por` de verdad y auditoría aparte.
--
--    LA BASE NO SABE QUIÉN LLAMA. Desde 0024 la aplicación habla como
--    `service_role`, así que `fn_es_servicio()` es `true` en toda petición y
--    `fn_exige` retorna sin comprobar nada. Por eso `p_forzar` es un parámetro
--    y no una consulta de rol: quien decide es la Server Action, que sí tiene
--    la sesión delante. El navegador nunca manda esta bandera.
--
--    SOBRE UN SORTEO YA LIQUIDADO hay que reconciliar o el sorteo deja de
--    cuadrar: las líneas nuevas no estarían marcadas como ganadoras y la fila
--    de allan.liquidacion se quedaría con el total viejo. De ahí
--    `fn_recalcular_liquidacion`. Y si ese sorteo YA SE LE PAGÓ al vendedor en
--    un corte, no se admite venta ninguna: el monto pagado dejaría de
--    corresponder con lo liquidado y no habría forma de cuadrarlo hacia atrás.
--
-- 2. TANDA DE TICKETS
--    El vendedor de calle atiende una cola: cuatro personas, cuatro tickets,
--    una sola confirmación al final. Registrarlos uno a uno desde el navegador
--    deja la puerta abierta a que el tercero entre y el cuarto no, y a que el
--    vendedor no sepa cuál falló. Una función plpgsql ES una transacción: o
--    entra la tanda entera o no entra ninguno.
--
--    EL PREBLOQUEO NO ES ADORNO. `fn_registrar_ticket` ordena sus números de
--    forma ascendente dentro de cada ticket, lo que basta para una venta
--    suelta. Pero una tanda [[5],[3]] bloquearía el 5 y luego el 3, mientras
--    otra tanda simultánea [[3],[5]] haría lo contrario: interbloqueo. Tomar
--    de golpe, en orden, todos los números de la tanda antes del bucle lo
--    elimina.
-- ===========================================================================

alter table allan.ticket add column if not exists forzado boolean not null default false;

comment on column allan.ticket.forzado is
  'Registrado por administración con la venta ya cerrada. Se audita aparte y se distingue en pantalla.';

create index if not exists ticket_forzado on allan.ticket (sorteo_id) where forzado;

-- --- Reconciliar un sorteo liquidado ---------------------------------------

create or replace function allan.fn_recalcular_liquidacion(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo   allan.sorteo%rowtype;
  v_pagada   boolean;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
begin
  select * into v_sorteo from allan.sorteo where id = p_sorteo_id;

  if not found or v_sorteo.estado <> 'liquidado' then
    return;   -- no hay nada que reconciliar
  end if;

  -- Lo ya pagado no se toca. Si se admitiera, el corte que el vendedor firmó
  -- dejaría de coincidir con lo que dice la liquidación, y no hay manera
  -- honesta de arreglarlo después.
  select exists (
    select 1
    from allan.liquidacion lq
    join allan.corte_detalle d on d.liquidacion_id = lq.id
    where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id
  ) into v_pagada;

  if v_pagada then
    raise exception 'Ese sorteo ya se le pagó al vendedor; no admite más venta.'
      using errcode = 'check_violation';
  end if;

  -- Las líneas nuevas que acertaron, con el factor congelado de cada una.
  update allan.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null
    and l.numero = v_sorteo.numero_ganador
    and not l.gana;

  select coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0)
    into v_venta, v_comision, v_premios
  from allan.linea l
  join allan.ticket t on t.id = l.ticket_id
  where t.sorteo_id = p_sorteo_id
    and t.vendedor_id = p_vendedor_id
    and t.anulado_en is null;

  insert into allan.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios,
    v_venta - v_comision - v_premios
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;

  perform allan.fn_auditar('liquidacion', p_sorteo_id, 'recalcular', 'venta',
                           null, v_venta::text);
end;
$$;

comment on function allan.fn_recalcular_liquidacion(uuid, uuid) is
  'Rehace la liquidación de un vendedor en un sorteo ya liquidado. Rechaza si ese sorteo ya entró en un corte pagado.';

-- --- La venta ---------------------------------------------------------------
-- La firma cambia, así que hay que soltar la anterior: dejar las dos vivas
-- haría ambigua la llamada de ocho argumentos de fn_validar_lote_ocr.

drop function if exists allan.fn_registrar_ticket(
  uuid, uuid, jsonb, double precision, double precision, uuid,
  allan.canal_ticket, uuid
);

create or replace function allan.fn_registrar_ticket(
  p_sorteo_id      uuid,
  p_vendedor_id    uuid,
  p_lineas         jsonb,
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_dispositivo_id uuid default null,
  p_canal          allan.canal_ticket default 'movil',
  p_lote_ocr_id    uuid default null,
  p_forzar         boolean default false,
  p_usuario_id     uuid default null
) returns table (ticket_id uuid, ticket_folio text, ticket_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo        allan.sorteo%rowtype;
  v_codigo        text;
  v_param         allan.parametro_vendedor%rowtype;
  v_ticket_id     uuid;
  v_folio         text;
  v_total         numeric(14,2);
  v_consecutivo   integer;
  v_agrupada      record;
  v_cupo          allan.cupo_numero%rowtype;
  v_vendido_prop  numeric(14,2);
  v_disp_casa     numeric(14,2);
  v_disp_vendedor numeric(14,2);
  v_disp_cuota    numeric(14,2);
begin
  -- Un vendedor sólo registra ventas a su propio nombre. Administración y
  -- digitación pueden hacerlo por cualquiera (la digitalización crea tickets
  -- de la hoja de otro vendedor).
  if not allan.fn_es_servicio() then
    if allan.fn_rol_actual() = 'vendedor'
       and p_vendedor_id is distinct from allan.fn_vendedor_actual() then
      raise exception 'No puede registrar ventas a nombre de otro vendedor.'
        using errcode = 'insufficient_privilege';
    end if;
    perform allan.fn_exige(array['vendedor','digitador','administrador']::allan.rol_usuario[]);
  end if;

  -- 1. El sorteo debe estar abierto. FOR SHARE impide que lo cierren o
  --    liquiden mientras esta venta está en vuelo, sin serializar entre sí
  --    las ventas concurrentes del mismo sorteo.
  select * into v_sorteo
  from allan.sorteo where id = p_sorteo_id
  for share;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  -- Un sorteo `programado` no tiene cupo sembrado: forzarlo fallaría más
  -- abajo con un mensaje que no explica nada.
  if v_sorteo.estado = 'programado' then
    raise exception 'El sorteo todavía no ha abierto.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Los dos cortes —el de estado y el de hora— sólo se levantan con p_forzar,
  -- que la Server Action pone a `true` únicamente para un administrador.
  if not p_forzar then
    if v_sorteo.estado <> 'abierto' then
      raise exception 'El sorteo no admite ventas: está %.', v_sorteo.estado
        using errcode = 'invalid_parameter_value';
    end if;

    if now() >= v_sorteo.hora_cierre then
      raise exception 'La venta de este sorteo cerró a las % (hora de Honduras).',
        to_char(v_sorteo.hora_cierre at time zone 'America/Tegucigalpa', 'HH12:MI AM')
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if p_lineas is null or jsonb_array_length(p_lineas) = 0 then
    raise exception 'El ticket no tiene líneas.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 2. Bloqueo del vendedor: serializa la generación de folio y fija el orden
  --    de bloqueo antes de tocar las filas de cupo.
  select codigo into v_codigo
  from allan.vendedor where id = p_vendedor_id and activo
  for update;

  if not found then
    raise exception 'El vendedor % no existe o está inactivo.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 3. Parámetros VIGENTES. Se copian a cada línea: a partir de aquí, cambiar
  --    la configuración del vendedor no altera este ticket.
  select * into v_param
  from allan.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null;

  if not found then
    raise exception 'El vendedor % no tiene parámetros vigentes.', p_vendedor_id
      using errcode = 'no_data_found';
  end if;

  -- 4. Recorrido por número, en orden ascendente para evitar interbloqueos.
  --    Se agrupa primero: un mismo ticket puede repetir un número y debe
  --    contar como una sola exposición.
  for v_agrupada in
    select (linea->>'numero')::smallint as numero,
           sum((linea->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) as linea
    group by 1
    order by 1
  loop
    if v_agrupada.numero < 0 or v_agrupada.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    if v_agrupada.monto <= 0 then
      raise exception 'Monto no válido en el número %.', v_agrupada.numero
        using errcode = 'invalid_parameter_value';
    end if;

    -- 4a. Bloqueo de la fila de cupo. Éste es el punto de serialización.
    select * into v_cupo
    from allan.cupo_numero
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero
    for update;

    if not found then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_agrupada.numero
        using errcode = 'no_data_found';
    end if;

    v_disp_casa := v_cupo.limite_casa - v_cupo.vendido;

    -- 4b. Lo ya vendido por ESTE vendedor en ESTE número (tickets vigentes).
    select coalesce(sum(l.monto), 0) into v_vendido_prop
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_agrupada.numero;

    v_disp_vendedor := v_param.tope_por_numero - v_vendido_prop;

    -- 4c. Ambos niveles deben cumplirse; gobierna el más restrictivo.
    if v_agrupada.monto > v_disp_vendedor then
      raise exception 'Cupo del vendedor agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_vendedor, 0)
        using errcode = 'check_violation';
    end if;

    if v_agrupada.monto > v_disp_casa then
      raise exception 'Cupo de la casa agotado en el %: disponible %.',
        lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_casa, 0)
        using errcode = 'check_violation';
    end if;

    -- 4d. Si la venta viene de un dispositivo con cuota reservada, descontarla.
    if p_dispositivo_id is not null then
      select asignado - consumido into v_disp_cuota
      from allan.cuota_dispositivo
      where sorteo_id = p_sorteo_id
        and dispositivo_id = p_dispositivo_id
        and numero = v_agrupada.numero
      for update;

      if found then
        if v_agrupada.monto > v_disp_cuota then
          raise exception 'Cuota del dispositivo agotada en el %: disponible %.',
            lpad(v_agrupada.numero::text, 2, '0'), greatest(v_disp_cuota, 0)
            using errcode = 'check_violation';
        end if;

        update allan.cuota_dispositivo
        set consumido = consumido + v_agrupada.monto
        where sorteo_id = p_sorteo_id
          and dispositivo_id = p_dispositivo_id
          and numero = v_agrupada.numero;
      end if;
    end if;

    update allan.cupo_numero
    set vendido = vendido + v_agrupada.monto
    where sorteo_id = p_sorteo_id and numero = v_agrupada.numero;
  end loop;

  -- 5. Folio: V901-20990101-0001, consecutivo por vendedor y día. El bloqueo
  --    del paso 2 garantiza que no se repita.
  select count(*) + 1 into v_consecutivo
  from allan.ticket t
  join allan.sorteo s on s.id = t.sorteo_id
  where t.vendedor_id = p_vendedor_id and s.fecha = v_sorteo.fecha;

  v_folio := replace(v_codigo, '-', '')
             || '-' || to_char(v_sorteo.fecha, 'YYYYMMDD')
             || '-' || lpad(v_consecutivo::text, 4, '0');

  select sum((linea->>'monto')::numeric) into v_total
  from jsonb_array_elements(p_lineas) as linea;

  -- El id se genera aquí en vez de recuperarlo con RETURNING: así no hay
  -- ninguna referencia a la columna `id` dentro del cuerpo de la función.
  v_ticket_id := gen_random_uuid();

  insert into allan.ticket (
    id, folio, sorteo_id, vendedor_id, canal, total, creado_por,
    lat, lng, dispositivo_id, lote_ocr_id, forzado
  ) values (
    v_ticket_id, v_folio, p_sorteo_id, p_vendedor_id, p_canal, v_total,
    coalesce(p_usuario_id, auth.uid()),
    p_lat, p_lng, p_dispositivo_id, p_lote_ocr_id, p_forzar
  );

  -- 6. Las líneas, cada una con sus parámetros congelados.
  insert into allan.linea (ticket_id, numero, monto, comision_congelada, factor_congelado)
  select v_ticket_id,
         (linea->>'numero')::smallint,
         (linea->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) as linea;

  perform allan.fn_auditar('ticket', v_ticket_id, 'crear', 'folio', null, v_folio);

  if p_forzar then
    perform allan.fn_auditar('ticket', v_ticket_id, 'registrar_forzado', 'usuario',
                             v_sorteo.estado::text, coalesce(p_usuario_id::text, 'desconocido'));

    -- Sobre un sorteo ya liquidado, el ticket nuevo obliga a rehacer las
    -- cuentas de ese vendedor o el sorteo deja de cuadrar.
    if v_sorteo.estado = 'liquidado' then
      perform allan.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
    end if;
  end if;

  return query select v_ticket_id, v_folio, v_total;
end;
$$;

comment on function allan.fn_registrar_ticket(uuid, uuid, jsonb, double precision, double precision, uuid, allan.canal_ticket, uuid, boolean, uuid) is
  'Registra una venta. p_forzar levanta el corte por estado y por hora, y sólo lo pone a true la Server Action para un administrador.';

-- --- La tanda ---------------------------------------------------------------

create or replace function allan.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null
) returns table (r_folio text, r_total numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_cuantos integer;
  v_lineas  jsonb;
  v_res     record;
begin
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_cuantos := jsonb_array_length(p_tickets);

  if v_cuantos = 0 then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Tope de cordura. Una tanda de calle son cuatro o cinco tickets; cincuenta
  -- ya es un envío que conviene mirar antes de dejarlo pasar entero.
  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  -- Prebloqueo de TODOS los números de la tanda, en orden ascendente. Sin
  -- esto, dos tandas con los mismos números en distinto orden se interbloquean
  -- entre sí: cada fn_registrar_ticket ordena lo suyo, pero nadie ordena el
  -- conjunto.
  perform 1
  from allan.cupo_numero c
  where c.sorteo_id = p_sorteo_id
    and c.numero in (
      select distinct (linea->>'numero')::smallint
      from jsonb_array_elements(p_tickets) as ticket,
           jsonb_array_elements(ticket) as linea
    )
  order by c.numero
  for update;

  for v_lineas in select * from jsonb_array_elements(p_tickets)
  loop
    select * into v_res
    from allan.fn_registrar_ticket(
      p_sorteo_id, p_vendedor_id, v_lineas,
      p_lat, p_lng, null,
      'movil'::allan.canal_ticket, null,
      p_forzar, p_usuario_id
    );

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;
    return next;
  end loop;

  return;
end;
$$;

comment on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid) is
  'Registra varios tickets en una sola transacción: o entran todos o no entra ninguno. Prebloquea los números de la tanda para no interbloquearse con otra.';

revoke execute on function allan.fn_recalcular_liquidacion(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0034_reporte_del_vendedor.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El vendedor puede ver su propio período, no sólo el día de hoy.
--
-- `fn_mi_dia` contesta «¿cómo voy hoy?» y para eso está bien. Pero la pregunta
-- que trae un vendedor a la oficina es otra: «¿cuánto me deben de la semana?»,
-- y para responderla había que abrir el portal siete veces, una por día, o
-- pedirle el dato a administración.
--
-- QUÉ ES «EL TOTAL» AQUÍ
-- ----------------------
-- Comisión más premios: lo que la casa le devuelve. El vendedor cobra la venta
-- en la calle y paga los premios de su bolsillo, así que esas dos cifras son
-- las suyas; la venta bruta es el movimiento, no su dinero.
--
-- Ojo con la simetría: el módulo de liquidación del administrador enseña el
-- SALDO (venta − comisión − premios), que es lo que el vendedor entrega. Son
-- las dos caras de la misma cuenta y ninguna contradice a la otra, pero no son
-- el mismo número y las pantallas lo rotulan de forma distinta a propósito.
--
-- POR QUÉ TRAE `r_pagado`
-- -----------------------
-- Para que el vendedor no tenga que preguntar si ya le cubrieron el lunes. El
-- dato ya existe —lo escribe `fn_registrar_corte`— y sin él la pantalla
-- muestra una deuda que puede llevar días saldada.
--
-- El filtro por vendedor va en el PARÁMETRO, no en la sesión: esta función es
-- `security definer` y la aplicación la llama con el id que saca de la cookie
-- firmada, nunca con uno que venga de la petición.
-- ===========================================================================

create or replace function allan.fn_mi_periodo(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_fecha    date,
  r_hora     allan.hora_sorteo,
  r_estado   allan.estado_sorteo,
  r_ganador  smallint,
  r_tickets  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_pagado   boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.fecha,
         s.hora,
         s.estado,
         s.numero_ganador,
         count(distinct t.id)::integer,
         coalesce(sum(l.monto), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0),
         exists (
           select 1
           from allan.liquidacion lq
           join allan.corte_detalle d on d.liquidacion_id = lq.id
           where lq.sorteo_id = s.id and lq.vendedor_id = p_vendedor_id
         )
  -- LEFT JOIN y no INNER: un sorteo en el que este vendedor no vendió nada
  -- tiene que salir igual, en cero. Si desapareciera, la rejilla del día
  -- perdería una fila y parecería que ese sorteo no existió.
  from allan.sorteo s
  left join allan.ticket t
    on t.sorteo_id = s.id
   and t.vendedor_id = p_vendedor_id
   and t.anulado_en is null
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha between p_desde and p_hasta
  group by s.id, s.fecha, s.hora, s.estado, s.numero_ganador
  order by s.fecha, s.hora;
$$;

comment on function allan.fn_mi_periodo(uuid, date, date) is
  'Rejilla día × sorteo de UN vendedor en un rango, con la marca de si ya se le pagó.';

revoke execute on function allan.fn_mi_periodo(uuid, date, date)
  from public, anon, authenticated;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0035_tanda_devuelve_la_hora.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- La tanda devuelve la hora en que quedó registrada.
--
-- El ticket impreso lleva la hora de emisión, y esa hora tiene que ser la que
-- guarda `allan.ticket.creado_en`, no la del reloj del dispositivo. Un
-- handheld barato se desfasa, y si el papel dice una hora y la base dice otra,
-- un reclamo —«yo compré antes del cierre»— no se puede resolver: no habría
-- forma de saber cuál de las dos mentía.
--
-- Se cambia el tipo de retorno, así que `create or replace` no basta: hay que
-- soltar la función y volver a crearla.
-- ===========================================================================

drop function if exists allan.fn_registrar_tanda(
  uuid, uuid, jsonb, double precision, double precision, boolean, uuid
);

create or replace function allan.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null
) returns table (r_folio text, r_total numeric, r_creado_en timestamptz)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_cuantos integer;
  v_lineas  jsonb;
  v_res     record;
begin
  if p_tickets is null or jsonb_typeof(p_tickets) <> 'array' then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_cuantos := jsonb_array_length(p_tickets);

  if v_cuantos = 0 then
    raise exception 'La tanda no trae tickets.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Tope de cordura. Una tanda es lo que compra UNA persona; cincuenta tickets
  -- ya es un envío que conviene mirar antes de dejarlo pasar entero.
  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  -- Prebloqueo de TODOS los números de la tanda, en orden ascendente. Sin
  -- esto, dos tandas con los mismos números en distinto orden se interbloquean
  -- entre sí: cada fn_registrar_ticket ordena lo suyo, pero nadie ordena el
  -- conjunto.
  perform 1
  from allan.cupo_numero c
  where c.sorteo_id = p_sorteo_id
    and c.numero in (
      select distinct (linea->>'numero')::smallint
      from jsonb_array_elements(p_tickets) as ticket,
           jsonb_array_elements(ticket) as linea
    )
  order by c.numero
  for update;

  for v_lineas in select * from jsonb_array_elements(p_tickets)
  loop
    select * into v_res
    from allan.fn_registrar_ticket(
      p_sorteo_id, p_vendedor_id, v_lineas,
      p_lat, p_lng, null,
      'movil'::allan.canal_ticket, null,
      p_forzar, p_usuario_id
    );

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;

    -- La hora que quedó escrita, no `now()`: son iguales dentro de la
    -- transacción, pero lo que debe viajar al papel es el dato guardado.
    select t.creado_en into r_creado_en
    from allan.ticket t where t.id = v_res.ticket_id;

    return next;
  end loop;

  return;
end;
$$;

comment on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid) is
  'Registra varios tickets en una sola transacción: o entran todos o no entra ninguno. Devuelve folio, total y hora de emisión de cada uno, que es lo que se imprime.';

revoke execute on function allan.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0036_informe_de_gerencia.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El informe que el gerente mira todos los días.
--
-- Hasta ahora vivía en una hoja de cálculo —«032 SEMANA 01 DE AGOSTO DE
-- 2026.xlsx», pestaña DASHBOARD— con una fila por vendedor y una columna por
-- cada paso de la cuenta. Esta función devuelve exactamente esas columnas para
-- cualquier rango: un día, una semana o un mes.
--
-- LA CUENTA DE LA HOJA, COMPROBADA CONTRA LA BASE
-- ----------------------------------------------
--   comisión    = venta × porcentaje
--   total bruto = venta − comisión
--   total neto  = total bruto − pago premiado
--
-- Es, término a término, lo que ya guarda allan.liquidacion: venta, comision,
-- premios y utilidad = venta − comision − premios. O sea que el «total neto»
-- de la hoja es la utilidad de siempre. No hay cuenta nueva que inventar; lo
-- que falta es el desglose que la hoja enseña y la liquidación no guarda.
--
-- Se comprobó fila a fila contra la hoja. M. CAROL: venta 82.090, comisión al
-- 20 % son 16.418, bruto 65.672; premiado 1.155 al factor 70 son 80.850 de
-- pago; neto 65.672 − 80.850 = −15.178, que es lo que dice la casilla.
--
-- LO QUE NO ESTABA GUARDADO: «PREMIADO»
-- -------------------------------------
-- La hoja separa lo APOSTADO al número ganador («Premiado») de lo PAGADO por
-- él («Pago premiado» = premiado × factor). La liquidación sólo guarda lo
-- segundo. Se recupera sumando el monto de las líneas ganadoras, que son una
-- de cada cien: el índice parcial `linea_ganadoras` está para eso.
--
-- SALE TODO EL PADRÓN, TAMBIÉN QUIEN NO VENDIÓ
-- --------------------------------------------
-- La hoja lista a los ciento cinco vendedores tenga cada uno movimiento o no,
-- y con razón: un vendedor en cero es una noticia. Si se parte de las
-- liquidaciones, ése desaparece sin dejar rastro — la peor forma de no
-- aparecer, porque no se distingue de no existir. Se parte del padrón.
--
-- Quien esté dado de baja pero haya vendido en el rango también sale: si movió
-- dinero esa semana, tiene que estar en las cuentas de esa semana. Filtrar la
-- tabla es cosa de la pantalla, no de aquí.
--
-- COLUMNAS QUE NO SE TRAEN
-- ------------------------
-- «Regalado» y «Pago regalado» quedan fuera por decisión del negocio: ya no se
-- usan. «Pasados» sale en cero en las ciento cinco filas de la hoja, así que
-- una columna de ceros no aporta nada. Si algún día vuelven, vuelven aquí.
--
-- EL NETO SE RESTA AQUÍ, NO SE SUMA DE `utilidad`
-- -----------------------------------------------
-- `fn_liquidar_sorteo` guarda venta, comisión, premios y utilidad en cuatro
-- columnas numeric(14,2), y redondea CADA UNA por separado; la utilidad se
-- calcula antes de redondear. Así que round(V) − round(C) − round(P) no
-- siempre es round(V − C − P): se separan hasta un céntimo por liquidación.
--
-- Medido sobre una semana del histórico: 22 de 630 filas difieren, la peor en
-- L 0.01, y acumulando por vendedor la mayor separación es de L 0.07.
--
-- Da igual para un total, pero no para este informe: el gerente lo comprueba
-- con calculadora, y una fila donde venta − comisión − premios no da el neto
-- que está escrito al lado destruye la confianza en toda la tabla. Por eso el
-- neto se resta de las tres columnas que se enseñan, y la fila cuadra siempre.
--
-- FACTOR Y PORCENTAJE SON EFECTIVOS, NO NOMINALES
-- -----------------------------------------------
-- En la hoja son constantes por vendedor porque la hoja es de una semana. En
-- un rango cualquiera un vendedor pudo cambiar de parámetros —cada línea
-- lleva congelados los suyos—, así que aquí se devuelve lo que de verdad
-- ocurrió: el factor es pago÷premiado y el porcentaje es comisión÷venta. Con
-- parámetros estables dan el mismo 70 y el mismo 0.20 de la hoja.
-- ===========================================================================

create or replace function allan.fn_informe_gerencia(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_venta        numeric,
  r_premiado     numeric,
  r_factor       numeric,
  r_pago         numeric,
  r_porcentaje   numeric,
  r_comision     numeric,
  r_bruto        numeric,
  r_neto         numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  -- Lo apostado al número que salió. Son una de cada cien líneas, y el índice
  -- parcial `linea_ganadoras` cubre justo esta condición.
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: la hoja lista a todo el
  -- mundo, y un vendedor que no vendió nada en la semana es justo lo que el
  -- gerente quiere ver. Con un `join` desde liquidacion desaparecía sin dejar
  -- rastro, que es la peor forma de no aparecer.
  select v.id,
         v.codigo,
         v.nombre,
         coalesce(q.venta, 0),
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada.
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         coalesce(q.premios, 0),
         case when coalesce(q.venta, 0) > 0
              then round(q.comision / q.venta, 4) else 0 end,
         coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0),
         -- El neto sale de restar lo que se enseña, no de sumar `utilidad`.
         -- Ver la nota de la cabecera sobre el céntimo de redondeo.
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado a on a.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera que haya vendido en el rango aunque
  -- después se le diera de baja: si movió dinero esa semana, tiene que salir.
  where v.activo or q.venta is not null
  -- De mayor a menor venta: el gerente mira primero quién mueve más, y los que
  -- no movieron nada caen solos al final.
  order by coalesce(q.venta, 0) desc, v.codigo;
$$;

comment on function allan.fn_informe_gerencia(date, date) is
  'El informe de gerencia, una fila por vendedor: venta, premiado, factor, pago, comisión, bruto y neto. Sólo sorteos liquidados.';

revoke execute on function allan.fn_informe_gerencia(date, date)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0037_informe_por_loteria.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El informe de gerencia, sorteo a sorteo.
--
-- El gerente mira el rango completo y enseguida quiere bajar: «¿y el martes?»,
-- «¿y sólo la de las once?». El día ya se podía estrechar por fuera —un día es
-- un rango de un día— pero la lotería no: hacía falta un filtro más.
--
-- Se cambia la firma, así que hay que soltar la función y volver a crearla.
-- Dejar las dos vivas haría ambigua cualquier llamada de dos argumentos.
--
-- `p_hora` en nulo significa las tres, que es el comportamiento de antes: la
-- llamada de dos argumentos sigue devolviendo exactamente lo mismo.
-- ===========================================================================

drop function if exists allan.fn_informe_gerencia(date, date);

create or replace function allan.fn_informe_gerencia(
  p_desde date,
  p_hasta date,
  p_hora  allan.hora_sorteo default null
) returns table (
  r_vendedor_id  uuid,
  r_codigo       text,
  r_nombre       text,
  r_venta        numeric,
  r_premiado     numeric,
  r_factor       numeric,
  r_pago         numeric,
  r_porcentaje   numeric,
  r_comision     numeric,
  r_bruto        numeric,
  r_neto         numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
    group by lq.vendedor_id
  ),
  -- Lo apostado al número que salió. Son una de cada cien líneas, y el índice
  -- parcial `linea_ganadoras` cubre justo esta condición.
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: la hoja lista a todo el
  -- mundo, y un vendedor que no vendió nada es justo lo que el gerente quiere
  -- ver. Con un `join` desde liquidacion desaparecía sin dejar rastro, que es
  -- la peor forma de no aparecer.
  select v.id,
         v.codigo,
         v.nombre,
         coalesce(q.venta, 0),
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada.
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         coalesce(q.premios, 0),
         case when coalesce(q.venta, 0) > 0
              then round(q.comision / q.venta, 4) else 0 end,
         coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0),
         -- El neto sale de restar lo que se enseña, no de sumar `utilidad`:
         -- las cuatro columnas se redondean por separado al liquidar y se
         -- separan hasta un céntimo. Ver la cabecera de la 0036.
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado a on a.vendedor_id = v.id
  -- Los del padrón vigente, MÁS cualquiera que haya vendido en el rango aunque
  -- después se le diera de baja: si movió dinero, tiene que salir.
  where v.activo or q.venta is not null
  -- De mayor a menor venta: el gerente mira primero quién mueve más, y los que
  -- no movieron nada caen solos al final.
  order by coalesce(q.venta, 0) desc, v.codigo;
$$;

comment on function allan.fn_informe_gerencia(date, date, allan.hora_sorteo) is
  'El informe de gerencia, una fila por vendedor. Con p_hora en nulo suma las tres loterías; con una hora, sólo ésa.';

revoke execute on function allan.fn_informe_gerencia(date, date, allan.hora_sorteo)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0038_analisis_de_resultados.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Análisis de resultados: el mismo corte, al grano que se pida.
--
-- Las tarjetas mes por mes del simulador son la forma en que este negocio lee
-- un resultado: venta, comisiones, premios, utilidad y margen, una tarjeta por
-- período. Pero allí sirven para comparar un escenario inventado contra lo
-- real, y lo que hacía falta era mirar lo real y ya — de una semana día por
-- día, de un mes semana por semana, de un año mes por mes.
--
-- POR QUÉ UNA FUNCIÓN Y NO CUATRO
-- -------------------------------
-- El corte cambia sólo en cómo se agrupa la fecha. `date_trunc` hace las
-- cuatro con el mismo cuerpo, y así no hay manera de que el mes y la semana se
-- separen por un cambio hecho en una sola de ellas.
--
-- La semana de `date_trunc` empieza en lunes, que es la semana de este
-- negocio: las hojas del gerente van de lunes a domingo.
--
-- SÓLO CUENTA LO LIQUIDADO
-- ------------------------
-- Se lee de allan.liquidacion, así que un sorteo sin número ganador todavía no
-- aparece. Es lo correcto para un análisis de RESULTADO: la utilidad de un
-- sorteo sin liquidar no existe todavía, y meterlo con premios en cero
-- inflaría el margen de la semana en curso.
--
-- `r_dias` y `r_sorteos` cuentan lo que hay, no lo que cabría: una semana a
-- medias dice «4 días» y así se ve que aún no está cerrada.
-- ===========================================================================

create or replace function allan.fn_analisis_resultados(
  p_desde       date,
  p_hasta       date,
  p_grano       text,
  p_vendedor_id uuid default null,
  p_hora        allan.hora_sorteo default null
) returns table (
  r_inicio    date,
  r_fin       date,
  r_dias      integer,
  r_sorteos   integer,
  r_venta     numeric,
  r_comision  numeric,
  r_premios   numeric,
  r_utilidad  numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with cortado as (
    select
      case p_grano
        when 'dia'    then s.fecha
        when 'semana' then date_trunc('week',  s.fecha)::date
        when 'anio'   then date_trunc('year',  s.fecha)::date
        else               date_trunc('month', s.fecha)::date
      end as inicio,
      s.id      as sorteo_id,
      s.fecha   as fecha,
      lq.venta,
      lq.comision,
      lq.premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
      and (p_hora is null or s.hora = p_hora)
  )
  select
    -- Inicio y fin van recortados al rango pedido. Una «semana» que sólo
    -- solapa dos días con el filtro no debe decir que va de lunes a domingo:
    -- el rótulo de la tarjeta se arma con estas dos fechas y estaría
    -- prometiendo días que la consulta dejó fuera. Se agrupa por el corte
    -- entero; lo que se recorta es cómo se enseña.
    greatest(inicio, p_desde),
    least(
      case p_grano
        when 'dia'    then inicio
        when 'semana' then inicio + 6
        when 'anio'   then (inicio + interval '1 year' - interval '1 day')::date
        else               (inicio + interval '1 month' - interval '1 day')::date
      end,
      p_hasta
    ),
    count(distinct fecha)::integer,
    count(distinct sorteo_id)::integer,
    sum(venta),
    sum(comision),
    sum(premios),
    -- La utilidad se resta de lo que se enseña, no se suma de `liquidacion`:
    -- las cuatro columnas se redondean por separado al liquidar y se separan
    -- hasta un céntimo. Ver la cabecera de la 0036.
    sum(venta) - sum(comision) - sum(premios)
  from cortado
  group by inicio
  order by inicio;
$$;

comment on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo) is
  'Resultado real agregado al grano pedido: dia, semana, mes o anio. Sólo sorteos liquidados.';

revoke execute on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0039_analisis_sorteo_a_sorteo.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El grano más fino del análisis: un sorteo.
--
-- La 0038 partía por día, semana, mes y año. Debajo del día todavía hay algo,
-- y es donde de verdad se explica un resultado: el sorteo. Un día malo casi
-- nunca es un día malo entero — es que a las tres salió un número muy jugado.
-- Con el corte por día eso queda escondido dentro de la suma de los tres.
--
-- POR QUÉ CAMBIA LA FIRMA
-- -----------------------
-- Hasta ahora cada tarjeta se identificaba con una fecha y bastaba. Un sorteo
-- necesita fecha Y hora, así que la salida gana `r_hora`. Como cambia el tipo
-- de retorno hay que soltar la función antes de recrearla: `create or replace`
-- no puede cambiar las columnas de un `returns table` (precedente: la 0037).
--
-- Va también el número ganador. A este grano cada tarjeta es exactamente un
-- sorteo, así que hay uno solo y es lo que explica la fila entera: los premios
-- de la tarjeta son ese número y nada más. En los demás granos se devuelve en
-- nulo, porque «el número ganador de agosto» no significa nada.
--
-- CÓMO SE AGRUPAN LOS OTROS GRANOS
-- --------------------------------
-- `corte_hora` es la hora sólo cuando se pide 'sorteo'; en los demás es nulo
-- en todas las filas, así que agrupar por (inicio, corte_hora) da exactamente
-- lo mismo que agrupar por inicio. Un solo cuerpo sigue sirviendo para los
-- cinco cortes, que era el punto de la 0038: que no se puedan separar.
-- ===========================================================================

drop function if exists allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo);

create function allan.fn_analisis_resultados(
  p_desde       date,
  p_hasta       date,
  p_grano       text,
  p_vendedor_id uuid default null,
  p_hora        allan.hora_sorteo default null
) returns table (
  r_inicio         date,
  r_fin            date,
  r_hora           allan.hora_sorteo,
  r_numero_ganador smallint,
  r_dias           integer,
  r_sorteos        integer,
  r_venta          numeric,
  r_comision       numeric,
  r_premios        numeric,
  r_utilidad       numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with cortado as (
    select
      case p_grano
        when 'sorteo' then s.fecha
        when 'dia'    then s.fecha
        when 'semana' then date_trunc('week',  s.fecha)::date
        when 'anio'   then date_trunc('year',  s.fecha)::date
        else               date_trunc('month', s.fecha)::date
      end as inicio,
      case when p_grano = 'sorteo' then s.hora end as corte_hora,
      s.id             as sorteo_id,
      s.fecha          as fecha,
      s.numero_ganador as numero_ganador,
      lq.venta,
      lq.comision,
      lq.premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_vendedor_id is null or lq.vendedor_id = p_vendedor_id)
      and (p_hora is null or s.hora = p_hora)
  )
  select
    -- Inicio y fin van recortados al rango pedido. Una «semana» que sólo
    -- solapa dos días con el filtro no debe decir que va de lunes a domingo:
    -- el rótulo de la tarjeta se arma con estas dos fechas y estaría
    -- prometiendo días que la consulta dejó fuera. Se agrupa por el corte
    -- entero; lo que se recorta es cómo se enseña.
    greatest(inicio, p_desde),
    least(
      case p_grano
        when 'sorteo' then inicio
        when 'dia'    then inicio
        when 'semana' then inicio + 6
        when 'anio'   then (inicio + interval '1 year' - interval '1 day')::date
        else               (inicio + interval '1 month' - interval '1 day')::date
      end,
      p_hasta
    ),
    corte_hora,
    -- Un solo sorteo por grupo a este grano, así que el máximo ES el número.
    case when p_grano = 'sorteo' then max(numero_ganador) end,
    count(distinct fecha)::integer,
    count(distinct sorteo_id)::integer,
    sum(venta),
    sum(comision),
    sum(premios),
    -- La utilidad se resta de lo que se enseña, no se suma de `liquidacion`:
    -- las cuatro columnas se redondean por separado al liquidar y se separan
    -- hasta un céntimo. Ver la cabecera de la 0036.
    sum(venta) - sum(comision) - sum(premios)
  from cortado
  group by inicio, corte_hora
  order by inicio, corte_hora;
$$;

comment on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo) is
  'Resultado real agregado al grano pedido: sorteo, dia, semana, mes o anio. Sólo sorteos liquidados.';

revoke execute on function allan.fn_analisis_resultados(date, date, text, uuid, allan.hora_sorteo)
  from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0040_informes_por_semana_y_vendedor.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- Los otros dos informes que mira la gerencia.
--
-- La 0036 cubrió la hoja DASHBOARD: una fila por vendedor para un rango. El
-- gerente mira además otras dos cosas, y hasta ahora las armaba aparte:
--
--   · el RESUMEN DE LA SEMANA — los cinco números de la semana y el padrón con
--     los parámetros con los que se jugó;
--   · el ANÁLISIS DE UN VENDEDOR — su acumulado y su historia semana a semana.
--
-- Las dos se apoyan en el mismo corte semanal, así que aquí van juntas.
--
-- LA SEMANA ES DE LUNES A DOMINGO
-- -------------------------------
-- `date_trunc('week', ...)` empieza en lunes, que es la semana de este
-- negocio: las hojas del gerente van de lunes a domingo. El número de semana
-- es el de la norma ISO, el mismo que enseña cualquier calendario, y va con su
-- rango de fechas al lado para que nadie tenga que fiarse del número solo.
--
-- LO QUE NO ESTÁ Y NO SE INVENTA
-- ------------------------------
-- La hoja del gerente trae columnas de «regalado», «pasados» y un factor de
-- regalía. Este sistema no registra ninguna de las tres —se retiraron por
-- decisión del negocio al hacer la 0036— y ninguna función de aquí las
-- devuelve. Enseñarlas en cero fijo sería fingir un dato.
-- ===========================================================================


-- --------------------------------------------------------------------------
-- Las semanas que de verdad se operaron.
--
-- Es el riel de la izquierda del resumen semanal, y también la fuente de los
-- totales del análisis de vendedores: cuántas semanas hay y cuánta comisión se
-- pagó en total. Una sola función para las dos cosas, porque son la misma
-- pregunta hecha desde dos pantallas.
-- --------------------------------------------------------------------------
create or replace function allan.fn_semanas_operadas()
returns table (
  r_inicio   date,
  r_fin      date,
  r_semana   integer,
  r_anio     integer,
  r_dias     integer,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_neto     numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select
    date_trunc('week', s.fecha)::date,
    (date_trunc('week', s.fecha) + interval '6 days')::date,
    extract(week    from date_trunc('week', s.fecha))::integer,
    extract(isoyear from date_trunc('week', s.fecha))::integer,
    count(distinct s.fecha)::integer,
    count(distinct s.id)::integer,
    sum(lq.venta),
    sum(lq.comision),
    sum(lq.premios),
    -- Restado de lo que se enseña, no sumado de `utilidad`: las cuatro
    -- columnas se redondean por separado al liquidar. Ver la 0036.
    sum(lq.venta) - sum(lq.comision) - sum(lq.premios)
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  group by date_trunc('week', s.fecha)
  -- La más reciente primero: es la que el gerente abre.
  order by 1 desc;
$$;

comment on function allan.fn_semanas_operadas() is
  'Una fila por semana con movimiento liquidado, de la más reciente a la más vieja.';

revoke execute on function allan.fn_semanas_operadas() from public, anon;


-- --------------------------------------------------------------------------
-- El resumen de una semana, vendedor por vendedor.
--
-- Trae dos cosas distintas en la misma fila y conviene no confundirlas:
--
--   · los PARÁMETROS con los que ese vendedor jugó la semana —comisión, tope
--     por número y factor de pago—, que son configuración;
--   · lo que MOVIÓ esa semana, que es resultado.
--
-- Los parámetros se leen vigentes al cierre de la semana, no los de hoy. Un
-- resumen de marzo tiene que enseñar la comisión de marzo: `parametro_vendedor`
-- guarda la historia con `vigente_desde`, y sería un desperdicio consultarla
-- para devolver el valor de ahora.
-- --------------------------------------------------------------------------
create or replace function allan.fn_resumen_semanal(
  p_desde date,
  p_hasta date
) returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_nombre      text,
  r_activo      boolean,
  r_comision    numeric,   -- FRACCIÓN vigente: 0.15 = 15 %
  r_tope        numeric,   -- tope por número y sorteo
  r_factor      numeric,   -- multiplicador de pago
  r_venta       numeric,
  r_premiado    numeric,   -- lo APOSTADO al número que salió
  r_pago        numeric,   -- lo que costó pagarlo
  r_comision_l  numeric,   -- la comisión en lempiras
  r_bruto       numeric,
  r_neto        numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
    group by lq.vendedor_id
  ),
  acertado as (
    select t.vendedor_id, sum(l.monto) as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and t.anulado_en is null
      and l.gana
    group by t.vendedor_id
  ),
  -- El parámetro que regía al terminar la semana. `distinct on` con el orden
  -- descendente por `vigente_desde` se queda con el último que había empezado
  -- a esa altura, que es exactamente la definición de «el vigente entonces».
  vigente as (
    select distinct on (p.vendedor_id)
           p.vendedor_id, p.comision, p.tope_por_numero, p.factor_pago
    from allan.parametro_vendedor p
    where p.vigente_desde < ((p_hasta + 1)::timestamp at time zone 'America/Tegucigalpa')
    order by p.vendedor_id, p.vigente_desde desc
  )
  -- Se parte del padrón, igual que la 0036: un vendedor que no movió nada esa
  -- semana es justo lo que hay que ver, y desapareciendo no se distingue de no
  -- existir.
  select v.id,
         v.codigo,
         v.nombre,
         v.activo,
         g.comision,
         g.tope_por_numero,
         g.factor_pago,
         coalesce(q.venta, 0),
         coalesce(a.premiado, 0),
         coalesce(q.premios, 0),
         coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0),
         coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
  from allan.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  left join vigente   g on g.vendedor_id = v.id
  where v.activo or q.venta is not null
  order by v.codigo;
$$;

comment on function allan.fn_resumen_semanal(date, date) is
  'Resumen de una semana: por vendedor, los parámetros vigentes entonces y lo que movió.';

revoke execute on function allan.fn_resumen_semanal(date, date) from public, anon;


-- --------------------------------------------------------------------------
-- La historia de un vendedor, semana a semana.
--
-- El acumulado del vendedor no se devuelve aparte: es la suma de estas filas,
-- y calcularlo dos veces —una aquí y otra en la pantalla— es la forma más
-- fácil de que un día dejen de coincidir.
-- --------------------------------------------------------------------------
create or replace function allan.fn_historial_vendedor(
  p_vendedor_id uuid
) returns table (
  r_inicio   date,
  r_fin      date,
  r_semana   integer,
  r_anio     integer,
  r_sorteos  integer,
  r_venta    numeric,
  r_premiado numeric,
  r_premios  numeric,
  r_comision numeric,
  r_neto     numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with semanal as (
    select date_trunc('week', s.fecha)::date as inicio,
           count(distinct s.id)::integer     as sorteos,
           sum(lq.venta)                     as venta,
           sum(lq.comision)                  as comision,
           sum(lq.premios)                   as premios
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
    group by 1
  ),
  acertado as (
    select date_trunc('week', s.fecha)::date as inicio,
           sum(l.monto)                      as premiado
    from allan.linea l
    join allan.ticket t on t.id = l.ticket_id
    join allan.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana
    group by 1
  )
  select w.inicio,
         (w.inicio + 6),
         extract(week    from w.inicio)::integer,
         extract(isoyear from w.inicio)::integer,
         w.sorteos,
         w.venta,
         coalesce(a.premiado, 0),
         w.premios,
         w.comision,
         w.venta - w.comision - w.premios
  from semanal w
  left join acertado a on a.inicio = w.inicio
  order by w.inicio;
$$;

comment on function allan.fn_historial_vendedor(uuid) is
  'La historia de un vendedor semana a semana. El acumulado es la suma de estas filas.';

revoke execute on function allan.fn_historial_vendedor(uuid) from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0041_resultado_por_dia_de_la_semana.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El resultado por día de la semana.
--
-- No es «cada día», que ya lo da `fn_analisis_resultados` con el grano 'dia'.
-- Es todos los lunes juntos, todos los martes juntos, y así: la pregunta es si
-- hay un día que sistemáticamente deja o quita dinero, y esa sólo se contesta
-- apilando meses de lunes.
--
-- Siete filas siempre que haya historia, y sin parámetros a propósito: el
-- análisis financiero de la gerencia es el acumulado de toda la operación. Un
-- rango corto no contesta esta pregunta —tres lunes no son una tendencia— así
-- que no se ofrece la posibilidad de pedirlo.
--
-- `isodow` numera de 1 (lunes) a 7 (domingo), que es el orden en el que se
-- lee una semana aquí. `dow` empieza en domingo y habría obligado a rotar la
-- lista en la pantalla.
-- ===========================================================================

create or replace function allan.fn_resultado_por_dia_semana()
returns table (
  r_dow      integer,   -- 1 = lunes … 7 = domingo
  r_dias     integer,
  r_sorteos  integer,
  r_venta    numeric,
  r_comision numeric,
  r_premios  numeric,
  r_neto     numeric
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select
    extract(isodow from s.fecha)::integer,
    count(distinct s.fecha)::integer,
    count(distinct s.id)::integer,
    sum(lq.venta),
    sum(lq.comision),
    sum(lq.premios),
    -- Restado de lo que se enseña, no sumado de `utilidad`. Ver la 0036.
    sum(lq.venta) - sum(lq.comision) - sum(lq.premios)
  from allan.liquidacion lq
  join allan.sorteo s on s.id = lq.sorteo_id
  group by 1
  order by 1;
$$;

comment on function allan.fn_resultado_por_dia_semana() is
  'Todos los lunes juntos, todos los martes juntos: una fila por día de la semana, toda la historia.';

revoke execute on function allan.fn_resultado_por_dia_semana() from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0042_mi_periodo_con_premiado.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- El reporte del vendedor gana la columna «premiado».
--
-- El vendedor va a ver su propio resultado con las mismas columnas que mira la
-- gerencia, y ahí hay una que este sistema no le estaba devolviendo: lo
-- APOSTADO al número que salió. No es lo mismo que lo pagado —eso es
-- `premios`, que ya venía—: apostado por factor es pagado, y son las dos
-- columnas que permiten reconstruir la cuenta a mano.
--
-- Con las dos, el factor efectivo del sorteo sale de dividir una por la otra,
-- así que no hace falta devolverlo: sería un tercer número que puede dejar de
-- cuadrar con los otros dos.
--
-- Cambia el tipo de retorno, así que hay que soltar la función antes de
-- recrearla. Mismo procedimiento que la 0037 y la 0039.
-- ===========================================================================

drop function if exists allan.fn_mi_periodo(uuid, date, date);

create function allan.fn_mi_periodo(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_fecha    date,
  r_hora     allan.hora_sorteo,
  r_estado   allan.estado_sorteo,
  r_ganador  smallint,
  r_tickets  integer,
  r_venta    numeric,
  r_premiado numeric,   -- lo APOSTADO al número que salió
  r_comision numeric,
  r_premios  numeric,   -- lo que costó pagarlo
  r_pagado   boolean
)
language sql
stable
security definer
set search_path = allan, public
as $$
  select s.fecha,
         s.hora,
         s.estado,
         s.numero_ganador,
         count(distinct t.id)::integer,
         coalesce(sum(l.monto), 0),
         -- `filter` y no un segundo join: las líneas ya están aquí, y volver a
         -- traerlas para contar las ganadoras sería recorrer dos veces lo
         -- mismo. `l.gana` se marca al liquidar, así que un sorteo sin número
         -- ganador da cero, que es lo correcto: todavía no ganó nadie.
         coalesce(sum(l.monto) filter (where l.gana), 0),
         coalesce(sum(l.monto * l.comision_congelada), 0),
         coalesce(sum(l.premio), 0),
         exists (
           select 1
           from allan.liquidacion lq
           join allan.corte_detalle d on d.liquidacion_id = lq.id
           where lq.sorteo_id = s.id and lq.vendedor_id = p_vendedor_id
         )
  -- LEFT JOIN y no INNER: un sorteo en el que este vendedor no vendió nada
  -- tiene que salir igual, en cero. Si desapareciera, la rejilla del día
  -- perdería una fila y parecería que ese sorteo no existió.
  from allan.sorteo s
  left join allan.ticket t
    on t.sorteo_id = s.id
   and t.vendedor_id = p_vendedor_id
   and t.anulado_en is null
  left join allan.linea l on l.ticket_id = t.id
  where s.fecha between p_desde and p_hasta
  group by s.id, s.fecha, s.hora, s.estado, s.numero_ganador
  order by s.fecha, s.hora;
$$;

comment on function allan.fn_mi_periodo(uuid, date, date) is
  'El período de UN vendedor, día por día y sorteo por sorteo, con lo apostado y lo pagado al número ganador.';

revoke execute on function allan.fn_mi_periodo(uuid, date, date) from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0043_liquidacion_por_semana.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- La liquidación, vista por semanas.
--
-- Hasta ahora el módulo contestaba una sola pregunta: «qué le queda por pagar
-- a este vendedor en este rango». Faltaban las otras dos, que son las que se
-- hacen antes de abrir la hoja:
--
--   · ¿qué semanas hay y cuál tiene saldo pendiente? — el riel de la izquierda;
--   · ¿cómo va el cobro semana a semana, en total o por vendedor? — el resumen.
--
-- Las tres salen de la misma cuenta, así que salen de la misma función. Con
-- `p_vendedor_id` en nulo devuelve el negocio entero, que es lo que necesita el
-- resumen sin filtro.
--
-- PAGADO Y PENDIENTE SE PARTEN POR `corte_detalle`
-- ------------------------------------------------
-- Una liquidación está pagada cuando figura en un corte, y la tabla tiene
-- `unique (liquidacion_id)`: no puede estar en dos. Por eso `pagado` y
-- `pendiente` suman exactamente `saldo` y no hace falta comprobarlo aparte —lo
-- garantiza la restricción, no la consulta.
--
-- Eso es también lo que hace posible el pago parcial: se cobran el lunes y el
-- martes, y al volver a la semana esos dos días ya no están en `pendiente`
-- pero siguen contando en `saldo`.
--
-- EL SALDO SE RESTA FILA A FILA, no se lee de `utilidad`: las cuatro columnas
-- se redondean por separado al liquidar. Ver la cabecera de la 0036.
-- ===========================================================================

create or replace function allan.fn_liquidacion_por_semana(
  p_vendedor_id uuid default null
) returns table (
  r_inicio        date,
  r_fin           date,
  r_semana        integer,
  r_anio          integer,
  r_sorteos       integer,   -- sorteos distintos de la semana
  r_liquidaciones integer,   -- filas de liquidación; con un vendedor, = sorteos
  r_pagadas       integer,
  r_pendientes    integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_saldo         numeric,   -- todo lo de la semana
  r_pagado        numeric,   -- lo que ya se cerró en un corte
  r_pendiente     numeric    -- lo que falta por cobrar
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with base as (
    select date_trunc('week', s.fecha)::date as inicio,
           s.id as sorteo_id,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where p_vendedor_id is null or lq.vendedor_id = p_vendedor_id
  )
  select inicio,
         (inicio + 6),
         extract(week    from inicio)::integer,
         extract(isoyear from inicio)::integer,
         count(distinct sorteo_id)::integer,
         count(*)::integer,
         count(*) filter (where pagada)::integer,
         count(*) filter (where not pagada)::integer,
         sum(venta),
         sum(comision),
         sum(premios),
         sum(saldo),
         coalesce(sum(saldo) filter (where pagada), 0),
         coalesce(sum(saldo) filter (where not pagada), 0)
  from base
  group by inicio
  -- La más reciente primero: es la que se cobra.
  order by 1 desc;
$$;

comment on function allan.fn_liquidacion_por_semana(uuid) is
  'Cobro semana a semana: cuánto hay, cuánto se pagó y cuánto falta. Sin vendedor, el negocio entero.';

revoke execute on function allan.fn_liquidacion_por_semana(uuid) from public, anon;

-- >>>>>>>>>>>>>>>>>>>>  migrations/0044_liquidacion_en_las_dos_direcciones.sql  <<<<<<<<<<<<<<<<<<<<

-- ===========================================================================
-- La liquidación tiene dos direcciones, y sumarlas las esconde.
--
-- Una semana puede acabar de dos maneras: el vendedor entrega dinero, o la
-- casa se lo entrega a él porque los premios que pagó de su bolsillo superaron
-- su venta. Las dos son liquidar; lo que cambia es quién saca la cartera.
--
-- El problema es de los TOTALES. `r_pendiente` es una resta, así que al mirar
-- el padrón entero un vendedor que debe 5.000 y otro al que se le deben 5.000
-- se cancelan y el resumen dice «pendiente: 0» — cuando lo que hay son diez
-- mil lempiras de movimiento por hacer en dos direcciones. Con ese cero nadie
-- sale a cobrar ni prepara efectivo para pagar.
--
-- Por eso se devuelven aparte:
--
--   r_por_cobrar  lo que hay que RECIBIR de los vendedores que deben
--   r_por_pagar   lo que hay que ENTREGAR a los vendedores a los que se debe
--
-- y sigue cumpliéndose `r_pendiente = r_por_cobrar − r_por_pagar`.
--
-- SE CLASIFICA POR VENDEDOR, NO POR SORTEO
-- ----------------------------------------
-- La dirección la decide el saldo de la SEMANA de cada vendedor, no el de cada
-- sorteo: dentro de una misma semana un vendedor puede tener un sorteo malo y
-- dos buenos, y no se le cobra y se le paga por separado — se cuadra una vez.
-- De ahí la agregación en dos pisos: primero por (semana, vendedor) y después
-- por semana.
--
-- Cambia el tipo de retorno, así que hay que soltar la función. Igual que la
-- 0037, la 0039 y la 0042.
-- ===========================================================================

drop function if exists allan.fn_liquidacion_por_semana(uuid);

create function allan.fn_liquidacion_por_semana(
  p_vendedor_id uuid default null
) returns table (
  r_inicio        date,
  r_fin           date,
  r_semana        integer,
  r_anio          integer,
  r_sorteos       integer,   -- sorteos distintos de la semana
  r_liquidaciones integer,   -- filas de liquidación; con un vendedor, = sorteos
  r_pagadas       integer,
  r_pendientes    integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_saldo         numeric,   -- todo lo de la semana
  r_pagado        numeric,   -- lo que ya se cerró en un corte
  r_pendiente     numeric,   -- lo que falta, en neto
  r_por_cobrar    numeric,   -- de lo pendiente, lo que entregan los vendedores
  r_por_pagar     numeric    -- de lo pendiente, lo que entrega la casa
)
language sql
stable
security definer
set search_path = allan, public
as $$
  with base as (
    select date_trunc('week', s.fecha)::date as inicio,
           lq.vendedor_id,
           s.id as sorteo_id,
           lq.venta,
           lq.comision,
           lq.premios,
           lq.venta - lq.comision - lq.premios as saldo,
           exists (
             select 1 from allan.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from allan.liquidacion lq
    join allan.sorteo s on s.id = lq.sorteo_id
    where p_vendedor_id is null or lq.vendedor_id = p_vendedor_id
  ),
  semana as (
    select inicio,
           count(distinct sorteo_id)::integer            as sorteos,
           count(*)::integer                             as liquidaciones,
           count(*) filter (where pagada)::integer       as pagadas,
           count(*) filter (where not pagada)::integer   as pendientes,
           sum(venta)                                    as venta,
           sum(comision)                                 as comision,
           sum(premios)                                  as premios,
           sum(saldo)                                    as saldo,
           coalesce(sum(saldo) filter (where pagada), 0) as pagado,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from base
    group by inicio
  ),
  -- Primer piso: lo que le queda pendiente a cada vendedor en cada semana.
  por_vendedor as (
    select inicio,
           vendedor_id,
           coalesce(sum(saldo) filter (where not pagada), 0) as pendiente
    from base
    group by inicio, vendedor_id
  ),
  -- Segundo piso: los que deben por un lado y los que cobran por el otro.
  direccion as (
    select inicio,
           coalesce(sum(greatest(pendiente, 0)), 0) as por_cobrar,
           coalesce(sum(-least(pendiente, 0)), 0)   as por_pagar
    from por_vendedor
    group by inicio
  )
  select s.inicio,
         (s.inicio + 6),
         extract(week    from s.inicio)::integer,
         extract(isoyear from s.inicio)::integer,
         s.sorteos,
         s.liquidaciones,
         s.pagadas,
         s.pendientes,
         s.venta,
         s.comision,
         s.premios,
         s.saldo,
         s.pagado,
         s.pendiente,
         d.por_cobrar,
         d.por_pagar
  from semana s
  join direccion d on d.inicio = s.inicio
  -- La más reciente primero: es la que se liquida.
  order by s.inicio desc;
$$;

comment on function allan.fn_liquidacion_por_semana(uuid) is
  'Liquidación semana a semana: cuánto hay, cuánto se liquidó y cuánto falta, separando lo que se cobra de lo que se paga.';

revoke execute on function allan.fn_liquidacion_por_semana(uuid) from public, anon;
