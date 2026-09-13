-- ===========================================================================
-- Abonos a cuenta: pagar parte de lo que se debe, y seguir debiendo el resto.
--
-- QUÉ HUECO LLENA
-- ---------------
-- Hasta ahora una deuda sólo sabía cerrarse ENTERA. `fn_saldar_arrastre`
-- (0069) cierra de un golpe todos los sorteos pendientes, y si el vendedor
-- entrega menos la diferencia se guarda como `ajuste` — es decir, se le
-- PERDONA.
--
-- Eso es correcto para cerrar un trato («págame 850 de los 900 y quedamos a
-- mano»), pero no sirve para lo corriente: el vendedor trae 400 a cuenta de
-- 900 y el lunes siguiente trae el resto. Con lo que había, o se le perdonaban
-- 500 que sí debe, o no se podía registrar nada y el dinero entraba sin
-- constancia.
--
-- POR QUÉ UNA TABLA NUEVA Y NO OTRA COLUMNA
-- -----------------------------------------
-- Todo el módulo está construido sobre una pregunta binaria: un sorteo está en
-- `corte_detalle` o no lo está; está pagado o no. Un abono no encaja ahí
-- porque no pertenece a ningún sorteo en concreto: son 400 lempiras contra una
-- deuda que suma nueve sorteos de tres semanas distintas.
--
-- Repartirlos a mano entre esos sorteos sería inventar una asignación que
-- nadie hizo: el vendedor no dijo «esto es del martes», dijo «aquí van 400».
-- Se guardan como lo que son —dinero entregado a cuenta, con su fecha— y el
-- saldo pendiente pasa a ser:
--
--     lo no cerrado en cortes  −  lo abonado a cuenta
--
-- CÓMO SE LLEVAN LAS DOS COSAS JUNTAS
-- -----------------------------------
-- Un abono queda VIVO mientras no se cierre en un corte. Cuando el vendedor
-- termina de pagar y se registra el corte definitivo, los abonos que cubrían
-- esa deuda se marcan con ese corte y dejan de contar aparte: su dinero ya
-- está dentro del corte. Sin eso se contarían dos veces.
--
-- QUIÉN PUEDE: sólo administración. Se comprueba en la Server Action, que es
-- donde hay una sesión firmada — la base habla como `service_role` desde la
-- 0024 y sus guardas de rol no miran nada.
-- ===========================================================================

create table if not exists public.abono_vendedor (
  id          uuid primary key default gen_random_uuid(),
  vendedor_id uuid not null references public.vendedor(id),

  /* Lo entregado. Siempre positivo: devolver dinero al vendedor no es un
     abono, es un corte con saldo negativo, y eso ya existe. */
  monto       numeric(14,2) not null,

  /* El día en que el vendedor entregó, no el día en que se tecleó. Si pagó el
     viernes y esto se registra el lunes, aquí va el viernes: es la fecha con
     la que él cuadra su cuenta. */
  fecha_pago  date not null,

  nota        text,

  /* Cuando la deuda se cierra en un corte, el abono se marca con él: su
     dinero pasa a estar contado ahí dentro y deja de sumar por su cuenta. */
  corte_id    uuid references public.corte_vendedor(id) on delete set null,

  registrado_en timestamptz not null default now(),
  usuario_id    uuid,

  constraint abono_positivo check (monto > 0)
);

comment on table public.abono_vendedor is
  'Dinero entregado a cuenta de lo que se debe, sin cerrar sorteos concretos. Mientras corte_id sea nulo, descuenta del saldo pendiente.';

comment on column public.abono_vendedor.corte_id is
  'El corte que absorbió este abono. Nulo mientras el abono sigue vivo; una vez fijado, el monto ya está contado dentro de ese corte y no se descuenta aparte.';

-- Se consulta siempre por vendedor y por si sigue vivo.
create index if not exists abono_vendedor_pendiente_idx
  on public.abono_vendedor (vendedor_id, fecha_pago)
  where corte_id is null;


-- ---------------------------------------------------------------------------
-- Registrar un abono.
-- ---------------------------------------------------------------------------
create or replace function public.fn_registrar_abono(
  p_vendedor_id uuid,
  p_monto       numeric,
  p_fecha_pago  date default null,
  p_nota        text default null,
  p_usuario_id  uuid default null
)
returns table (
  r_abono_id  uuid,
  r_monto     numeric,
  r_pendiente numeric   -- lo que le queda debiendo DESPUÉS de este abono
)
language plpgsql
security definer
set search_path = public
as $abono$
declare
  v_id      uuid := gen_random_uuid();
  v_fecha   date := coalesce(p_fecha_pago, (now() at time zone 'America/Tegucigalpa')::date);
  v_deuda   numeric(14,2);
  v_abonado numeric(14,2);
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El abono tiene que ser mayor que cero.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Un pago que todavía no ocurrió no se registra: casi siempre es un dedazo
  -- en el año, y una fecha futura descuadra cualquier corte por período.
  if v_fecha > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha de pago no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor where id = p_vendedor_id;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  /*
   * Lo que debe AHORA MISMO, recalculado aquí.
   *
   * Se bloquean los abonos vivos del vendedor para que dos personas cobrando a
   * la vez no lean el mismo pendiente y acepten cada una un abono que junto
   * con el otro se pasa de la deuda.
   */
  perform 1 from public.abono_vendedor
  where vendedor_id = p_vendedor_id and corte_id is null
  for update;

  select coalesce(sum(lq.venta - lq.comision - lq.premios), 0)
  into v_deuda
  from public.liquidacion lq
  where lq.vendedor_id = p_vendedor_id
    and not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    );

  select coalesce(sum(a.monto), 0)
  into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  /*
   * No se acepta más de lo que debe.
   *
   * Un abono mayor que la deuda deja al vendedor con saldo a favor, y este
   * módulo no sabe qué hacer con eso: lo arrastraría como un pendiente
   * negativo que nadie sabría leer. Si de verdad entregó de más, es un corte
   * con su ajuste y su motivo, que sí deja constancia de por qué.
   */
  if round(p_monto, 2) > (v_deuda - v_abonado) then
    raise exception 'El abono (%) pasa de lo que debe (%). Registre un corte si quiere cerrar con ajuste.',
      round(p_monto, 2), greatest(v_deuda - v_abonado, 0)
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.abono_vendedor (
    id, vendedor_id, monto, fecha_pago, nota, usuario_id
  ) values (
    v_id, p_vendedor_id, round(p_monto, 2), v_fecha,
    nullif(btrim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  perform public.fn_auditar('abono_vendedor', v_id, 'crear', 'monto',
                            null, round(p_monto, 2)::text);

  return query
  select v_id,
         round(p_monto, 2),
         round(v_deuda - v_abonado - p_monto, 2);
end;
$abono$;

comment on function public.fn_registrar_abono(uuid, numeric, date, text, uuid) is
  'Registra dinero entregado a cuenta. No cierra sorteos: descuenta del pendiente y el resto sigue debiéndose.';

revoke execute on function public.fn_registrar_abono(uuid, numeric, date, text, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Anular un abono.
--
-- Se borra de verdad, no se marca. Un abono es un apunte de caja de una línea;
-- si se tecleó 4.000 en vez de 400, lo que hace falta es que desaparezca, no
-- que quede un rastro tachado que confunda la cuenta. La auditoría conserva
-- que existió, cuánto decía y quién lo quitó.
-- ---------------------------------------------------------------------------
create or replace function public.fn_anular_abono(
  p_abono_id   uuid,
  p_motivo     text default null,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $anular$
declare
  v_fila public.abono_vendedor%rowtype;
begin
  select * into v_fila
  from public.abono_vendedor where id = p_abono_id
  for update;

  if not found then
    raise exception 'Ese abono no existe.'
      using errcode = 'no_data_found';
  end if;

  -- Un abono ya cerrado en un corte no se toca por aquí: su dinero está
  -- contado dentro de ese corte, y quitarlo dejaría el corte sin cuadrar.
  -- Para deshacerlo hay que deshacer el corte.
  if v_fila.corte_id is not null then
    raise exception 'Ese abono ya está incluido en un corte pagado; no se puede quitar por separado.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform public.fn_auditar('abono_vendedor', p_abono_id, 'anular', 'monto',
                            v_fila.monto::text,
                            nullif(btrim(coalesce(p_motivo, '')), ''));

  delete from public.abono_vendedor where id = p_abono_id;
end;
$anular$;

comment on function public.fn_anular_abono(uuid, text, uuid) is
  'Quita un abono que todavía no entró en ningún corte. Queda en auditoría.';

revoke execute on function public.fn_anular_abono(uuid, text, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Lo que un vendedor debe, con sus abonos al descubierto.
-- ---------------------------------------------------------------------------
create or replace function public.fn_deuda_vendedor(p_vendedor_id uuid)
returns table (
  r_sorteos   integer,   -- cuántos sorteos sin cerrar
  r_desde     date,      -- el más viejo
  r_hasta     date,
  r_deuda     numeric,   -- lo que suman esos sorteos
  r_abonado   numeric,   -- lo entregado a cuenta y todavía sin cerrar
  r_pendiente numeric    -- deuda − abonado: lo que falta de verdad
)
language sql
stable
security definer
set search_path = public
as $deuda$
  with sin_cerrar as (
    select count(*)::integer                                   as sorteos,
           min(s.fecha)                                        as desde,
           max(s.fecha)                                        as hasta,
           coalesce(sum(lq.venta - lq.comision - lq.premios), 0) as deuda
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
      and not exists (
        select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
      )
  ),
  abonos as (
    select coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where a.vendedor_id = p_vendedor_id and a.corte_id is null
  )
  select c.sorteos, c.desde, c.hasta, c.deuda, b.abonado, c.deuda - b.abonado
  from sin_cerrar c cross join abonos b;
$deuda$;

comment on function public.fn_deuda_vendedor(uuid) is
  'Lo que un vendedor debe de sorteos sin cerrar, menos lo que ya entregó a cuenta.';

revoke execute on function public.fn_deuda_vendedor(uuid) from public, anon;


-- ---------------------------------------------------------------------------
-- Los abonos vivos de un vendedor, para enseñarlos y poder quitarlos.
-- ---------------------------------------------------------------------------
create or replace function public.fn_abonos_vendedor(
  p_vendedor_id uuid,
  p_incluir_cerrados boolean default false
)
returns table (
  r_abono_id   uuid,
  r_monto      numeric,
  r_fecha_pago date,
  r_nota       text,
  r_cerrado    boolean,
  r_registrado timestamptz
)
language sql
stable
security definer
set search_path = public
as $lista$
  select a.id, a.monto, a.fecha_pago, a.nota,
         a.corte_id is not null,
         a.registrado_en
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id
    and (p_incluir_cerrados or a.corte_id is null)
  order by a.fecha_pago desc, a.registrado_en desc;
$lista$;

comment on function public.fn_abonos_vendedor(uuid, boolean) is
  'Los abonos de un vendedor. Por omisión sólo los que siguen vivos.';

revoke execute on function public.fn_abonos_vendedor(uuid, boolean)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Quiénes deben, ordenados por lo que deben: la ronda de cobro.
-- ---------------------------------------------------------------------------
create or replace function public.fn_cobranza()
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_vendedor    text,
  r_activo      boolean,
  r_sorteos     integer,
  r_desde       date,
  r_hasta       date,
  r_deuda       numeric,
  r_abonado     numeric,
  r_pendiente   numeric,
  r_ultimo_pago date       -- el último abono o corte que se le registró
)
language sql
stable
security definer
set search_path = public
as $cobranza$
  with sin_cerrar as (
    select lq.vendedor_id,
           count(*)::integer                                   as sorteos,
           min(s.fecha)                                        as desde,
           max(s.fecha)                                        as hasta,
           coalesce(sum(lq.venta - lq.comision - lq.premios), 0) as deuda
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where not exists (
      select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
    )
    group by lq.vendedor_id
  ),
  abonos as (
    select a.vendedor_id, coalesce(sum(a.monto), 0) as abonado
    from public.abono_vendedor a
    where a.corte_id is null
    group by a.vendedor_id
  ),
  -- El último movimiento de caja: sirve para saber a quién hace más que no se
  -- le cobra, que es distinto de quién debe más.
  ultimo as (
    select vendedor_id, max(fecha) as fecha from (
      select vendedor_id, fecha_pago as fecha from public.abono_vendedor
      union all
      select vendedor_id, (pagado_en at time zone 'America/Tegucigalpa')::date
        from public.corte_vendedor
    ) t
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         v.activo,
         c.sorteos,
         c.desde,
         c.hasta,
         c.deuda,
         coalesce(b.abonado, 0),
         c.deuda - coalesce(b.abonado, 0),
         u.fecha
  from sin_cerrar c
  join public.vendedor v on v.id = c.vendedor_id
  left join abonos b on b.vendedor_id = c.vendedor_id
  left join ultimo u on u.vendedor_id = c.vendedor_id
  -- Sólo quien debe algo de verdad. Un vendedor cuyo pendiente da cero o
  -- negativo —porque la casa le debe a él— no es asunto de la cobranza.
  where c.deuda - coalesce(b.abonado, 0) > 0
  order by c.deuda - coalesce(b.abonado, 0) desc;
$cobranza$;

comment on function public.fn_cobranza() is
  'Quiénes deben de sorteos sin cerrar, descontados sus abonos, de mayor a menor. Es la lista para salir a cobrar.';

revoke execute on function public.fn_cobranza() from public, anon;


-- ---------------------------------------------------------------------------
-- El corte absorbe los abonos que cubrían esa deuda.
--
-- Sin esto el dinero se contaría DOS VECES: una dentro del corte, que da el
-- saldo entero por cobrado, y otra descontando del pendiente como abono vivo.
-- El vendedor aparecería con saldo a favor de la nada.
--
-- Cuerpo de la 0032 —reubicado en `public` por la mudanza de esquema— con ese
-- cierre añadido y dos columnas más en la salida, para que la pantalla pueda
-- decir «de los 900, ya había entregado 400; recibe 500».
-- ---------------------------------------------------------------------------

/*
 * Se SUELTA antes de recrearla.
 *
 * `create or replace` no puede cambiar el tipo de salida de una función que ya
 * existe, y aquí la salida gana dos columnas —`r_abonado` y `r_resta`—. La
 * base lo rechaza con «cannot change return type of existing function», y
 * tiene razón: quien la llamara esperando seis columnas se encontraría ocho.
 *
 * Soltarla y recrearla en la misma transacción no deja hueco: si algo fallara
 * después, el `drop` se deshace con el resto.
 */
drop function if exists public.fn_registrar_corte(uuid, uuid[], date, date, text, uuid);

create function public.fn_registrar_corte(
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
  r_saldo    numeric,
  r_abonado  numeric,   -- lo que ya había entregado a cuenta
  r_resta    numeric    -- lo que le queda por entregar al cerrar: saldo − abonado
)
language plpgsql
security definer
set search_path = public
as $corte$
declare
  v_corte_id uuid := gen_random_uuid();
  v_ajenas   integer;
  v_sorteos  integer;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
  v_abonado  numeric(14,2);
begin
  -- Inerte bajo `service_role` (0024): la guarda real vive en la Server
  -- Action. Se conserva por coherencia con el resto de funciones.
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if p_liquidacion_ids is null or array_length(p_liquidacion_ids, 1) is null then
    raise exception 'No se eligió ningún sorteo para pagar.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Se bloquean antes de sumarlas: si otra transacción está registrando un
  -- corte con alguna de ellas, ésta espera y luego choca contra el índice
  -- único, en vez de sumar sobre un dato que ya cambió debajo.
  perform 1
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids)
  order by lq.id
  for update;

  -- Ninguna liquidación ajena se cuela en el corte de otro vendedor.
  select count(*) into v_ajenas
  from public.liquidacion lq
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
  from public.liquidacion lq
  where lq.id = any (p_liquidacion_ids);

  if v_sorteos <> array_length(p_liquidacion_ids, 1) then
    raise exception 'Alguna de las liquidaciones elegidas ya no existe.'
      using errcode = 'no_data_found';
  end if;

  insert into public.corte_vendedor (
    id, vendedor_id, desde, hasta, sorteos, venta, comision, premios, saldo,
    nota, usuario_id
  ) values (
    v_corte_id, p_vendedor_id, p_desde, p_hasta, v_sorteos,
    v_venta, v_comision, v_premios, v_venta - v_comision - v_premios,
    nullif(trim(coalesce(p_nota, '')), ''), p_usuario_id
  );

  begin
    insert into public.corte_detalle (corte_id, liquidacion_id)
    select v_corte_id, unnest(p_liquidacion_ids);
  exception when unique_violation then
    raise exception 'Uno de los sorteos elegidos ya se había pagado. Vuelva a cargar el informe.'
      using errcode = 'check_violation';
  end;

  /*
   * LOS ABONOS VIVOS SE ABSORBEN EN ESTE CORTE.
   *
   * El vendedor ya entregó parte de esta deuda a cuenta. Ese dinero está
   * dentro del saldo que el corte da por cobrado, así que si los abonos
   * siguieran vivos se contarían dos veces: una en el corte y otra
   * descontando del pendiente.
   *
   * Se marcan con el corte y dejan de sumar por su cuenta. El apunte no se
   * borra —la fecha en que entregó cada parte es historia de caja— pero pasa
   * a estar contado aquí dentro.
   */
  select coalesce(sum(a.monto), 0) into v_abonado
  from public.abono_vendedor a
  where a.vendedor_id = p_vendedor_id and a.corte_id is null;

  update public.abono_vendedor
  set corte_id = v_corte_id
  where vendedor_id = p_vendedor_id and corte_id is null;

  perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'saldo',
                           null, (v_venta - v_comision - v_premios)::text);

  if v_abonado > 0 then
    perform public.fn_auditar('corte_vendedor', v_corte_id, 'pagar', 'abonado',
                             null, v_abonado::text);
  end if;

  return query
    select v_corte_id, v_sorteos, v_venta, v_comision, v_premios,
           v_venta - v_comision - v_premios,
           v_abonado,
           v_venta - v_comision - v_premios - v_abonado;
end;
$corte$;

comment on function public.fn_registrar_corte(uuid, uuid[], date, date, text, uuid) is
  'Cierra el pago de un conjunto de liquidaciones y absorbe los abonos vivos del vendedor. Recalcula los totales desde la base; no acepta los del cliente.';

revoke execute on function public.fn_registrar_corte(uuid, uuid[], date, date, text, uuid)
  from public, anon;
