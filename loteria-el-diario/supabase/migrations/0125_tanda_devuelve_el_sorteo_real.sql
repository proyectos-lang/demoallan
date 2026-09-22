-- ===========================================================================
-- La tanda devuelve el SORTEO REAL del ticket, para que la tirilla no mienta.
--
-- EL BUG DE LA TIRILLA (V-105)
-- ----------------------------
-- La línea «SORTEO hh:mm» de la tirilla se pintaba con el sorteo que la
-- PANTALLA tenía cargado al imprimir, no con el del ticket. Al reimprimir con
-- la pantalla en otro sorteo, el texto salía distinto —11 AM, 9 PM, 3 PM— para
-- la misma venta, mientras el código de barras (que sí venía de la fila) era el
-- mismo. El registro devuelve ahora, junto al folio, la FECHA y la HORA del
-- sorteo real del ticket, y la app imprime eso.
--
-- Respeta la venta a futuro: si el vendedor eligió a mano el sorteo de las 9 PM
-- para registrar, el ticket ES de las 9 PM y la tirilla dirá 9 PM. Lo que se
-- corta es que el papel muestre un sorteo DISTINTO al del ticket.
--
-- Cambia el tipo de retorno —dos columnas nuevas— así que se suelta la anterior
-- primero: `create or replace` no reemplaza una función cuando cambia su
-- retorno.
-- ===========================================================================

drop function if exists public.fn_registrar_tanda(
  uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid
);

create function public.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null,
  p_envio_id    uuid default null
) returns table (
  r_folio        text,
  r_total        numeric,
  r_creado_en    timestamptz,
  r_repetido     boolean,
  r_codigo       text,
  r_sorteo_fecha date,
  r_sorteo_hora  public.hora_sorteo
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cuantos integer;
  v_lineas  jsonb;
  v_res     record;
  v_ya      integer;
  v_primero boolean := true;
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

  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  -- ¿Este envío ya entró? Se devuelve lo que se creó, sin duplicar. Ver 0056.
  if p_envio_id is not null then
    select count(*) into v_ya
    from public.ticket t
    where t.envio_id = p_envio_id;

    if v_ya > 0 then
      return query
        select t.folio, t.total, t.creado_en, true, t.codigo_barras, s.fecha, s.hora
        from public.ticket t
        join public.sorteo s on s.id = t.sorteo_id
        where t.envio_id = p_envio_id
        order by t.folio;
      return;
    end if;
  end if;

  -- Prebloqueo de los números de la tanda, en orden ascendente: sin esto, dos
  -- tandas con los mismos números en distinto orden se interbloquean.
  perform 1
  from public.cupo_numero c
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
    from public.fn_registrar_ticket(
      p_sorteo_id, p_vendedor_id, v_lineas,
      p_lat, p_lng, null,
      'movil'::public.canal_ticket, null,
      p_forzar, p_usuario_id
    );

    -- La marca del envío va en el PRIMER ticket y sólo en él: el índice único
    -- es por ticket, y estamparla en todos los haría chocar entre sí.
    if p_envio_id is not null and v_primero then
      update public.ticket set envio_id = p_envio_id where id = v_res.ticket_id;
      v_primero := false;
    end if;

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;
    r_repetido := false;

    -- La hora, el código Y EL SORTEO, LEÍDOS DE LA FILA: es lo que quedó
    -- guardado, que es lo que debe viajar al papel. La tirilla imprime este
    -- sorteo, no el que la pantalla tenga cargado.
    select t.creado_en, t.codigo_barras, s.fecha, s.hora
      into r_creado_en, r_codigo, r_sorteo_fecha, r_sorteo_hora
    from public.ticket t
    join public.sorteo s on s.id = t.sorteo_id
    where t.id = v_res.ticket_id;

    return next;
  end loop;

  return;
end;
$$;

revoke execute on function public.fn_registrar_tanda(
  uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid
) from public, anon;
