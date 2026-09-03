-- ===========================================================================
-- El duplicado deja de ser posible, no sólo improbable.
--
-- QUÉ PROBLEMA CIERRA
-- -------------------
-- El 3 de septiembre aparecieron 13 tickets duplicados: copias exactas
-- emitidas con menos de tres segundos de diferencia. La causa era el botón de
-- confirmar, que quedaba habilitado mientras la venta esperaba al GPS —hasta
-- cuatro segundos— y el vendedor volvía a pulsar.
--
-- Eso ya se arregló en el cliente: el botón se bloquea al primer toque y la
-- venta ya no espera al GPS. Pero toda esa protección vive en el navegador, y
-- deja cuatro huecos que no cubre:
--
--   · REINTENTO DE RED. El vendedor pulsa, la petición sale, el servidor la
--     registra, y la respuesta se pierde en una conexión mala. La pantalla
--     parece no haber hecho nada y él vuelve a pulsar. Es el más probable en
--     la calle.
--   · DOS DISPOSITIVOS con la misma cuenta —el caso de la tienda—, donde cada
--     pantalla ignora lo que hace la otra.
--   · RECARGAR la página a mitad del envío.
--   · UN FALLO DE JAVASCRIPT que impida aplicar la guarda.
--
-- CÓMO
-- ----
-- El navegador genera una marca al empezar a componer la venta y la manda con
-- ella. La base la guarda con un índice único: si llega dos veces la misma, la
-- segunda no crea nada y devuelve los folios que ya existían.
--
-- El vendedor ve su recibo igual y no percibe error. Es el mismo mecanismo que
-- usan las pasarelas de pago, y por la misma razón: la red no es de fiar y el
-- usuario no tiene por qué saberlo.
--
-- POR QUÉ ESTO NO ESTORBA A DOS CLIENTES QUE APUESTAN IGUAL
-- ---------------------------------------------------------
-- La marca identifica el ENVÍO, no la jugada. Dos personas que apuestan los
-- mismos números en el mismo minuto son dos envíos distintos con dos marcas
-- distintas, y las dos ventas entran. Sólo se rechaza el MISMO envío repetido
-- — que es exactamente lo que hay que rechazar.
--
-- Es la diferencia clave frente a detectar duplicados por «tickets idénticos
-- en pocos segundos»: eso confunde una venta legítima repetida con un error, y
-- por eso sirve para auditar pero no para prevenir.
--
-- LA MARCA ES OPCIONAL, a propósito. Una venta sin marca se registra como
-- siempre: así una versión vieja de la aplicación, o el registro por
-- digitalización, siguen funcionando mientras el despliegue se propaga.
-- ===========================================================================

alter table public.ticket
  add column if not exists envio_id uuid;

comment on column public.ticket.envio_id is
  'Marca del envío que creó este ticket. Misma marca = misma venta reintentada, no una venta nueva.';

-- Índice PARCIAL: sólo sobre los que traen marca. Sin el `where`, todos los
-- tickets viejos con `envio_id` nulo chocarían entre sí — en SQL dos NULL no
-- son iguales, pero el índice tampoco los indexaría útilmente. Es la misma
-- lección de la 0050, donde una restricción sobre columnas nulas no
-- restringía nada.
create unique index if not exists ticket_envio_unico
  on public.ticket (envio_id)
  where envio_id is not null;

comment on index public.ticket_envio_unico is
  'Hace imposible registrar dos veces el mismo envío, venga de donde venga: doble toque, reintento de red, dos dispositivos o recarga.';


-- --------------------------------------------------------------------------
-- La venta, con la marca.
--
-- Cambia la firma, así que hay que soltar la anterior: dejar las dos vivas
-- haría ambigua cualquier llamada.
-- --------------------------------------------------------------------------

drop function if exists public.fn_registrar_tanda(
  uuid, uuid, jsonb, double precision, double precision, boolean, uuid
);

create or replace function public.fn_registrar_tanda(
  p_sorteo_id   uuid,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_forzar      boolean default false,
  p_usuario_id  uuid default null,
  p_envio_id    uuid default null
) returns table (r_folio text, r_total numeric, r_creado_en timestamptz, r_repetido boolean)
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

  -- Tope de cordura. Una tanda es lo que compra UNA persona; cincuenta tickets
  -- ya es un envío que conviene mirar antes de dejarlo pasar entero.
  if v_cuantos > 50 then
    raise exception 'Una tanda no puede llevar más de 50 tickets; ésta trae %.', v_cuantos
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * ¿ESTE ENVÍO YA ENTRÓ?
   *
   * Se comprueba ANTES de tocar nada. Si la venta ya se registró y lo que
   * falló fue la respuesta, aquí se devuelven los mismos folios y el vendedor
   * ve su recibo sin enterarse de que hubo un reintento.
   *
   * La comprobación no basta por sí sola: entre este SELECT y los INSERT cabe
   * otra petición idéntica. Lo que de verdad cierra la puerta es el índice
   * único, que hace fallar la segunda; esto sólo evita el error cuando el
   * reintento llega después de terminada la primera.
   */
  if p_envio_id is not null then
    select count(*) into v_ya
    from public.ticket t
    where t.envio_id = p_envio_id;

    if v_ya > 0 then
      return query
        select t.folio, t.total, t.creado_en, true
        from public.ticket t
        where t.envio_id = p_envio_id
        order by t.folio;
      return;
    end if;
  end if;

  -- Prebloqueo de TODOS los números de la tanda, en orden ascendente. Sin
  -- esto, dos tandas con los mismos números en distinto orden se interbloquean
  -- entre sí: cada fn_registrar_ticket ordena lo suyo, pero nadie ordena el
  -- conjunto.
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

    /*
     * La marca va en el PRIMER ticket de la tanda, y sólo en él.
     *
     * El índice único es por ticket: estampar la misma marca en los cinco
     * tickets de una tanda haría que chocaran entre sí y la venta entera
     * fallaría. Con el primero basta para reconocer el envío.
     *
     * `v_primero` es una bandera local y no una consulta a la tabla: un
     * `not exists` aquí sería una condición de carrera, porque dos peticiones
     * simultáneas pueden verlo vacío a la vez. Quien decide de verdad es el
     * índice único, que hace fallar la transacción entera de la segunda —y al
     * ser una transacción, no queda media venta registrada.
     */
    if p_envio_id is not null and v_primero then
      update public.ticket set envio_id = p_envio_id where id = v_res.ticket_id;
      v_primero := false;
    end if;

    r_folio := v_res.ticket_folio;
    r_total := v_res.ticket_total;
    r_repetido := false;

    -- La hora que quedó escrita, no `now()`: son iguales dentro de la
    -- transacción, pero lo que debe viajar al papel es el dato guardado.
    select t.creado_en into r_creado_en
    from public.ticket t where t.id = v_res.ticket_id;

    return next;
  end loop;

  return;
end;
$$;

comment on function public.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid) is
  'Registra varios tickets en una transacción. Con p_envio_id, un envío repetido devuelve los folios ya creados en vez de duplicar la venta.';

revoke execute on function public.fn_registrar_tanda(uuid, uuid, jsonb, double precision, double precision, boolean, uuid, uuid)
  from public, anon;
