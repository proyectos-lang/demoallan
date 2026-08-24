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
