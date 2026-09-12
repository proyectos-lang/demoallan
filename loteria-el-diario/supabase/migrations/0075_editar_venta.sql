-- ===========================================================================
-- Corregir las líneas de una venta ya registrada.
--
-- QUÉ HUECO LLENA
-- ---------------
-- Hasta ahora una venta mal registrada sólo se podía ANULAR: el ticket entero
-- desaparecía y había que volver a venderlo. Para un monto mal tecleado —el
-- cliente dijo 250 y quedó 25— eso obliga a rehacer las doce líneas del
-- ticket para arreglar una.
--
-- LO QUE NO CAMBIA NUNCA
-- ----------------------
-- El FOLIO, el vendedor y el sorteo. Es la misma venta corregida, no otra: el
-- cliente tiene una tirilla con ese folio en la mano, y cambiarlo la
-- convertiría en un papel que no corresponde a nada.
--
-- Mover la venta a otro sorteo o a otro vendedor tampoco: eso no es corregir
-- un dedazo, es trasladar dinero de un sitio a otro, y para eso está anular y
-- volver a registrar donde toque, que deja las dos huellas.
--
-- EL CUPO SE REHACE ENTERO
-- ------------------------
-- Se devuelve lo de las líneas viejas y se consume lo de las nuevas, en vez de
-- calcular la diferencia. Es más trabajo para la base y muchísimo más difícil
-- de equivocar: una diferencia mal calculada deja el cupo desajustado en
-- silencio, y ese error no se ve hasta que alguien no puede vender un número
-- que sí tenía sitio.
--
-- Y SE COMPRUEBA EL TOPE, como en una venta normal. Editar no puede ser la
-- puerta por la que se salta el límite que el registro sí respeta: quien
-- quisiera pasarse del cupo sólo tendría que vender poco y luego «corregir».
--
-- SOBRE UN SORTEO LIQUIDADO SE RECONCILIA
-- ---------------------------------------
-- Igual que al anular (0067). Si el sorteo ya tiene número ganador, las líneas
-- nuevas pueden ganar o dejar de ganar, y la liquidación del vendedor cambia.
-- `fn_recalcular_liquidacion` lo rehace — y rechaza si ese sorteo ya se pagó
-- en un corte, que es dinero que ya cambió de manos.
--
-- QUIÉN PUEDE: SÓLO ADMINISTRACIÓN, y lo decide la Server Action. La base no
-- sabe quién llama —desde la 0024 la aplicación habla como `service_role`— así
-- que aquí no hay una guarda que sirva; la hay en la acción, que es donde está
-- la sesión firmada.
-- ===========================================================================

create or replace function public.fn_editar_venta(
  p_ticket_id  uuid,
  /* `[{ "numero": 7, "monto": 100 }, ...]` — las líneas que quedan. */
  p_lineas     jsonb,
  p_motivo     text default null,
  p_usuario_id uuid default null
) returns table (r_total numeric, r_lineas integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket   public.ticket%rowtype;
  v_estado   public.estado_sorteo;
  v_param    public.parametro_vendedor%rowtype;
  v_antes    text;
  v_despues  text;
  v_total    numeric(14,2);
  v_cuantas  integer;
  v_linea    record;
  v_disp     numeric(14,2);
  v_propio   numeric(14,2);
begin
  select * into v_ticket
  from public.ticket where id = p_ticket_id
  for update;

  if not found then
    raise exception 'El ticket % no existe.', p_ticket_id
      using errcode = 'no_data_found';
  end if;

  if v_ticket.anulado_en is not null then
    raise exception 'El ticket % está anulado; no se puede corregir.', v_ticket.folio
      using errcode = 'invalid_parameter_value';
  end if;

  -- Al menos una línea: un ticket sin líneas no es una corrección, es una
  -- anulación, y para eso está `fn_anular_ticket` — que devuelve el cupo y
  -- deja constancia de quién y por qué.
  select count(*) into v_cuantas
  from jsonb_array_elements(coalesce(p_lineas, '[]'::jsonb));

  if v_cuantas = 0 then
    raise exception 'Una venta corregida tiene que quedar con al menos un número. Para dejarla sin nada, anúlela.'
      using errcode = 'invalid_parameter_value';
  end if;

  select estado into v_estado
  from public.sorteo where id = v_ticket.sorteo_id
  for share;

  select * into v_param
  from public.parametro_vendedor
  where vendedor_id = v_ticket.vendedor_id and vigente_hasta is null
  limit 1;

  if not found then
    raise exception 'Ese vendedor no tiene parámetros vigentes.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- La jugada de ANTES, para la auditoría. Se arma ahora, mientras existe.
  select string_agg(lpad(numero::text, 2, '0') || ':' || monto::text, '  ' order by numero, monto)
  into v_antes
  from public.linea where ticket_id = p_ticket_id;

  /*
   * Se devuelve el cupo VIEJO antes de tocar nada.
   *
   * En orden ascendente de número, como el resto del sistema: es lo que evita
   * el interbloqueo entre dos transacciones que tocan los mismos números en
   * distinto orden.
   */
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

  delete from public.linea where ticket_id = p_ticket_id;

  -- Y se consume el nuevo, comprobando el tope de cada número igual que haría
  -- una venta corriente.
  for v_linea in
    select (e->>'numero')::smallint as numero,
           sum((e->>'monto')::numeric) as monto
    from jsonb_array_elements(p_lineas) e
    group by (e->>'numero')::smallint
    order by 1
  loop
    if v_linea.numero < 0 or v_linea.numero > 99 then
      raise exception 'Número fuera de rango: %.', v_linea.numero
        using errcode = 'invalid_parameter_value';
    end if;
    if v_linea.monto <= 0 then
      raise exception 'El monto del número % tiene que ser mayor que cero.', v_linea.numero
        using errcode = 'invalid_parameter_value';
    end if;

    select (c.limite_casa - c.vendido) into v_disp
    from public.cupo_numero c
    where c.sorteo_id = v_ticket.sorteo_id and c.numero = v_linea.numero
    for update;

    if v_disp is null then
      raise exception 'El sorteo no tiene cupo sembrado para el número %.', v_linea.numero
        using errcode = 'no_data_found';
    end if;

    if v_linea.monto > v_disp then
      raise exception 'El número % sólo admite % más; se pidieron %.',
        lpad(v_linea.numero::text, 2, '0'), v_disp, v_linea.monto
        using errcode = 'check_violation';
    end if;

    -- El tope del vendedor, contando lo que ya tiene en OTROS tickets vivos:
    -- si no, corregir sería la forma de superarlo por partes.
    select coalesce(sum(l.monto), 0) into v_propio
    from public.linea l
    join public.ticket t on t.id = l.ticket_id
    where t.sorteo_id = v_ticket.sorteo_id
      and t.vendedor_id = v_ticket.vendedor_id
      and t.anulado_en is null
      and t.id <> p_ticket_id
      and l.numero = v_linea.numero;

    if v_propio + v_linea.monto > v_param.tope_por_numero then
      raise exception 'El número % pasa el tope del vendedor (% por número).',
        lpad(v_linea.numero::text, 2, '0'), v_param.tope_por_numero
        using errcode = 'check_violation';
    end if;

    update public.cupo_numero
    set vendido = vendido + v_linea.monto
    where sorteo_id = v_ticket.sorteo_id and numero = v_linea.numero;

    if v_ticket.dispositivo_id is not null then
      update public.cuota_dispositivo
      set consumido = consumido + v_linea.monto
      where sorteo_id = v_ticket.sorteo_id
        and dispositivo_id = v_ticket.dispositivo_id
        and numero = v_linea.numero;
    end if;
  end loop;

  /*
   * Las líneas nuevas, con la comisión y el factor VIGENTES.
   *
   * Es una diferencia real con el ticket original, que los congeló el día de
   * la venta. Se asume a propósito: corregir es un acto de hoy, y arrastrar
   * los valores viejos obligaría a guardarlos por línea para saber cuáles eran
   * —dato que no existe una vez borradas—. Si los parámetros cambiaron entre
   * medias, la corrección usa los de ahora y la auditoría deja la jugada
   * anterior para poder reconstruirlo.
   */
  insert into public.linea (
    ticket_id, numero, monto, comision_congelada, factor_congelado
  )
  select p_ticket_id,
         (e->>'numero')::smallint,
         (e->>'monto')::numeric,
         v_param.comision,
         v_param.factor_pago
  from jsonb_array_elements(p_lineas) e;

  select coalesce(sum(monto), 0), count(*)::integer
  into v_total, v_cuantas
  from public.linea where ticket_id = p_ticket_id;

  update public.ticket set total = v_total where id = p_ticket_id;

  select string_agg(lpad(numero::text, 2, '0') || ':' || monto::text, '  ' order by numero, monto)
  into v_despues
  from public.linea where ticket_id = p_ticket_id;

  -- La auditoría guarda la jugada ENTERA de antes y de después. Es lo único
  -- que permite reconstruir qué decía la tirilla que tiene el cliente.
  perform public.fn_auditar('ticket', p_ticket_id, 'editar', 'jugada',
                            v_antes, v_despues);

  if nullif(btrim(coalesce(p_motivo, '')), '') is not null then
    perform public.fn_auditar('ticket', p_ticket_id, 'editar', 'motivo',
                              null, btrim(p_motivo));
  end if;

  /*
   * Si el sorteo ya estaba liquidado, se rehace la cuenta del vendedor.
   *
   * Va al final, con las líneas nuevas ya escritas: `fn_recalcular_liquidacion`
   * marca las ganadoras y rehace la fila de `liquidacion` a partir de lo que
   * hay. Y rechaza si ese sorteo entró en un corte pagado, deshaciendo la
   * edición entera — una venta corregida sobre dinero ya entregado dejaría el
   * corte sin cuadrar con nada.
   */
  if v_estado = 'liquidado' then
    perform public.fn_recalcular_liquidacion(v_ticket.sorteo_id, v_ticket.vendedor_id);
  end if;

  return query select v_total, v_cuantas;
end;
$$;

comment on function public.fn_editar_venta(uuid, jsonb, text, uuid) is
  'Corrige las líneas de una venta. No toca folio, vendedor ni sorteo. Rehace el cupo entero, comprueba el tope y reconcilia la liquidación si el sorteo estaba liquidado.';

revoke execute on function public.fn_editar_venta(uuid, jsonb, text, uuid)
  from public, anon;
