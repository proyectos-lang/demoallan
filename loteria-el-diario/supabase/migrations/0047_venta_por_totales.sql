-- ===========================================================================
-- Venta por totales: cuando el vendedor no pasó por el portal.
--
-- Hasta ahora toda venta entraba número a número, y de esas líneas salía todo:
-- la liquidación, los cupos, el mapa de exposición y los informes. Pero hay un
-- caso real que el sistema no cubría: el vendedor trabajó en papel y al final
-- del día entrega su cuenta —«vendí 4.200, pagué 8.400 de premio»— sin el
-- detalle. Sin una puerta para eso, ese día simplemente no existe en el
-- sistema, y todos los indicadores mienten por omisión.
--
-- La puerta es esta tabla, y NO son tickets: son un ajuste de la liquidación.
--
-- POR QUÉ UNA TABLA APARTE Y NO TICKETS SIN LÍNEAS
-- ------------------------------------------------
-- Un ticket sin líneas rompería todo lo que da por hecho que un ticket tiene
-- líneas —el detalle, la anulación, el recibo, el cupo— y obligaría a poner un
-- `if` en cada sitio. Peor: haría indistinguible una venta detallada de una
-- estimada, y eso es justo lo que hay que poder distinguir. Aquí queda en su
-- propia tabla, con su propio origen, y quien quiera separarlas puede.
--
-- NO CONSUME CUPO, POR DECISIÓN
-- -----------------------------
-- No se sabe a qué números jugó, así que no hay cupo que descontar. La
-- consecuencia hay que tenerla presente: el mapa de exposición del sorteo
-- queda incompleto y el tope por número no protege esa venta. La pantalla lo
-- advierte en cada captura. La alternativa —prohibirla en sorteos con cupo ya
-- cargado— se descartó por rígida: obligaría a elegir entre los dos modos para
-- todo el sorteo.
--
-- EL PREMIO SE ACEPTA TAL CUAL
-- ----------------------------
-- Sin números no hay forma de verificarlo contra el ganador: lo teclea quien
-- registra y queda auditado. Es también lo que permite regularizar un día
-- pasado, con el sorteo ya liquidado.
--
-- LA COMISIÓN SE CONGELA al registrar, tomada de `parametro_vendedor`, igual
-- que hace cada línea al venderse. Así un cambio de comisión no reescribe el
-- pasado.
-- ===========================================================================

create table if not exists allan.venta_total (
  id                 uuid primary key default gen_random_uuid(),
  sorteo_id          uuid not null references allan.sorteo(id),
  vendedor_id        uuid not null references allan.vendedor(id),
  venta              numeric(14,2) not null,
  premios            numeric(14,2) not null,
  comision_congelada numeric(6,5)  not null,
  nota               text,
  creado_en          timestamptz not null default now(),
  creado_por         uuid,
  anulado_en         timestamptz,

  constraint venta_total_venta_positiva   check (venta >= 0),
  constraint venta_total_premios_positivo check (premios >= 0),
  constraint venta_total_comision_rango   check (comision_congelada >= 0 and comision_congelada <= 0.60),
  -- Una sola captura viva por vendedor y sorteo: si hay que corregir, se anula
  -- y se vuelve a registrar. Dos capturas del mismo día se sumarían en
  -- silencio y nadie sabría cuál es la buena.
  constraint venta_total_unica unique (sorteo_id, vendedor_id, anulado_en)
);

comment on table allan.venta_total is
  'Venta capturada por totales, sin detalle de números. Para cuando el vendedor no usó el portal.';
comment on column allan.venta_total.premios is
  'El premio total de esa venta. No se verifica contra el número ganador: no hay números que verificar.';

create index if not exists venta_total_sorteo on allan.venta_total (sorteo_id)
  where anulado_en is null;
create index if not exists venta_total_vendedor on allan.venta_total (vendedor_id, sorteo_id)
  where anulado_en is null;


-- --------------------------------------------------------------------------
-- Registrar una venta por totales.
--
-- Deja la liquidación del sorteo al día en el acto: si el sorteo ya estaba
-- liquidado, recalcula esa fila; si no, la captura se recogerá cuando se
-- liquide. En los dos casos, todo lo que lee de `allan.liquidacion` —que es
-- casi todo el sistema— la ve sin cambiar una línea de código.
-- --------------------------------------------------------------------------
create or replace function allan.fn_registrar_venta_total(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_venta       numeric,
  p_premios     numeric,
  p_nota        text default null,
  p_usuario_id  uuid default null
) returns table (r_id uuid, r_comision numeric, r_saldo numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_comision numeric(6,5);
  v_id       uuid;
  v_estado   allan.estado_sorteo;
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.';
  end if;

  select estado into v_estado from allan.sorteo where id = p_sorteo_id;
  if v_estado is null then
    raise exception 'El sorteo no existe.';
  end if;

  -- El vendedor tiene que estar vivo: un dado de baja no genera venta nueva.
  perform 1 from allan.vendedor
   where id = p_vendedor_id and activo and eliminado_en is null;
  if not found then
    raise exception 'El vendedor no está activo.';
  end if;

  select p.comision into v_comision
  from allan.parametro_vendedor p
  where p.vendedor_id = p_vendedor_id and p.vigente_hasta is null
  order by p.vigente_desde desc
  limit 1;

  if v_comision is null then
    raise exception 'El vendedor no tiene comisión vigente configurada.';
  end if;

  insert into allan.venta_total (
    sorteo_id, vendedor_id, venta, premios, comision_congelada, nota, creado_por
  ) values (
    p_sorteo_id, p_vendedor_id, p_venta, p_premios, v_comision, nullif(btrim(p_nota), ''), p_usuario_id
  )
  returning id into v_id;

  perform allan.fn_auditar(
    'venta_total', v_id, 'registrar', 'venta',
    null, p_venta::text, p_usuario_id
  );

  -- Si el sorteo ya estaba liquidado hay que rehacer su fila, o la captura no
  -- aparecería hasta que alguien reliquidara.
  if v_estado = 'liquidado' then
    perform allan.fn_recalcular_liquidacion(p_sorteo_id, p_vendedor_id);
  end if;

  return query
  select v_id,
         round(p_venta * v_comision, 2),
         round(p_venta - p_venta * v_comision - p_premios, 2);
end;
$$;

comment on function allan.fn_registrar_venta_total(uuid, uuid, numeric, numeric, text, uuid) is
  'Registra una venta por totales y deja al día la liquidación del sorteo si ya estaba liquidado.';

revoke execute on function allan.fn_registrar_venta_total(uuid, uuid, numeric, numeric, text, uuid)
  from public, anon;


-- --------------------------------------------------------------------------
-- Anular una captura por totales.
--
-- No se borra: se marca. El histórico de por qué una liquidación dijo lo que
-- dijo tiene que poder reconstruirse.
-- --------------------------------------------------------------------------
create or replace function allan.fn_anular_venta_total(
  p_id         uuid,
  p_usuario_id uuid default null
) returns void
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_sorteo uuid;
  v_vend   uuid;
  v_estado allan.estado_sorteo;
begin
  select vt.sorteo_id, vt.vendedor_id into v_sorteo, v_vend
  from allan.venta_total vt
  where vt.id = p_id and vt.anulado_en is null;

  if v_sorteo is null then
    raise exception 'Esa captura no existe o ya estaba anulada.';
  end if;

  update allan.venta_total set anulado_en = now() where id = p_id;

  perform allan.fn_auditar('venta_total', p_id, 'anular', null, null, null, p_usuario_id);

  select estado into v_estado from allan.sorteo where id = v_sorteo;
  if v_estado = 'liquidado' then
    perform allan.fn_recalcular_liquidacion(v_sorteo, v_vend);
  end if;
end;
$$;

revoke execute on function allan.fn_anular_venta_total(uuid, uuid) from public, anon;
