-- ===========================================================================
-- Lotería El Diario — todas las migraciones concatenadas, en orden.
--
-- Para una instalación DESDE CERO. Si el esquema ya está aplicado, aplica
-- sólo las migraciones nuevas de migrations/.
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
