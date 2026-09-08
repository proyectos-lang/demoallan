-- ===========================================================================
-- Anular una venta aunque el sorteo ya esté liquidado.
--
-- QUÉ FALTABA
-- -----------
-- Desde la 0054 se puede anular sobre un sorteo CERRADO, que cubría el caso
-- corriente. Pero sobre un sorteo LIQUIDADO se rechazaba siempre, y ése es
-- justo el estado en el que aparecen los problemas: un duplicado se descubre
-- auditando, y se audita cuando el día ya terminó y los tres sorteos están
-- liquidados. Quedaba una venta que todos sabían que no existía y que nadie
-- podía quitar.
--
-- POR QUÉ SE RECHAZABA, Y POR QUÉ AHORA SÍ
-- ----------------------------------------
-- El motivo del rechazo era bueno: al liquidar se escribe una fila en
-- `liquidacion` con la venta, la comisión, los premios y el neto de cada
-- vendedor. Quitar un ticket por detrás dejaba esa fila con el total viejo —el
-- detalle diría 3,570 y el informe financiero seguiría diciendo 3,770, sin que
-- nada avisara del desacuerdo—.
--
-- Lo que faltaba no era permiso: era RECONCILIAR. `fn_recalcular_liquidacion`
-- ya existe desde la 0033 —se escribió para la venta forzada sobre un sorteo
-- liquidado— y hace exactamente lo que hace falta aquí, porque suma sólo
-- tickets con `anulado_en is null`. Anular y llamarla deja la liquidación
-- cuadrada con lo que el vendedor vendió de verdad.
--
-- LO QUE SIGUE PROHIBIDO, Y ESO NO CAMBIA
-- ---------------------------------------
-- Si ese sorteo YA SE LE PAGÓ al vendedor en un corte, no se anula. No es una
-- cautela de más: el corte es dinero que ya cambió de manos y que el vendedor
-- firmó. Recalcular la liquidación por debajo dejaría el monto entregado sin
-- corresponder con nada, y no hay forma honesta de arreglarlo hacia atrás — la
-- venta ya se pagó.
--
-- Ese rechazo lo pone `fn_recalcular_liquidacion`, que consulta
-- `corte_detalle`. Aquí no se duplica la comprobación: se deja que la lance
-- quien la sabe hacer, para que no haya dos reglas que puedan separarse.
--
-- EL CUPO SE DEVUELVE IGUAL
-- -------------------------
-- Aunque el sorteo esté liquidado. Puede parecer inútil —ese sorteo ya no
-- admite ventas— pero el cupo es el registro de cuánto se jugó a cada número,
-- y dejarlo inflado con una venta que no existe distorsiona cualquier análisis
-- de exposición que se haga después sobre ese día.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Primero: quitar la versión VIEJA de dos parámetros.
--
-- La 0054 creó `fn_anular_ticket(uuid, text, uuid, boolean)` pero nunca borró
-- la anterior `(uuid, text)`, así que las dos quedaron vivas. Postgres las
-- admite —son firmas distintas— pero PostgREST no: llamarla sin `p_usuario_id`
-- devuelve
--
--     PGRST203  Could not choose the best candidate function between:
--     public.fn_anular_ticket(p_ticket_id, p_motivo),
--     public.fn_anular_ticket(p_ticket_id, p_motivo, p_usuario_id, p_forzar)
--
-- Es decir: cualquier llamada con sólo los dos primeros argumentos falla, y
-- falla de una forma que no menciona la duplicación salvo si uno lee el
-- mensaje entero. Se quita la vieja para que quede UNA.
--
-- Además la vieja escribía `anulado_por = auth.uid()`, que es NULL bajo
-- `service_role`: aunque se pudiera resolver, reventaría contra la
-- restricción `ticket_anulacion_completa`. No hay nada que conservar.
-- --------------------------------------------------------------------------

drop function if exists public.fn_anular_ticket(uuid, text);


create or replace function public.fn_anular_ticket(
  p_ticket_id  uuid,
  p_motivo     text,
  p_usuario_id uuid default null,
  p_forzar     boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.ticket%rowtype;
  v_estado public.estado_sorteo;
  v_linea  record;
begin
  select * into v_ticket
  from public.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  -- Un vendedor sólo puede anular lo suyo; administración, cualquiera.
  if not public.fn_es_servicio()
     and public.fn_rol_actual() is distinct from 'administrador'
     and v_ticket.vendedor_id is distinct from public.fn_vendedor_actual() then
    raise exception 'No tiene permiso para anular este ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % ya estaba anulado.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_ticket.sorteo_id
  for share;

  /*
   * Fuera de un sorteo abierto hace falta `p_forzar`.
   *
   * La bandera la pone la Server Action después de comprobar que quien llama
   * es administrador, no el navegador: desde la 0024 la aplicación habla como
   * `service_role`, así que `fn_exige` retorna sin comprobar nada y la base no
   * sabe quién está al otro lado.
   *
   * `liquidado` ya no es un caso aparte que se rechace siempre: se trata como
   * los demás, y lo que lo vuelve seguro es la reconciliación de más abajo.
   */
  if v_estado <> 'abierto' and not p_forzar then
    raise exception 'Sólo se anulan tickets de un sorteo abierto; éste está %.', v_estado
      using errcode = 'invalid_parameter_value';
  end if;

  -- Devolver el cupo, número por número en orden ascendente.
  for v_linea in
    select numero, sum(monto) as monto
    from public.linea where ticket_id = p_ticket_id
    group by numero order by numero
  loop
    update public.cupo_numero
    set vendido = greatest(vendido - v_linea.monto, 0)
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update public.cuota_dispositivo
      set consumido = greatest(consumido - v_linea.monto, 0)
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  update public.ticket
  set anulado_en = now(),
      -- El parámetro primero: `auth.uid()` es NULL bajo service_role, y con él
      -- la restricción `ticket_anulacion_completa` rechaza el UPDATE entero.
      anulado_por = coalesce(p_usuario_id, auth.uid()),
      motivo_anulacion = p_motivo
  where id = p_ticket_id;

  perform public.fn_auditar('ticket', p_ticket_id, 'anular', 'motivo', null, p_motivo);

  /*
   * Y si el sorteo estaba liquidado, se rehace la cuenta del vendedor.
   *
   * VA DESPUÉS DEL UPDATE a propósito: `fn_recalcular_liquidacion` suma sólo
   * los tickets con `anulado_en is null`, así que si corriera antes volvería a
   * contar el que se acaba de quitar y no cambiaría nada.
   *
   * Es la misma transacción —una función plpgsql lo es—, de modo que o queda
   * anulado Y recalculado, o no queda nada. Un ticket anulado con la
   * liquidación sin rehacer es precisamente el descuadre que esto evita.
   *
   * Si ese sorteo ya entró en un corte pagado, la función lanza y la
   * anulación se deshace entera. Ahí el rechazo es lo correcto.
   */
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_ticket.sorteo_id, v_ticket.vendedor_id);
  end if;
end;
$$;

comment on function public.fn_anular_ticket(uuid, text, uuid, boolean) is
  'Anula un ticket, devuelve su cupo y, si el sorteo estaba liquidado, rehace la liquidación del vendedor. Rechaza si ese sorteo ya se pagó en un corte.';

revoke execute on function public.fn_anular_ticket(uuid, text, uuid, boolean)
  from public, anon;
