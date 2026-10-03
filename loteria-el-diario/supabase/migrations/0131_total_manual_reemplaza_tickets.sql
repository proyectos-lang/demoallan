-- ===========================================================================
-- Una captura por totales viva REEMPLAZA los tickets de ese sorteo y vendedor.
--
-- LO QUE PIDIÓ EL USUARIO
-- -----------------------
-- Poder editar a mano (por totales) la venta de un sorteo en la hoja de
-- liquidación AUNQUE el vendedor tenga tickets con números. Y que ese total
-- manual REEMPLACE la venta que hizo la persona, no que se sume a ella.
--
-- EL CAMBIO DE MODELO
-- -------------------
-- Hasta ahora las dos fuentes de venta de un vendedor en un sorteo —los tickets
-- con números (`linea`) y la captura por totales (`venta_total`)— se SUMABAN en
-- todas partes. Era a propósito: «vendió media jornada por el portal y el resto
-- en papel». A partir de aquí la regla es otra, la que pidió el usuario:
--
--   REGLA ÚNICA: para un sorteo + vendedor, si existe una venta_total VIVA
--   (anulado_en is null), la venta / comisión / premios / premiado salen SÓLO
--   de esa captura y los tickets se IGNORAN. Si no hay venta_total viva, los
--   tickets cuentan como siempre.
--
-- Los tickets NO se borran: quedan guardados. Si la captura se anula, vuelven a
-- contar. Es reversible y no toca cupo ni historial.
--
-- EL MARCADO DE LAS LÍNEAS GANADORAS
-- ----------------------------------
-- `linea.gana` / `linea.premio` las leen directamente varias pantallas de
-- premiado, al margen del recálculo. Si se quedaran marcadas cuando hay una
-- venta_total viva, esas pantallas volverían a contar los tickets por detrás y
-- reaparecería el doble conteo. Por eso, cuando hay venta_total viva, las líneas
-- de ese sorteo+vendedor se DESMARCAN (gana=false, premio=0); cuando no la hay,
-- se marcan como siempre.
--
-- DÓNDE SE APLICA LA REGLA
-- ------------------------
-- En las dos funciones que ESCRIBEN la liquidación —`fn_liquidar_sorteo` y
-- `fn_recalcular_liquidacion`— y en las que leen las dos fuentes por su cuenta
-- para informes, paneles y tablero. Las que leen de `liquidacion` ya agregada
-- heredan la regla sin tocarse. Todas usan `fn_fuente_vive` para no tener dos
-- definiciones de «¿hay captura viva?» que puedan divergir.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- La regla, en un solo sitio: ¿este sorteo+vendedor tiene captura por totales
-- viva? Si la tiene, los tickets se ignoran. Una sola función para que la regla
-- no se escriba de diez formas distintas.
-- ---------------------------------------------------------------------------
create or replace function public.fn_tiene_total_vivo(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public
as $vive$
  select exists (
    select 1 from public.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
  );
$vive$;

comment on function public.fn_tiene_total_vivo(uuid, uuid) is
  'Verdadero si ese sorteo+vendedor tiene una captura por totales viva. Cuando lo es, los tickets de números se ignoran: el total manda.';

revoke execute on function public.fn_tiene_total_vivo(uuid, uuid) from public, anon;


-- ---------------------------------------------------------------------------
-- fn_liquidar_sorteo: la liquidación inicial. El total reemplaza los tickets.
-- Cuerpo de la 0048 reubicado en `public`, con la regla de reemplazo y el
-- marcado de líneas condicionado a que NO haya captura viva.
-- ---------------------------------------------------------------------------
create or replace function public.fn_liquidar_sorteo(
  p_sorteo_id      uuid,
  p_numero_ganador smallint
) returns table (
  total_vendedores       integer,
  total_lineas_ganadoras integer,
  total_premios          numeric
)
language plpgsql
security definer
set search_path = public
as $liq$
declare
  v_estado     public.estado_sorteo;
  v_ganadoras  integer;
  v_premios    numeric(14,2);
  v_vendedores integer;
begin
  perform public.fn_exige(array['administrador']::public.rol_usuario[]);

  if p_numero_ganador is null or p_numero_ganador < 0 or p_numero_ganador > 99 then
    raise exception 'Número ganador fuera de rango: %.', p_numero_ganador
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = p_sorteo_id
  for update;

  if not found then
    raise exception 'El sorteo % no existe.', p_sorteo_id
      using errcode = 'no_data_found';
  end if;

  if v_estado <> 'cerrado' then
    raise exception 'Sólo se liquida un sorteo cerrado; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- Marcar las líneas ganadoras, PERO sólo las de vendedores sin captura viva:
  -- si hay captura, sus tickets se ignoran y no deben figurar como premiados.
  update public.linea l
  set gana = true,
      premio = l.monto * l.factor_congelado
  from public.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.numero = p_numero_ganador
    and not public.fn_tiene_total_vivo(p_sorteo_id, t.vendedor_id);

  get diagnostics v_ganadoras = row_count;

  -- Y desmarcar las de quien SÍ tiene captura viva, por si traían marca de una
  -- liquidación anterior: su premio no cuenta, lo dice el total.
  update public.linea l
  set gana = false, premio = 0
  from public.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and t.anulado_en is null
    and l.gana
    and public.fn_tiene_total_vivo(p_sorteo_id, t.vendedor_id);

  /*
   * La liquidación por vendedor. Para cada uno, UNA de las dos fuentes:
   *   · con captura viva → sólo la captura;
   *   · sin captura      → sólo los tickets.
   * El `full join` sigue haciendo falta para no perder a quien tiene sólo una,
   * pero el `case` elige la fuente en vez de sumarlas.
   */
  insert into public.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad, usuario_id
  )
  select p_sorteo_id,
         coalesce(d.vendedor_id, v.vendedor_id),
         case when v.vendedor_id is not null then v.venta    else coalesce(d.venta, 0)    end,
         case when v.vendedor_id is not null then v.comision else coalesce(d.comision, 0) end,
         case when v.vendedor_id is not null then v.premios  else coalesce(d.premios, 0)  end,
         case when v.vendedor_id is not null
              then v.venta - v.comision - v.premios
              else coalesce(d.venta, 0) - coalesce(d.comision, 0) - coalesce(d.premios, 0)
         end,
         auth.uid()
  from (
    select t.vendedor_id,
           sum(l.monto)                        as venta,
           sum(l.monto * l.comision_congelada) as comision,
           sum(l.premio)                       as premios
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
    group by t.vendedor_id
  ) d
  full join (
    select vt.vendedor_id,
           sum(vt.venta)                         as venta,
           sum(vt.venta * vt.comision_congelada) as comision,
           sum(vt.premios)                       as premios
    from public.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.anulado_en is null
    group by vt.vendedor_id
  ) v on v.vendedor_id = d.vendedor_id;

  get diagnostics v_vendedores = row_count;

  select coalesce(sum(lq.premios), 0) into v_premios
  from public.liquidacion lq
  where lq.sorteo_id = p_sorteo_id;

  update public.sorteo
  set estado = 'liquidado',
      numero_ganador = p_numero_ganador,
      liquidado_en = now(),
      liquidado_por = auth.uid()
  where id = p_sorteo_id;

  perform public.fn_auditar('sorteo', p_sorteo_id, 'liquidar', 'numero_ganador',
                           null, lpad(p_numero_ganador::text, 2, '0'));

  return query select v_vendedores, v_ganadoras, v_premios;
end;
$liq$;

comment on function public.fn_liquidar_sorteo(uuid, smallint) is
  'Liquida un sorteo. Para cada vendedor, si tiene captura por totales viva usa sólo esa; si no, usa sus tickets. El total reemplaza a los tickets, no se suma.';

revoke execute on function public.fn_liquidar_sorteo(uuid, smallint) from public, anon;


-- ---------------------------------------------------------------------------
-- fn_recalcular_liquidacion: el recálculo de un vendedor. Misma regla.
-- Cuerpo de la 0118 (ajuste único vivo) con el reemplazo y el marcado
-- condicionado. Todo lo del ajuste por corrección se conserva igual.
-- ---------------------------------------------------------------------------
create or replace function public.fn_recalcular_liquidacion(
  p_sorteo_id   uuid,
  p_vendedor_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $recalc$
declare
  v_sorteo    record;
  v_venta     numeric;
  v_comision  numeric;
  v_premios   numeric;
  v_liq       record;
  v_viejo     numeric;
  v_nuevo     numeric;
  v_delta     numeric;
  v_ajuste_id uuid;
  v_hay_total boolean;
begin
  select id, numero_ganador, estado into v_sorteo
  from public.sorteo where id = p_sorteo_id;

  if v_sorteo.id is null or v_sorteo.estado <> 'liquidado' then
    return;
  end if;

  v_hay_total := public.fn_tiene_total_vivo(p_sorteo_id, p_vendedor_id);

  if v_hay_total then
    -- Con captura viva, los tickets se ignoran: se desmarca cualquier línea
    -- ganadora para que no la cuente ninguna pantalla de premiado.
    update public.linea l
    set gana = false, premio = 0
    from public.ticket t
    where t.id = l.ticket_id
      and t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana;
  else
    -- Sin captura: las líneas nuevas que acertaron se marcan como siempre.
    update public.linea l
    set gana = true,
        premio = l.monto * l.factor_congelado
    from public.ticket t
    where t.id = l.ticket_id
      and t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.numero = v_sorteo.numero_ganador
      and not l.gana;
  end if;

  if v_hay_total then
    -- La fuente es SÓLO la captura por totales.
    select coalesce(sum(vt.venta), 0),
           coalesce(sum(vt.venta * vt.comision_congelada), 0),
           coalesce(sum(vt.premios), 0)
      into v_venta, v_comision, v_premios
    from public.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null;
  else
    -- La fuente son SÓLO los tickets.
    select coalesce(sum(l.monto), 0),
           coalesce(sum(l.monto * l.comision_congelada), 0),
           coalesce(sum(l.premio), 0)
      into v_venta, v_comision, v_premios
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = p_sorteo_id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null;
  end if;

  v_nuevo := v_venta - v_comision - v_premios;

  select lq.id,
         lq.venta - lq.comision - lq.premios as utilidad
    into v_liq
  from public.liquidacion lq
  join public.corte_detalle d on d.liquidacion_id = lq.id
  where lq.sorteo_id = p_sorteo_id and lq.vendedor_id = p_vendedor_id;

  if found then
    -- YA PAGADA: la liquidación no se toca. La diferencia va al ajuste vivo.
    v_viejo := v_liq.utilidad;
    v_delta := round(v_nuevo - v_viejo, 2);

    select id into v_ajuste_id
    from public.ajuste_liquidacion
    where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id
      and saldado_corte_id is null;

    if v_delta = 0 then
      if v_ajuste_id is not null then
        delete from public.ajuste_liquidacion where id = v_ajuste_id;
      end if;
    elsif v_ajuste_id is not null then
      update public.ajuste_liquidacion
      set monto = v_delta, motivo = 'Corrección de un sorteo ya liquidado', creado_en = now()
      where id = v_ajuste_id;
    else
      insert into public.ajuste_liquidacion (vendedor_id, sorteo_id, monto, motivo)
      values (p_vendedor_id, p_sorteo_id, v_delta, 'Corrección de un sorteo ya liquidado');
    end if;

    if v_delta <> 0 then
      perform public.fn_auditar('ajuste_liquidacion', v_liq.id, 'ajustar', 'monto',
                                v_viejo::text, v_nuevo::text);
    end if;
    return;
  end if;

  -- SIN pagar: la liquidación se rehace.
  if v_venta = 0 and v_premios = 0 then
    delete from public.liquidacion
     where sorteo_id = p_sorteo_id and vendedor_id = p_vendedor_id;
    return;
  end if;

  insert into public.liquidacion (
    sorteo_id, vendedor_id, venta, comision, premios, utilidad
  ) values (
    p_sorteo_id, p_vendedor_id, v_venta, v_comision, v_premios, v_nuevo
  )
  on conflict (sorteo_id, vendedor_id) do update
  set venta    = excluded.venta,
      comision = excluded.comision,
      premios  = excluded.premios,
      utilidad = excluded.utilidad;
end;
$recalc$;

revoke execute on function public.fn_recalcular_liquidacion(uuid, uuid) from public, anon;


-- ---------------------------------------------------------------------------
-- fn_editar_liquidacion_manual: ahora EDITA aunque el vendedor tenga tickets.
--
-- Hasta la 0106, un sorteo con tickets de números se rechazaba: «corríjalos
-- desde la venta». Con el modelo nuevo ya no hace falta vetarlo: la captura por
-- totales que escribe esta función REEMPLAZA los tickets (el recálculo los
-- ignora en cuanto hay una captura viva). Así el usuario puede teclear el total
-- en la hoja y ese total manda, que es justo lo que pidió.
--
-- Los tickets no se borran —quedan guardados—; sólo dejan de contar mientras
-- haya captura viva. Si la captura se anula, vuelven a contar.
-- ---------------------------------------------------------------------------
create or replace function public.fn_editar_liquidacion_manual(
  p_liquidacion_id uuid,
  p_venta          numeric,
  p_premios        numeric,
  p_usuario_id     uuid default null
) returns table (r_venta numeric, r_comision numeric, r_premios numeric, r_saldo numeric)
language plpgsql
security definer
set search_path = public
as $manual$
declare
  v_liq        public.liquidacion%rowtype;
  v_estado     public.estado_sorteo;
  v_vt_id      uuid;
  v_comision   numeric(6,5);
begin
  if p_venta is null or p_venta < 0 then
    raise exception 'La venta no puede ser negativa.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_premios is null or p_premios < 0 then
    raise exception 'El premio no puede ser negativo.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_liq
  from public.liquidacion where id = p_liquidacion_id;

  if not found then
    raise exception 'Esa liquidación no existe.'
      using errcode = 'no_data_found';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_liq.sorteo_id;

  -- Ya NO se rechaza por tener tickets: la captura que se escribe aquí los
  -- reemplaza. Lo que se teclea en la hoja es lo que manda.

  -- La captura por totales viva de ese sorteo y vendedor, si la hay.
  select id into v_vt_id
  from public.venta_total
  where sorteo_id = v_liq.sorteo_id
    and vendedor_id = v_liq.vendedor_id
    and anulado_en is null;

  if found then
    -- Camino normal: reescribir la captura. `fn_editar_venta_total` audita el
    -- antes/después y dispara el recálculo (el sorteo está liquidado: la hoja
    -- sólo muestra sorteos con número ganador).
    perform public.fn_editar_venta_total(v_vt_id, p_venta, p_premios, null, p_usuario_id);
  else
    -- No hay captura viva: se crea con la comisión vigente. Si el vendedor tenía
    -- tickets, esta captura pasa a mandar y el recálculo los ignora de aquí en
    -- adelante.
    select p.comision into v_comision
    from public.parametro_vendedor p
    where p.vendedor_id = v_liq.vendedor_id and p.vigente_hasta is null
    order by p.vigente_desde desc
    limit 1;

    if v_comision is null then
      raise exception 'El vendedor no tiene comisión vigente configurada.'
        using errcode = 'no_data_found';
    end if;

    insert into public.venta_total (
      sorteo_id, vendedor_id, venta, premios, comision_congelada, nota, creado_por
    ) values (
      v_liq.sorteo_id, v_liq.vendedor_id, p_venta, p_premios, v_comision,
      'Edición manual desde la hoja', p_usuario_id
    )
    returning id into v_vt_id;

    perform public.fn_auditar('venta_total', v_vt_id, 'registrar', 'venta',
                              null, p_venta::text, p_usuario_id);

    if v_estado = 'liquidado' then
      perform public.fn_recalcular_liquidacion(v_liq.sorteo_id, v_liq.vendedor_id);
    end if;
  end if;

  select lq.venta, lq.comision, lq.premios, lq.venta - lq.comision - lq.premios
    into r_venta, r_comision, r_premios, r_saldo
  from public.liquidacion lq
  where lq.sorteo_id = v_liq.sorteo_id and lq.vendedor_id = v_liq.vendedor_id;

  r_venta    := coalesce(r_venta, 0);
  r_comision := coalesce(r_comision, 0);
  r_premios  := coalesce(r_premios, 0);
  r_saldo    := coalesce(r_saldo, 0);
  return next;
end;
$manual$;

comment on function public.fn_editar_liquidacion_manual(uuid, numeric, numeric, uuid) is
  'Corrige a mano venta/premios de un sorteo por totales desde la hoja. Ya NO rechaza sorteos con tickets: la captura que escribe reemplaza esos tickets (el recálculo los ignora mientras la captura viva). No borra los tickets.';

revoke execute on function public.fn_editar_liquidacion_manual(uuid, numeric, numeric, uuid)
  from public, anon;


-- ===========================================================================
-- PANELES DEL VENDEDOR: la captura reemplaza los tickets (no se suman).
--
-- En `fn_mi_dia` y `fn_mi_periodo` el CTE `admin` sólo trae filas de sorteos con
-- captura viva del vendedor. La regla: si ese sorteo tiene captura (a.sorteo_id
-- no nulo) se usa SÓLO `admin`; si no, SÓLO `propio`. `r_venta_admin` sigue
-- diciendo cuánto vino de administración —ahora, cuando hay captura, es toda la
-- venta—.
-- ===========================================================================
drop function if exists public.fn_mi_dia(uuid, date);

create function public.fn_mi_dia(p_vendedor_id uuid, p_fecha date)
returns table (
  r_sorteo_id     uuid,
  r_hora          public.hora_sorteo,
  r_estado        public.estado_sorteo,
  r_ganador       smallint,
  r_tickets       integer,
  r_venta         numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_venta_admin   numeric,
  r_capturas      integer
)
language sql
stable
security definer
set search_path = public
as $dia$
  with propio as (
    select s.id as sorteo_id,
           count(distinct t.id)::integer            as tickets,
           coalesce(sum(l.monto), 0)                as venta,
           coalesce(sum(l.monto * l.comision_congelada), 0) as comision,
           coalesce(sum(l.premio), 0)               as premios
    from public.sorteo s
    left join public.ticket t
      on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
    left join public.linea l on l.ticket_id = t.id
    where s.fecha = p_fecha
    group by s.id
  ),
  admin as (
    select vt.sorteo_id,
           count(*)::integer                                  as capturas,
           coalesce(sum(vt.venta), 0)                         as venta,
           coalesce(sum(vt.venta * vt.comision_congelada), 0)  as comision,
           coalesce(sum(vt.premios), 0)                        as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.id, s.hora, s.estado, s.numero_ganador,
         p.tickets,
         -- Con captura viva, sólo la captura; si no, sólo los tickets.
         case when a.sorteo_id is not null then a.venta    else p.venta    end,
         case when a.sorteo_id is not null then a.comision else p.comision end,
         case when a.sorteo_id is not null then a.premios  else p.premios  end,
         coalesce(a.venta, 0),
         coalesce(a.capturas, 0)
  from public.sorteo s
  join propio p on p.sorteo_id = s.id
  left join admin a on a.sorteo_id = s.id
  where s.fecha = p_fecha
  order by s.hora;
$dia$;

comment on function public.fn_mi_dia(uuid, date) is
  'El día de un vendedor. Si un sorteo tiene captura por totales viva, usa sólo esa; si no, sus tickets. El total reemplaza a los tickets.';

revoke execute on function public.fn_mi_dia(uuid, date) from public, anon, authenticated;


drop function if exists public.fn_mi_periodo(uuid, date, date);

create function public.fn_mi_periodo(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_fecha         date,
  r_hora          public.hora_sorteo,
  r_estado        public.estado_sorteo,
  r_ganador       smallint,
  r_tickets       integer,
  r_venta         numeric,
  r_premiado      numeric,
  r_comision      numeric,
  r_premios       numeric,
  r_pagado        boolean,
  r_venta_admin   numeric,
  r_capturas      integer
)
language sql
stable
security definer
set search_path = public
as $periodo$
  with propio as (
    select s.id as sorteo_id,
           count(distinct t.id)::integer                        as tickets,
           coalesce(sum(l.monto), 0)                            as venta,
           coalesce(sum(l.monto) filter (where l.gana), 0)       as premiado,
           coalesce(sum(l.monto * l.comision_congelada), 0)      as comision,
           coalesce(sum(l.premio), 0)                            as premios
    from public.sorteo s
    left join public.ticket t
      on t.sorteo_id = s.id and t.vendedor_id = p_vendedor_id and t.anulado_en is null
    left join public.linea l on l.ticket_id = t.id
    where s.fecha between p_desde and p_hasta
    group by s.id
  ),
  admin as (
    select vt.sorteo_id,
           count(*)::integer                                   as capturas,
           coalesce(sum(vt.venta), 0)                          as venta,
           coalesce(sum(vt.venta * vt.comision_congelada), 0)   as comision,
           coalesce(sum(vt.premios), 0)                         as premios,
           coalesce(sum(
             case when s.estado = 'liquidado' and coalesce(pv.factor_pago, 0) > 0
                  then round(vt.premios / pv.factor_pago, 2)
                  else 0 end
           ), 0) as premiado
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id
          and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.fecha, s.hora, s.estado, s.numero_ganador,
         p.tickets,
         -- Con captura viva, sólo la captura; si no, sólo los tickets.
         case when a.sorteo_id is not null then a.venta    else p.venta    end,
         case when a.sorteo_id is not null then a.premiado else p.premiado end,
         case when a.sorteo_id is not null then a.comision else p.comision end,
         case when a.sorteo_id is not null then a.premios  else p.premios  end,
         exists (
           select 1
           from public.liquidacion lq
           join public.corte_detalle d on d.liquidacion_id = lq.id
           where lq.sorteo_id = s.id and lq.vendedor_id = p_vendedor_id
         ),
         coalesce(a.venta, 0),
         coalesce(a.capturas, 0)
  from public.sorteo s
  join propio p on p.sorteo_id = s.id
  left join admin a on a.sorteo_id = s.id
  where s.fecha between p_desde and p_hasta
  order by s.fecha, s.hora;
$periodo$;

comment on function public.fn_mi_periodo(uuid, date, date) is
  'El período de un vendedor. Si un sorteo tiene captura por totales viva, usa sólo esa; si no, sus tickets. El total reemplaza, no se suma.';

revoke execute on function public.fn_mi_periodo(uuid, date, date) from public, anon;


-- ===========================================================================
-- TABLERO DEL DÍA: la captura reemplaza los tickets, por vendedor.
--
-- Estos agregan por SORTEO (todos los vendedores juntos), así que la regla se
-- aplica vendedor a vendedor antes de sumar: los tickets de un vendedor con
-- captura viva se descartan con `fn_tiene_total_vivo`, y la captura entra como
-- su única venta. Un sorteo puede mezclar vendedores de las dos clases.
-- ===========================================================================
create or replace function public.fn_resumen_dia(p_fecha date)
returns table (
  sorteo_id      uuid,
  hora           public.hora_sorteo,
  estado         public.estado_sorteo,
  numero_ganador smallint,
  tickets        integer,
  venta          numeric,
  comision       numeric,
  premios        numeric,
  utilidad       numeric
)
language sql
stable
security definer
set search_path = public
as $resumen_dia$
  with
  -- Lo vendido por el portal, PERO sólo de vendedores sin captura viva en ese
  -- sorteo: los que tienen captura se cuentan por su total, no por sus tickets.
  por_linea as (
    select a.sorteo_id,
           sum(a.tickets)  as tickets,
           sum(a.venta)    as venta,
           sum(a.comision) as comision,
           sum(a.premios)  as premios
    from public.v_agregado_sorteo_vendedor a
    where a.fecha = p_fecha
      and not public.fn_tiene_total_vivo(a.sorteo_id, a.vendedor_id)
    group by a.sorteo_id
  ),
  por_total as (
    select vt.sorteo_id,
           sum(vt.venta)                            as venta,
           sum(vt.venta * vt.comision_congelada)    as comision,
           sum(case when s.estado = 'liquidado' then vt.premios else 0 end) as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.anulado_en is null
    group by vt.sorteo_id
  )
  select s.id, s.hora, s.estado, s.numero_ganador,
         -- Los tickets contados son sólo los de vendedores sin captura.
         coalesce(a.tickets, 0)::integer,
         coalesce(a.venta, 0)    + coalesce(b.venta, 0),
         coalesce(a.comision, 0) + coalesce(b.comision, 0),
         coalesce(a.premios, 0)  + coalesce(b.premios, 0),
         (coalesce(a.venta, 0)    + coalesce(b.venta, 0))
       - (coalesce(a.comision, 0) + coalesce(b.comision, 0))
       - (coalesce(a.premios, 0)  + coalesce(b.premios, 0))
  from public.sorteo s
  left join por_linea a on a.sorteo_id = s.id
  left join por_total b on b.sorteo_id = s.id
  where s.fecha = p_fecha
  order by s.hora;
$resumen_dia$;

comment on function public.fn_resumen_dia(date) is
  'Un día, sorteo por sorteo. Por cada vendedor, si tiene captura por totales viva cuenta sólo ésa; si no, sus tickets. El total reemplaza a los tickets.';

revoke execute on function public.fn_resumen_dia(date) from public, anon;


create or replace function public.fn_desglose_dia(p_fecha date)
returns table (
  vendedor_id uuid,
  nombre      text,
  hora        public.hora_sorteo,
  estado      public.estado_sorteo,
  venta       numeric,
  comision    numeric,
  premios     numeric,
  utilidad    numeric
)
language sql
stable
security definer
set search_path = public
as $desglose$
  with
  por_linea as (
    select a.vendedor_id, a.sorteo_id,
           a.venta, a.comision, a.premios
    from public.v_agregado_sorteo_vendedor a
    where a.fecha = p_fecha
  ),
  por_total as (
    select vt.vendedor_id, vt.sorteo_id,
           vt.venta                          as venta,
           vt.venta * vt.comision_congelada  as comision,
           case when s.estado = 'liquidado' then vt.premios else 0 end as premios
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    where s.fecha = p_fecha
      and vt.anulado_en is null
  ),
  juntos as (
    -- Una fila por vendedor y sorteo. Si hay captura (b no nulo), manda la
    -- captura y los tickets se ignoran; si no, mandan los tickets.
    select coalesce(a.vendedor_id, b.vendedor_id) as vendedor_id,
           coalesce(a.sorteo_id,   b.sorteo_id)   as sorteo_id,
           case when b.vendedor_id is not null then b.venta    else coalesce(a.venta,    0) end as venta,
           case when b.vendedor_id is not null then b.comision else coalesce(a.comision, 0) end as comision,
           case when b.vendedor_id is not null then b.premios  else coalesce(a.premios,  0) end as premios
    from por_linea a
    full join por_total b
      on b.vendedor_id = a.vendedor_id
     and b.sorteo_id   = a.sorteo_id
  )
  select j.vendedor_id,
         public.fn_rotulo(v.alias, v.nombre),
         s.hora, s.estado,
         j.venta, j.comision, j.premios,
         j.venta - j.comision - j.premios
  from juntos j
  join public.vendedor v on v.id = j.vendedor_id
  join public.sorteo   s on s.id = j.sorteo_id
  order by v.codigo, s.hora;
$desglose$;

comment on function public.fn_desglose_dia(date) is
  'Un día, desglose por vendedor y sorteo. Si hay captura por totales viva, cuenta sólo ésa; si no, los tickets. El total reemplaza, no se suma.';

revoke execute on function public.fn_desglose_dia(date) from public, anon;


-- ===========================================================================
-- HOJA DEL VENDEDOR (fn_semana_completa): el premiado respeta el reemplazo.
--
-- venta/comisión/premios salen de `liquidacion`, que ya hereda la regla. Lo
-- único que combinaba fuentes era el PREMIADO (lo apostado al ganador): sumaba
-- lo acertado en tickets + lo deducido de las capturas. Ahora, si el sorteo
-- tiene captura viva del vendedor, el premiado es sólo el de la captura; si no,
-- sólo el de los tickets. Se excluye el acertado de tickets de sorteos con
-- captura viva, para no depender sólo del desmarcado de `linea.gana`.
-- ===========================================================================
create or replace function public.fn_semana_completa(
  p_vendedor_id uuid,
  p_desde       date,
  p_hasta       date
) returns table (
  r_liquidacion_id uuid,
  r_fecha          date,
  r_hora           public.hora_sorteo,
  r_numero_ganador smallint,
  r_venta          numeric,
  r_premiado       numeric,
  r_factor         numeric,
  r_comision       numeric,
  r_premios        numeric,
  r_saldo          numeric,
  r_corte_id       uuid,
  r_pagado_en      timestamptz
)
language sql
stable
security definer
set search_path = public
as $semana$
  with acertado as (
    -- Lo apostado al número ganador en los tickets, SALVO en sorteos donde el
    -- vendedor tiene captura viva: ahí los tickets no cuentan.
    select t.sorteo_id, sum(l.monto) as premiado
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and l.gana
      and s.fecha between p_desde and p_hasta
      and not public.fn_tiene_total_vivo(t.sorteo_id, p_vendedor_id)
    group by t.sorteo_id
  ),
  capturado as (
    select vt.sorteo_id,
           sum(
             case when s.estado = 'liquidado' and coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
                  then round(vt.premios / coalesce(vt.factor_congelado, pv.factor_pago), 2)
                  else 0 end
           ) as premiado
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id
          and pv.vigente_hasta is null
    where vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
      and s.fecha between p_desde and p_hasta
    group by vt.sorteo_id
  ),
  premiado as (
    select sorteo_id, sum(premiado) as premiado
    from (
      select sorteo_id, premiado from acertado
      union all
      select sorteo_id, premiado from capturado
    ) u
    group by sorteo_id
  )
  select lq.id,
         s.fecha,
         s.hora,
         s.numero_ganador,
         lq.venta,
         coalesce(p.premiado, 0),
         case when coalesce(p.premiado, 0) > 0
              then round(lq.premios / p.premiado, 2) else 0 end,
         lq.comision,
         lq.premios,
         lq.venta - lq.comision - lq.premios,
         d.corte_id,
         cv.pagado_en
  from public.liquidacion lq
  join public.sorteo s on s.id = lq.sorteo_id
  left join premiado p on p.sorteo_id = s.id
  left join public.corte_detalle d on d.liquidacion_id = lq.id
  left join public.corte_vendedor cv on cv.id = d.corte_id
  where lq.vendedor_id = p_vendedor_id
    and s.fecha between p_desde and p_hasta
  order by s.fecha, s.hora;
$semana$;

revoke execute on function public.fn_semana_completa(uuid, date, date) from public, anon;


-- ===========================================================================
-- INFORME DE GERENCIA: el total reemplaza los tickets en lo pendiente y en el
-- premiado. Lo liquidado sale de `liquidacion` (ya hereda la regla). En las
-- ramas que miran las dos fuentes, las líneas de un vendedor con captura viva
-- en ese sorteo se excluyen.
-- ===========================================================================
create or replace function public.fn_informe_gerencia(
  p_desde date,
  p_hasta date,
  p_hora  public.hora_sorteo default null
) returns table (
  r_vendedor_id     uuid,
  r_codigo          text,
  r_nombre          text,
  r_venta           numeric,
  r_venta_pendiente numeric,
  r_premiado        numeric,
  r_factor          numeric,
  r_pago            numeric,
  r_porcentaje      numeric,
  r_comision        numeric,
  r_bruto           numeric,
  r_neto            numeric,
  r_tiene_pendiente boolean
)
language sql
stable
security definer
set search_path = public
as $informe$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
    group by lq.vendedor_id
  ),
  pendiente as (
    -- Sorteos sin liquidar. Con captura viva manda la captura; si no, los
    -- tickets. Las líneas de un vendedor con captura viva en ese sorteo quedan
    -- fuera para no sumarse al total.
    select vendedor_id, sum(venta) as venta, sum(comision) as comision
    from (
      select t.vendedor_id,
             sum(l.monto)                        as venta,
             sum(l.monto * l.comision_congelada) as comision
      from public.linea l
      join public.ticket t on t.id = l.ticket_id
      join public.sorteo s on s.id = t.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and s.estado <> 'liquidado'
        and t.anulado_en is null
        and not public.fn_tiene_total_vivo(t.sorteo_id, t.vendedor_id)
      group by t.vendedor_id

      union all

      select vt.vendedor_id,
             sum(vt.venta),
             sum(vt.venta * vt.comision_congelada)
      from public.venta_total vt
      join public.sorteo s on s.id = vt.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and s.estado <> 'liquidado'
        and vt.anulado_en is null
      group by vt.vendedor_id
    ) u
    group by vendedor_id
  ),
  acertado as (
    -- Lo apostado al ganador. De tickets, salvo donde el vendedor tiene captura
    -- viva (ahí no cuentan sus tickets); de capturas, deducido del factor.
    select vendedor_id, sum(premiado) as premiado
    from (
      select t.vendedor_id, sum(l.monto) as premiado
      from public.linea l
      join public.ticket t on t.id = l.ticket_id
      join public.sorteo s on s.id = t.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and t.anulado_en is null
        and l.gana
        and not public.fn_tiene_total_vivo(t.sorteo_id, t.vendedor_id)
      group by t.vendedor_id

      union all

      select vt.vendedor_id,
             sum(
               case when coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
                    then round(vt.premios / coalesce(vt.factor_congelado, pv.factor_pago), 2)
               end
             )
      from public.venta_total vt
      join public.sorteo s on s.id = vt.sorteo_id
      left join public.parametro_vendedor pv
             on pv.vendedor_id = vt.vendedor_id
            and pv.vigente_hasta is null
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and vt.anulado_en is null
        and s.estado = 'liquidado'
      group by vt.vendedor_id
    ) u
    group by vendedor_id
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         coalesce(q.venta, 0) + coalesce(p.venta, 0),
         coalesce(p.venta, 0),
         coalesce(a.premiado, 0),
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         case when q.vendedor_id is not null then coalesce(q.premios, 0) end,
         case when coalesce(q.venta, 0) + coalesce(p.venta, 0) > 0
              then round((coalesce(q.comision, 0) + coalesce(p.comision, 0))
                         / (coalesce(q.venta, 0) + coalesce(p.venta, 0)), 4)
              else 0 end,
         coalesce(q.comision, 0) + coalesce(p.comision, 0),
         coalesce(q.venta, 0) + coalesce(p.venta, 0)
           - coalesce(q.comision, 0) - coalesce(p.comision, 0),
         case when q.vendedor_id is not null
              then coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
         end,
         p.vendedor_id is not null
  from public.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join pendiente p on p.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  where v.activo or q.venta is not null or p.venta is not null
  order by lower(public.fn_rotulo(v.alias, v.nombre)), v.codigo;
$informe$;

revoke execute on function public.fn_informe_gerencia(date, date, public.hora_sorteo)
  from public, anon;


-- ===========================================================================
-- TABLERO DE CONTROL: lo pendiente respeta el reemplazo.
--
-- Lo liquidado sale de `liquidacion` (hereda). En lo pendiente, los tickets de
-- un vendedor con captura viva en ese sorteo se excluyen —manda su captura—.
-- Los CONTEOS de tickets/líneas no cambian: un ticket sigue existiendo aunque
-- su venta no cuente; sólo se dejan de contar sus lempiras.
-- ===========================================================================
create or replace function public.fn_control_vendedores(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       public.hora_sorteo default null
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
set search_path = public
as $control_vendedores$
  with
  sorteos as (
    select s.id, s.estado
    from public.sorteo s
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
  ),
  liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)     as venta,
           sum(lq.comision)  as comision,
           sum(lq.premios)   as premios,
           sum(lq.venta) - sum(lq.comision) - sum(lq.premios) as utilidad
    from public.liquidacion lq
    join sorteos s on s.id = lq.sorteo_id
    where p_vendedores is null or lq.vendedor_id = any (p_vendedores)
    group by lq.vendedor_id
  ),
  -- Tickets de sorteos sin liquidar, SALVO los de vendedores con captura viva
  -- en ese sorteo: ahí manda la captura.
  sin_liquidar_tickets as (
    select t.vendedor_id, sum(l.monto) as pendiente
    from sorteos s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where s.estado <> 'liquidado'
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
      and not public.fn_tiene_total_vivo(s.id, t.vendedor_id)
    group by t.vendedor_id
  ),
  sin_liquidar_totales as (
    select vt.vendedor_id, sum(vt.venta) as pendiente
    from sorteos s
    join public.venta_total vt on vt.sorteo_id = s.id and vt.anulado_en is null
    where s.estado <> 'liquidado'
      and (p_vendedores is null or vt.vendedor_id = any (p_vendedores))
    group by vt.vendedor_id
  ),
  conteos as (
    select t.vendedor_id,
           count(distinct t.id) as tickets,
           count(l.id)          as lineas
    from sorteos s
    join public.ticket t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea  l on l.ticket_id = t.id
    where p_vendedores is null or t.vendedor_id = any (p_vendedores)
    group by t.vendedor_id
  )
  select v.id, v.codigo, public.fn_rotulo(v.alias, v.nombre), v.zona, v.color,
         coalesce(c.tickets, 0)::integer,
         coalesce(c.lineas, 0)::integer,
         coalesce(q.venta, 0) + coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0),
         coalesce(q.comision, 0),
         coalesce(q.premios, 0),
         coalesce(q.utilidad, 0),
         coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0)
  from public.vendedor v
  left join liquidado            q on q.vendedor_id = v.id
  left join sin_liquidar_tickets p on p.vendedor_id = v.id
  left join sin_liquidar_totales x on x.vendedor_id = v.id
  left join conteos              c on c.vendedor_id = v.id
  where v.activo
    and (p_vendedores is null or v.id = any (p_vendedores))
  order by coalesce(q.venta, 0) + coalesce(p.pendiente, 0) + coalesce(x.pendiente, 0) desc,
           v.codigo;
$control_vendedores$;

comment on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo) is
  'Tablero de control por vendedor. Liquidado desde `liquidacion`; lo pendiente, de tickets o de captura por totales —si hay captura viva en el sorteo, manda ésa—.';

revoke execute on function public.fn_control_vendedores(date, date, uuid[], public.hora_sorteo)
  from public, anon;


-- ===========================================================================
-- SIMULADOR: el total reemplaza los tickets también en el escenario.
--
-- La rama de tickets excluye las líneas de un vendedor con captura viva en ese
-- sorteo; la rama de venta_total aporta la captura. Así el volumen base no
-- cuenta dos veces lo mismo.
-- ===========================================================================
create or replace function public.fn_simular(
  p_desde    date,
  p_hasta    date,
  p_comision numeric,
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
set search_path = public
as $simular$
  with base as (
    select s.fecha,
           l.monto                                as venta,
           l.monto * l.comision_congelada         as comision_real,
           l.premio                               as premios_real,
           case when l.gana then l.monto else 0 end as apostado_ganador
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and t.anulado_en is null
      and not public.fn_tiene_total_vivo(t.sorteo_id, t.vendedor_id)

    union all

    select s.fecha,
           vt.venta,
           vt.venta * vt.comision_congelada,
           vt.premios,
           case
             when coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
             then vt.premios / coalesce(vt.factor_congelado, pv.factor_pago)
             else 0
           end
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and vt.anulado_en is null
  )
  select extract(year  from fecha)::integer,
         extract(month from fecha)::integer - 1,
         count(distinct fecha)::integer,
         sum(venta),
         sum(comision_real),
         sum(premios_real),
         sum(venta) - sum(comision_real) - sum(premios_real),
         sum(venta) * p_comision,
         sum(apostado_ganador) * p_factor,
         sum(venta) - sum(venta) * p_comision - sum(apostado_ganador) * p_factor
  from base
  group by 1, 2
  order by 1, 2;
$simular$;

comment on function public.fn_simular(date, date, numeric, numeric) is
  'Simula comisión/premio con parámetros alternos, mes a mes. Por sorteo+vendedor, si hay captura por totales viva usa sólo ésa; si no, los tickets.';

revoke execute on function public.fn_simular(date, date, numeric, numeric) from public, anon;


create or replace function public.fn_parametros_ponderados(
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
set search_path = public
as $ponderados$
  with base as (
    select l.monto                                as venta,
           l.monto * l.comision_congelada         as comision_real,
           l.premio                               as premios_real,
           case when l.gana then l.monto else 0 end as apostado_ganador
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    join public.sorteo s on s.id = t.sorteo_id
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and t.anulado_en is null
      and not public.fn_tiene_total_vivo(t.sorteo_id, t.vendedor_id)

    union all

    select vt.venta,
           vt.venta * vt.comision_congelada,
           vt.premios,
           case
             when coalesce(vt.factor_congelado, pv.factor_pago, 0) > 0
             then vt.premios / coalesce(vt.factor_congelado, pv.factor_pago)
             else 0
           end
    from public.venta_total vt
    join public.sorteo s on s.id = vt.sorteo_id
    left join public.parametro_vendedor pv
           on pv.vendedor_id = vt.vendedor_id and pv.vigente_hasta is null
    where s.fecha between p_desde and p_hasta
      and s.estado = 'liquidado'
      and vt.anulado_en is null
  )
  select case when sum(venta) > 0
              then sum(comision_real) / sum(venta) else 0 end,
         case when sum(apostado_ganador) > 0
              then sum(premios_real) / sum(apostado_ganador) else 0 end,
         coalesce(sum(venta), 0)
  from base;
$ponderados$;

comment on function public.fn_parametros_ponderados(date, date) is
  'Comisión y factor reales del rango, ponderados por venta. Por sorteo+vendedor, la captura por totales viva reemplaza a los tickets.';

revoke execute on function public.fn_parametros_ponderados(date, date) from public, anon;


-- ===========================================================================
-- LA BARRA DEL TABLERO (fn_control_serie): el total reemplaza los tickets.
--
-- Es la pareja de `fn_control_vendedores`: la barra del día a día. Sumaba
-- tickets + capturas; si no se cambiara, la barra sobrecontaría frente a la
-- tabla —que esta misma migración ya pasó a reemplazo— en cualquier día con un
-- sorteo+vendedor de las dos fuentes. Las líneas de un vendedor con captura viva
-- en ese sorteo se excluyen. `fn_control_capturado` no cambia: cuenta sólo lo
-- capturado por totales, que ya era la fuente única.
-- ===========================================================================
create or replace function public.fn_control_serie(
  p_desde      date,
  p_hasta      date,
  p_vendedores uuid[] default null,
  p_hora       public.hora_sorteo default null
)
returns table (r_fecha date, r_venta numeric, r_tickets integer)
language sql
stable
security definer
set search_path = public
as $control_serie$
  with dias as (
    select d::date as fecha
    from generate_series(p_desde, p_hasta, interval '1 day') d
  ),
  -- Tickets por día, SALVO los de vendedores con captura viva en ese sorteo.
  por_ticket as (
    select s.fecha,
           coalesce(sum(l.monto), 0)   as venta,
           count(distinct t.id)        as tickets
    from public.sorteo s
    join public.ticket   t on t.sorteo_id = s.id and t.anulado_en is null
    join public.linea    l on l.ticket_id = t.id
    join public.vendedor v on v.id = t.vendedor_id
                          and v.activo and v.eliminado_en is null
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or t.vendedor_id = any (p_vendedores))
      and not public.fn_tiene_total_vivo(s.id, t.vendedor_id)
    group by s.fecha
  ),
  por_total as (
    select s.fecha, coalesce(sum(vt.venta), 0) as venta
    from public.sorteo s
    join public.venta_total vt on vt.sorteo_id = s.id and vt.anulado_en is null
    join public.vendedor    v  on v.id = vt.vendedor_id
                              and v.activo and v.eliminado_en is null
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
      and (p_vendedores is null or vt.vendedor_id = any (p_vendedores))
    group by s.fecha
  )
  select d.fecha,
         coalesce(a.venta, 0) + coalesce(b.venta, 0),
         coalesce(a.tickets, 0)::integer
  from dias d
  left join por_ticket a on a.fecha = d.fecha
  left join por_total  b on b.fecha = d.fecha
  order by d.fecha;
$control_serie$;

comment on function public.fn_control_serie(date, date, uuid[], public.hora_sorteo) is
  'Venta día a día del tablero. Por cada vendedor, si tiene captura por totales viva cuenta sólo ésa; si no, sus tickets. Cuadra con fn_control_vendedores.';

revoke execute on function public.fn_control_serie(date, date, uuid[], public.hora_sorteo)
  from public, anon;


-- ===========================================================================
-- RECALCULAR PARÁMETROS (fn_recalcular_parametros): rehace la liquidación con
-- la regla de reemplazo.
--
-- Esta función reescribe comisión/factor congelados hacia atrás y rehace la
-- liquidación de cada sorteo tocado por su cuenta (no usa fn_recalcular_
-- liquidacion, porque incluye los pagados a propósito). Sumaba las dos fuentes;
-- ahora, por sorteo+vendedor, usa sólo la captura viva si la hay, o sólo las
-- líneas si no. Todo lo demás —las dos reescrituras de congelado, la auditoría,
-- el conteo de pagados— se conserva igual.
-- ===========================================================================
create or replace function public.fn_recalcular_parametros(
  p_vendedor_id uuid,
  p_desde       date,
  p_comision    numeric,
  p_factor_pago numeric,
  p_usuario_id  uuid default null
)
returns table (
  r_lineas      integer,
  r_capturas    integer,
  r_sorteos     integer,
  r_pagados     integer,
  r_comision_antes numeric,
  r_comision_ahora numeric
)
language plpgsql
security definer
set search_path = public
as $recalcular$
declare
  v_lineas   integer := 0;
  v_capturas integer := 0;
  v_sorteos  integer := 0;
  v_pagados  integer := 0;
  v_antes    numeric;
  v_sorteo   record;
  v_venta    numeric(14,2);
  v_comision numeric(14,2);
  v_premios  numeric(14,2);
begin
  if p_comision is null or p_comision < 0 or p_comision > 0.60 then
    raise exception 'La comisión debe estar entre 0 y 60%%.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_factor_pago is null or p_factor_pago < 1 or p_factor_pago > 200 then
    raise exception 'El factor de pago debe estar entre 1 y 200.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_desde is null then
    raise exception 'Hace falta la fecha desde la que se recalcula.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_desde > (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'La fecha desde la que se recalcula no puede ser futura.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.vendedor where id = p_vendedor_id;
  if not found then
    raise exception 'Ese vendedor no existe.'
      using errcode = 'no_data_found';
  end if;

  select comision into v_antes
  from public.parametro_vendedor
  where vendedor_id = p_vendedor_id and vigente_hasta is null
  limit 1;

  with tocadas as (
    update public.linea l
    set comision_congelada = p_comision,
        factor_congelado   = p_factor_pago,
        premio = case when l.gana then l.monto * p_factor_pago else l.premio end
    from public.ticket t
    join public.sorteo s on s.id = t.sorteo_id
    where l.ticket_id = t.id
      and t.vendedor_id = p_vendedor_id
      and t.anulado_en is null
      and s.fecha >= p_desde
    returning l.id
  )
  select count(*)::integer into v_lineas from tocadas;

  with tocadas as (
    update public.venta_total vt
    set comision_congelada = p_comision
    from public.sorteo s
    where s.id = vt.sorteo_id
      and vt.vendedor_id = p_vendedor_id
      and vt.anulado_en is null
      and s.fecha >= p_desde
    returning vt.id
  )
  select count(*)::integer into v_capturas from tocadas;

  for v_sorteo in
    select distinct lq.sorteo_id,
           exists (
             select 1 from public.corte_detalle d where d.liquidacion_id = lq.id
           ) as pagada
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where lq.vendedor_id = p_vendedor_id
      and s.fecha >= p_desde
  loop
    -- Regla de reemplazo: si hay captura viva, la fuente es sólo la captura; si
    -- no, sólo las líneas. Antes se sumaban las dos.
    if public.fn_tiene_total_vivo(v_sorteo.sorteo_id, p_vendedor_id) then
      select coalesce(sum(vt.venta), 0),
             coalesce(sum(vt.venta * vt.comision_congelada), 0),
             coalesce(sum(vt.premios), 0)
        into v_venta, v_comision, v_premios
      from public.venta_total vt
      where vt.sorteo_id = v_sorteo.sorteo_id
        and vt.vendedor_id = p_vendedor_id
        and vt.anulado_en is null;
    else
      select coalesce(sum(l.monto), 0),
             coalesce(sum(l.monto * l.comision_congelada), 0),
             coalesce(sum(l.premio), 0)
        into v_venta, v_comision, v_premios
      from public.linea l
      join public.ticket t on t.id = l.ticket_id
      where t.sorteo_id = v_sorteo.sorteo_id
        and t.vendedor_id = p_vendedor_id
        and t.anulado_en is null;
    end if;

    update public.liquidacion
    set venta    = v_venta,
        comision = v_comision,
        premios  = v_premios,
        utilidad = v_venta - v_comision - v_premios
    where sorteo_id = v_sorteo.sorteo_id and vendedor_id = p_vendedor_id;

    v_sorteos := v_sorteos + 1;
    if v_sorteo.pagada then
      v_pagados := v_pagados + 1;
    end if;
  end loop;

  perform public.fn_auditar(
    'parametro_vendedor', p_vendedor_id, 'recalcular', 'comision',
    coalesce(v_antes::text, '—'),
    p_comision::text || ' desde ' || p_desde::text
  );

  if v_pagados > 0 then
    perform public.fn_auditar(
      'parametro_vendedor', p_vendedor_id, 'recalcular', 'sorteos_pagados',
      null, v_pagados::text
    );
  end if;

  return query select v_lineas, v_capturas, v_sorteos, v_pagados,
                      v_antes, p_comision;
end;
$recalcular$;

comment on function public.fn_recalcular_parametros(uuid, date, numeric, numeric, uuid) is
  'Reescribe comisión/factor congelados desde una fecha y rehace las liquidaciones. Por sorteo+vendedor, la captura por totales viva reemplaza a los tickets. Incluye los pagados: devuelve cuántos.';

revoke execute on function public.fn_recalcular_parametros(uuid, date, numeric, numeric, uuid)
  from public, anon;
