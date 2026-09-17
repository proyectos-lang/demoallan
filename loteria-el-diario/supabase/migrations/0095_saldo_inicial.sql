-- ===========================================================================
-- Un vendedor puede entrar al sistema debiendo —o con la casa debiéndole—.
--
-- QUÉ HUECO LLENA
-- ---------------
-- Los vendedores que se dan de alta no son negocios nuevos: llevan años
-- vendiendo, y traen una cuenta abierta de la libreta anterior. Hoy el sistema
-- no tiene dónde ponerla. El «saldo anterior» que enseña la liquidación se
-- CALCULA sumando los sorteos viejos que ese vendedor no ha pagado, y un
-- vendedor recién creado no tiene ninguno: su arrastre es cero y no hay forma
-- de decir que debe 4.500.
--
-- POR QUÉ UNA TABLA Y NO UNA LIQUIDACIÓN INVENTADA
-- ------------------------------------------------
-- La vía corta sería fabricar un sorteo y una fila de `liquidacion` con ese
-- saldo, para que el cálculo actual la recogiera sin tocar nada. No se hace, y
-- conviene decir por qué: esa fila diría que el vendedor VENDIÓ un dinero que
-- nadie vendió. El informe de gerencia, el tablero, el análisis de resultados
-- y el control de vendedores suman `liquidacion` para responder «cuánto se
-- vendió»; meterle 4.500 de venta imaginaria corrompería las cinco pantallas a
-- la vez, y el error no se vería hasta que alguien cuadrara un mes contra los
-- tickets.
--
-- Un saldo de apertura es otra cosa que una venta. Va en su propia tabla, con
-- su fecha, su motivo y quién lo cargó, y se SUMA al arrastre en el único
-- sitio donde el arrastre se calcula. Las cifras de venta no se tocan.
--
-- SE COBRA COMO CUALQUIER OTRA DEUDA VIEJA
-- ----------------------------------------
-- Al sumarse al arrastre, los dos botones que ya existen siguen valiendo:
-- «cobrar» admite un abono a cuenta y «saldar» cierra la deuda entera. No se
-- inventa un tercer gesto para la misma acción.
--
-- PUEDE SER NEGATIVO
-- ------------------
-- Un saldo negativo es dinero que la casa le debe al vendedor —cerró la
-- temporada anterior con premios por encima de su venta—. Es un caso real y la
-- tabla lo admite; lo único que se rechaza es el cero, que no es un saldo sino
-- la ausencia de uno.
--
-- UNO VIVO POR VENDEDOR
-- ---------------------
-- Dos saldos de apertura para la misma persona serían dos verdades sobre lo
-- mismo. Si hay que corregirlo, se anula el anterior y se carga otro: así
-- queda el rastro de qué se dijo primero y qué se corrigió, que es justo lo
-- que hace falta cuando alguien pregunte de dónde salió esa cifra.
-- ===========================================================================

create table if not exists public.saldo_inicial (
  id           uuid primary key default gen_random_uuid(),
  vendedor_id  uuid not null references public.vendedor(id),
  -- Positivo: el vendedor debe. Negativo: la casa le debe.
  monto        numeric(14,2) not null,
  -- Desde cuándo cuenta. La liquidación lo suma al arrastre de las semanas
  -- que empiezan después de esta fecha, igual que hace con los sorteos viejos.
  vigente_desde date not null,
  nota         text,
  creado_en    timestamptz not null default now(),
  creado_por   uuid,
  anulado_en   timestamptz,
  anulado_por  uuid,
  motivo_anulacion text,

  -- Un saldo de cero no es un saldo.
  constraint saldo_inicial_no_cero check (monto <> 0)
);

-- Uno vivo por vendedor. El índice parcial lo garantiza sin estorbar a los
-- anulados, que tienen que poder acumularse: son el historial de correcciones.
create unique index if not exists saldo_inicial_uno_vivo
  on public.saldo_inicial (vendedor_id)
  where anulado_en is null;

create index if not exists saldo_inicial_vendedor
  on public.saldo_inicial (vendedor_id, vigente_desde);

comment on table public.saldo_inicial is
  'El saldo con el que un vendedor entra al sistema, traído de la libreta anterior. No es una venta: no entra en ningún informe de venta, sólo en el arrastre de la liquidación.';

comment on column public.saldo_inicial.monto is
  'Positivo, el vendedor debe. Negativo, la casa le debe.';

comment on column public.saldo_inicial.vigente_desde is
  'Desde cuándo cuenta. Sólo se suma al arrastre de semanas posteriores a esta fecha.';


-- --------------------------------------------------------------------------
-- Cargar el saldo de apertura.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action. La base no
-- sabe quién llama —desde la 0024 la aplicación habla como `service_role`— así
-- que aquí no hay guarda que sirva.
-- --------------------------------------------------------------------------

create or replace function public.fn_cargar_saldo_inicial(
  p_vendedor_id  uuid,
  p_monto        numeric,
  p_vigente_desde date,
  p_nota         text default null,
  p_usuario_id   uuid default null
) returns table (r_id uuid, r_monto numeric)
language plpgsql
security definer
set search_path = public
as $cargar_saldo$
declare
  v_id     uuid;
  v_previo numeric;
begin
  if p_monto is null or p_monto = 0 then
    raise exception 'El saldo inicial no puede ser cero. Si no arrastra nada, no hace falta cargarlo.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_vigente_desde is null then
    raise exception 'Hace falta decir desde cuándo cuenta ese saldo.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Una fecha futura casi siempre es un dedazo en el año, y dejaría un saldo
  -- que no aparece en ninguna semana hasta que llegue esa fecha.
  if p_vigente_desde > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'Esa fecha todavía no ha llegado.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor
   where id = p_vendedor_id and eliminado_en is null;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  -- Se dice cuánto había, en vez de dejar que el índice único conteste con un
  -- error de base que no explica nada.
  select monto into v_previo
  from public.saldo_inicial
  where vendedor_id = p_vendedor_id and anulado_en is null;

  if found then
    raise exception 'Ese vendedor ya tiene un saldo inicial de %. Anúlelo antes de cargar otro.', v_previo
      using errcode = 'unique_violation';
  end if;

  insert into public.saldo_inicial (
    vendedor_id, monto, vigente_desde, nota, creado_por
  ) values (
    p_vendedor_id, p_monto, p_vigente_desde, nullif(btrim(p_nota), ''), p_usuario_id
  )
  returning id into v_id;

  perform public.fn_auditar(
    'saldo_inicial', v_id, 'crear', 'monto',
    null, p_monto::text, p_usuario_id
  );

  return query select v_id, p_monto;
end;
$cargar_saldo$;

comment on function public.fn_cargar_saldo_inicial(uuid, numeric, date, text, uuid) is
  'Carga el saldo con el que un vendedor entra al sistema. Uno vivo por vendedor.';

revoke execute on function public.fn_cargar_saldo_inicial(uuid, numeric, date, text, uuid)
  from public, anon;


-- --------------------------------------------------------------------------
-- Anular un saldo de apertura.
--
-- No se borra: se marca. Si alguien pregunta por qué el arrastre de un
-- vendedor cambió, la respuesta tiene que estar en algún sitio.
-- --------------------------------------------------------------------------

create or replace function public.fn_anular_saldo_inicial(
  p_id         uuid,
  p_motivo     text default null,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $anular_saldo$
declare
  v_monto numeric;
begin
  select monto into v_monto
  from public.saldo_inicial
  where id = p_id and anulado_en is null
  for update;

  if not found then
    raise exception 'Ese saldo inicial no existe o ya estaba anulado.'
      using errcode = 'no_data_found';
  end if;

  update public.saldo_inicial
  set anulado_en = now(),
      anulado_por = p_usuario_id,
      motivo_anulacion = nullif(btrim(p_motivo), '')
  where id = p_id;

  perform public.fn_auditar(
    'saldo_inicial', p_id, 'anular', 'monto',
    v_monto::text, null, p_usuario_id
  );
end;
$anular_saldo$;

comment on function public.fn_anular_saldo_inicial(uuid, text, uuid) is
  'Anula el saldo de apertura de un vendedor. No lo borra: queda el rastro de qué decía.';

revoke execute on function public.fn_anular_saldo_inicial(uuid, text, uuid)
  from public, anon;


-- --------------------------------------------------------------------------
-- El saldo de apertura vivo de un vendedor, para poder enseñarlo.
-- --------------------------------------------------------------------------

create or replace function public.fn_saldo_inicial(p_vendedor_id uuid)
returns table (
  r_id            uuid,
  r_monto         numeric,
  r_vigente_desde date,
  r_nota          text,
  r_creado_en     timestamptz
)
language sql
stable
security definer
set search_path = public
as $ver_saldo$
  select id, monto, vigente_desde, nota, creado_en
  from public.saldo_inicial
  where vendedor_id = p_vendedor_id and anulado_en is null;
$ver_saldo$;

comment on function public.fn_saldo_inicial(uuid) is
  'El saldo de apertura vivo de un vendedor, si lo tiene.';

revoke execute on function public.fn_saldo_inicial(uuid) from public, anon;
