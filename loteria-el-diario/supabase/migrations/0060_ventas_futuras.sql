-- ===========================================================================
-- Ventas futuras: registrar hoy una apuesta para un sorteo de otro día.
--
-- EL PROBLEMA QUE HAY QUE RESOLVER
-- --------------------------------
-- La base ya admite vender a un sorteo de mañana —comprobado— porque el ciclo
-- automático siembra y abre hoy Y mañana. Lo que no admite es vender al 15 de
-- octubre: ese sorteo todavía no existe, y aunque se creara, `fn_registrar_
-- ticket` exige `estado = 'abierto'` y un sorteo sin abrir no tiene cupo
-- sembrado.
--
-- POR QUÉ NO SE ABREN TODOS DE GOLPE
-- ----------------------------------
-- Abrir un año por delante son 1.095 sorteos y 109.500 filas de cupo. El
-- volumen se aguanta; lo que se rompe es el SIGNIFICADO de `abierto`, que hoy
-- quiere decir «este sorteo está vendiendo ahora». De ahí cuelgan tres
-- pantallas: el portal del vendedor ofrece el abierto que cierra antes, la
-- captura de resultados propone el abierto más próximo, y el ciclo cierra los
-- vencidos. Con mil abiertos a la vez, ninguna sabe cuál es el de ahora.
--
-- Así que el sorteo futuro SE CREA CUANDO ALGUIEN LO PIDE. Sólo existen los
-- días que alguien usa, y el resto del sistema sigue viendo el puñado de
-- siempre.
--
-- LO QUE ESTA FUNCIÓN NO CAMBIA
-- -----------------------------
-- Nada de la venta en sí. Una vez que el sorteo existe y está abierto, el
-- ticket entra por `fn_registrar_tanda` como cualquier otro: mismo cupo, mismo
-- congelado de comisión y factor, mismo folio, misma marca de envío. Una venta
-- futura no es un tipo distinto de venta — es una venta a un sorteo que aún no
-- ha llegado.
--
-- Por eso tampoco hace falta marcarla: la fecha del sorteo ya dice si es
-- futura, y añadir una bandera sería guardar dos veces el mismo hecho.
--
-- EL TOPE POR NÚMERO SIGUE SIENDO POR SORTEO, por decisión explícita. Un
-- cliente puede cargar el máximo al mismo número en muchos días seguidos y
-- cada sorteo respeta su límite, pero la casa acumula exposición que ninguna
-- pantalla suma hoy. Se acepta por ahora; queda dicho aquí para que quien lo
-- lea mañana sepa que fue una decisión y no un descuido.
-- ===========================================================================

create or replace function public.fn_asegurar_sorteo(
  p_fecha date,
  p_hora  public.hora_sorteo
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_time   time;
  v_limite numeric(14,2);
  v_estado public.estado_sorteo;
  v_hoy    date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  -- Hacia atrás no: un sorteo de ayer que nunca existió no se inventa ahora.
  -- Lo que ya pasó se registra con la venta forzada de administración, que
  -- deja rastro de que se hizo fuera de hora.
  if p_fecha < v_hoy then
    raise exception 'No se puede vender a un sorteo de una fecha pasada.'
      using errcode = 'invalid_parameter_value';
  end if;

  select s.id, s.estado into v_id, v_estado
  from public.sorteo s
  where s.fecha = p_fecha and s.hora = p_hora;

  -- Ya existe: se devuelve tal cual. Si está cerrado o liquidado, quien decide
  -- si admite venta es `fn_registrar_ticket`, no esta función.
  if v_id is not null then
    return v_id;
  end if;

  v_time := case p_hora
              when '11:00' then time '11:00'
              when '15:00' then time '15:00'
              else time '21:00'
            end;

  -- Se crea con su hora de cierre, igual que `fn_programar_dia`: un minuto
  -- antes del sorteo.
  insert into public.sorteo (fecha, hora, hora_cierre, estado)
  values (
    p_fecha,
    p_hora,
    ((p_fecha + v_time - interval '1 minute') at time zone 'America/Tegucigalpa'),
    'programado'
  )
  on conflict (fecha, hora) do nothing
  returning id into v_id;

  -- `do nothing` devuelve NULL si otra transacción lo creó en el mismo
  -- instante. No es un error: el sorteo existe, que es lo que se pedía.
  if v_id is null then
    select s.id into v_id
    from public.sorteo s
    where s.fecha = p_fecha and s.hora = p_hora;
    return v_id;
  end if;

  /*
   * Se abre sembrando el cupo AQUÍ, sin pasar por `fn_abrir_sorteo`.
   *
   * Aquella exige rol administrador, y a esta función la llama un vendedor.
   * Hoy no bloquearía —la aplicación habla como `service_role` y `fn_exige`
   * retorna sin comprobar nada— pero apoyarse en eso es apoyarse en un
   * accidente: el día que se vuelva a un modelo con JWT, la venta futura
   * empezaría a fallar y nadie relacionaría una cosa con la otra.
   *
   * Quién puede vender lo decide la Server Action, que sí tiene la sesión
   * delante. Aquí sólo se prepara el sorteo.
   *
   * Un sorteo futuro abierto no estorba al resto del sistema: las pantallas
   * que buscan «el de ahora» ordenan por hora de cierre, y el de octubre queda
   * al final de esa cola.
   */
  select l.limite_casa into v_limite
  from public.limite_franja l where l.hora = p_hora;

  insert into public.cupo_numero (sorteo_id, numero, limite_casa, vendido)
  select v_id, n, coalesce(v_limite, 5000), 0
  from generate_series(0, 99) as n
  on conflict (sorteo_id, numero) do nothing;

  update public.sorteo set estado = 'abierto' where id = v_id;

  perform public.fn_auditar('sorteo', v_id, 'crear_futuro', 'fecha',
                           null, p_fecha::text || ' ' || p_hora::text);

  return v_id;
end;
$$;

comment on function public.fn_asegurar_sorteo(date, public.hora_sorteo) is
  'Devuelve el sorteo de esa fecha y franja, creándolo y abriéndolo si no existe. Para la venta futura: los sorteos lejanos sólo existen si alguien los usa.';

revoke execute on function public.fn_asegurar_sorteo(date, public.hora_sorteo)
  from public, anon;


-- --------------------------------------------------------------------------
-- Los sorteos que el vendedor puede elegir.
--
-- Devuelve los del rango pedido —existan o no— con la marca de si todavía
-- admiten venta. Los que no existen salen igual, con `r_id` en nulo: es lo que
-- permite ofrecer el 15 de octubre sin haberlo creado todavía.
-- --------------------------------------------------------------------------

create or replace function public.fn_sorteos_disponibles(
  p_desde date,
  p_hasta date
) returns table (
  r_id          uuid,
  r_fecha       date,
  r_hora        public.hora_sorteo,
  r_estado      public.estado_sorteo,
  r_hora_cierre timestamptz,
  r_vendible    boolean,
  r_existe      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id,
         d.fecha,
         f.hora,
         s.estado,
         -- Si no existe, la hora de cierre se calcula igual: la pantalla la
         -- necesita para decir a qué hora deja de admitir venta.
         coalesce(
           s.hora_cierre,
           ((d.fecha + case f.hora
                         when '11:00' then time '11:00'
                         when '15:00' then time '15:00'
                         else time '21:00'
                       end - interval '1 minute') at time zone 'America/Tegucigalpa')
         ),
         -- Vendible: o no existe todavía —y entonces se creará al vender— o
         -- existe abierto y su hora de cierre no ha pasado.
         (s.id is null
          or (s.estado = 'abierto'
              and s.hora_cierre > now())),
         s.id is not null
  from generate_series(p_desde, p_hasta, interval '1 day') as d(fecha)
  cross join (values ('11:00'::public.hora_sorteo),
                     ('15:00'::public.hora_sorteo),
                     ('21:00'::public.hora_sorteo)) as f(hora)
  left join public.sorteo s on s.fecha = d.fecha and s.hora = f.hora
  order by d.fecha, f.hora;
$$;

comment on function public.fn_sorteos_disponibles(date, date) is
  'Los sorteos de un rango, existan o no, con la marca de si admiten venta. Los inexistentes salen con r_id nulo: se crean al vender.';

revoke execute on function public.fn_sorteos_disponibles(date, date)
  from public, anon;


-- --------------------------------------------------------------------------
-- La venta futura.
--
-- Es `fn_registrar_tanda` precedida de `fn_asegurar_sorteo`: se recibe la
-- FECHA y la FRANJA en vez del identificador, porque el sorteo puede no
-- existir todavía y el navegador no tendría qué mandar.
--
-- Todo lo demás lo hace la función de siempre. Una venta futura no es un tipo
-- distinto de venta.
-- --------------------------------------------------------------------------

create or replace function public.fn_registrar_venta_futura(
  p_fecha       date,
  p_hora        public.hora_sorteo,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_usuario_id  uuid default null,
  p_envio_id    uuid default null
) returns table (r_folio text, r_total numeric, r_creado_en timestamptz, r_repetido boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sorteo uuid;
begin
  v_sorteo := public.fn_asegurar_sorteo(p_fecha, p_hora);

  -- `p_forzar` va SIEMPRE en false: una venta futura no levanta el corte de
  -- hora. Si el sorteo ya cerró, se rechaza como cualquier otra venta tardía —
  -- forzar es cosa de administración, y esta puerta la usa el vendedor.
  return query
    select * from public.fn_registrar_tanda(
      v_sorteo, p_vendedor_id, p_tickets,
      p_lat, p_lng, false, p_usuario_id, p_envio_id
    );
end;
$$;

comment on function public.fn_registrar_venta_futura(date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid) is
  'Venta a un sorteo de otra fecha. Crea el sorteo si no existe y registra por la misma vía que cualquier venta.';

revoke execute on function public.fn_registrar_venta_futura(date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid)
  from public, anon;
