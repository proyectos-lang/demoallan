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
