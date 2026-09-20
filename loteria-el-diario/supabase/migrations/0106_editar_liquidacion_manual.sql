-- ===========================================================================
-- Edición manual de venta/premios de un sorteo, desde la hoja del vendedor.
--
-- LO QUE PIDIÓ EL GERENTE
-- -----------------------
-- Poder corregir a mano, con rapidez, la venta y los premios de un sorteo desde
-- la tabla de la hoja del vendedor —sin pasar por otra pantalla— cuando hay una
-- equivocación, entendiendo que eso cambia la liquidación, el saldo, la hoja y
-- la impresión de ese día y ese sorteo.
--
-- POR QUÉ NO SE TOCA `liquidacion` DIRECTAMENTE
-- --------------------------------------------
-- La tabla de la hoja lee de `liquidacion`, pero `liquidacion` NO es fuente de
-- verdad: `fn_recalcular_liquidacion` la reconstruye desde `linea` (tickets con
-- números) y `venta_total` (capturas por totales) cada vez que algo cambia. Si
-- se sobrescribiera `liquidacion.venta` a mano, el siguiente recálculo —una
-- anulación, otra corrección— lo borraría. La edición tiene que entrar por la
-- FUENTE, y que el recálculo la propague solo a las siete pantallas de saldo.
--
-- QUÉ SE PUEDE EDITAR, Y QUÉ NO
-- -----------------------------
-- La fuente editable es la captura por totales (`venta_total`), que es el 93 %
-- de la operación. Se rechaza editar un sorteo que tiene TICKETS CON NÚMEROS
-- vivos: ahí la venta es la suma de tickets reales, atada al cupo, al premiado y
-- al historial del cliente, y una cifra tecleada encima los contradiría. Esos se
-- corrigen editando o anulando el ticket, que ya mantiene todo coherente.
--
-- Se editan VENTA y PREMIOS; la comisión (venta × comisión del vendedor) y el
-- saldo (venta − comisión − premios) se recalculan solos, como en la captura por
-- totales de siempre, para que las cuatro cifras nunca se contradigan.
--
-- SORTEO YA LIQUIDADO O YA PAGADO
-- ------------------------------
-- La hoja sólo muestra sorteos con número ganador, así que están 'liquidado' y
-- el recálculo corre siempre. Si además el sorteo ya se pagó en un corte, la
-- reconciliación de la 0104 hace su trabajo: se desliga y sólo la diferencia
-- queda pendiente. Editar una celda de un sorteo ya pagado también cuadra.
--
-- QUIÉN PUEDE: sólo administración, decidido en la Server Action —la base habla
-- como `service_role` desde la 0024, así que la guarda de rol va arriba—.
-- ===========================================================================

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
  v_tiene_lineas boolean;
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

  -- BLINDAJE: un sorteo con tickets de números vivos no se edita a mano. La
  -- venta ahí es la suma de esos tickets; teclear una cifra encima la separaría
  -- del cupo, del premiado y del historial. Se corrige el ticket, no la celda.
  select exists (
    select 1
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = v_liq.sorteo_id
      and t.vendedor_id = v_liq.vendedor_id
      and t.anulado_en is null
  ) into v_tiene_lineas;

  if v_tiene_lineas then
    raise exception 'Este sorteo tiene tickets con números; corríjalos desde la venta, no desde la hoja.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- La captura por totales viva de ese sorteo y vendedor, si la hay.
  select id into v_vt_id
  from public.venta_total
  where sorteo_id = v_liq.sorteo_id
    and vendedor_id = v_liq.vendedor_id
    and anulado_en is null;

  if found then
    -- Camino normal: reescribir la captura. `fn_editar_venta_total` reescribe
    -- venta/premios, audita el antes/después y dispara el recálculo cuando el
    -- sorteo está liquidado —que es siempre, porque la hoja sólo muestra
    -- sorteos con número ganador—.
    perform public.fn_editar_venta_total(v_vt_id, p_venta, p_premios, null, p_usuario_id);
  else
    -- No hay captura viva ni tickets: se crea la captura con la comisión
    -- vigente. Es el caso raro de meter una cifra donde no había fuente, y deja
    -- la hoja con un dato editable de aquí en adelante.
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

  -- Se devuelve la fila ya rehecha, para que la pantalla pinte lo que quedó sin
  -- volver a consultar.
  select lq.venta, lq.comision, lq.premios, lq.venta - lq.comision - lq.premios
    into r_venta, r_comision, r_premios, r_saldo
  from public.liquidacion lq
  where lq.sorteo_id = v_liq.sorteo_id and lq.vendedor_id = v_liq.vendedor_id;

  -- Si la venta quedó en cero y no había premios, `fn_recalcular_liquidacion`
  -- pudo borrar la fila: se devuelven ceros, que es lo que corresponde.
  r_venta    := coalesce(r_venta, 0);
  r_comision := coalesce(r_comision, 0);
  r_premios  := coalesce(r_premios, 0);
  r_saldo    := coalesce(r_saldo, 0);
  return next;
end;
$manual$;

comment on function public.fn_editar_liquidacion_manual(uuid, numeric, numeric, uuid) is
  'Corrige a mano venta/premios de un sorteo por totales desde la hoja del vendedor. Rechaza los sorteos con tickets de números. Edita la captura (venta_total) y deja que el recálculo propague el cambio a toda la cuenta.';

revoke execute on function public.fn_editar_liquidacion_manual(uuid, numeric, numeric, uuid)
  from public, anon;
