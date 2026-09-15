-- ===========================================================================
-- Capturar por totales el padrón entero de un sorteo, de una vez.
--
-- QUÉ HUECO LLENA
-- ---------------
-- La captura por totales se hacía de uno en uno: elegir vendedor, teclear
-- venta y premiado, confirmar, y volver a empezar. Con 102 vendedores activos
-- eso son 102 vueltas, y ya hubo un sorteo con 67 capturas en un día.
--
-- La hoja de papel de la que se copia tiene forma de tabla, y la pantalla
-- ahora también: una fila por vendedor, se baja con las flechas, se guarda
-- todo junto.
--
-- QUÉ TOCA Y QUÉ NO
-- -----------------
-- SÓLO LAS CAPTURAS POR TOTALES. Las ventas que el vendedor registró por su
-- teléfono —`ticket` y `linea`— no se tocan jamás desde aquí: son suyas, tienen
-- números y folio, y la captura por totales es otra fuente que convive con
-- ellas. Confundirlas sería borrar la venta de alguien al teclear su hoja.
--
-- Por vendedor, entonces:
--   · Sin captura previa y con cifra  -> se crea.
--   · Con captura previa y cifra distinta -> se CORRIGE la que hay.
--   · Con captura previa y la misma cifra -> se deja en paz.
--   · Sin cifra (fila en blanco) -> no se hace nada. Una fila vacía es «no
--     tengo su hoja», no «vendió cero»; anular lo ya capturado por dejar un
--     hueco en blanco sería destruir dato sin que nadie lo pidiera.
--
-- TODO O NADA. Una función plpgsql es una transacción: si la fila 80 tiene un
-- vendedor inactivo, no se guarda ninguna. Con 102 filas, guardar la mitad y
-- fallar sería peor que no guardar nada — nadie sabría por dónde iba.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action. La base
-- habla como `service_role` desde la 0024.
-- ===========================================================================

create or replace function public.fn_capturar_totales_masivo(
  p_sorteo_id  uuid,
  /* `[{ "vendedor_id": "…", "venta": 3345, "premiado": 20 }, ...]`
     `premiado` es lo APOSTADO al número ganador, no lo pagado: el factor lo
     aplica esta función, igual que la captura de uno en uno. */
  p_filas      jsonb,
  p_usuario_id uuid default null
)
returns table (
  r_creadas    integer,
  r_corregidas integer,
  r_sin_cambio integer,
  r_venta      numeric,   -- lo que suman las filas guardadas
  r_premios    numeric    -- ya multiplicado por el factor de cada uno
)
language plpgsql
security definer
set search_path = public
as $masivo$
declare
  v_estado     public.estado_sorteo;
  v_fila       record;
  v_actual     public.venta_total%rowtype;
  v_comision   numeric(6,5);
  v_factor     numeric;
  v_premios    numeric(14,2);
  v_creadas    integer := 0;
  v_corregidas integer := 0;
  v_igual      integer := 0;
  v_suma_venta numeric(14,2) := 0;
  v_suma_prem  numeric(14,2) := 0;
  v_id         uuid;
begin
  select estado into v_estado from public.sorteo where id = p_sorteo_id;
  if v_estado is null then
    raise exception 'El sorteo no existe.'
      using errcode = 'no_data_found';
  end if;

  if p_filas is null or jsonb_array_length(p_filas) = 0 then
    raise exception 'No hay ninguna fila que guardar.'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_fila in
    select (e->>'vendedor_id')::uuid           as vendedor_id,
           nullif(e->>'venta', '')::numeric    as venta,
           nullif(e->>'premiado', '')::numeric as premiado
    from jsonb_array_elements(p_filas) e
  loop
    /*
     * La fila en blanco se salta.
     *
     * Ni venta ni premiado significa «no tengo su hoja», no «vendió cero». Si
     * ya tenía captura, se queda: anularla por dejar un hueco vacío sería
     * destruir un dato que nadie pidió borrar.
     */
    if coalesce(v_fila.venta, 0) = 0 and coalesce(v_fila.premiado, 0) = 0 then
      continue;
    end if;

    if coalesce(v_fila.venta, 0) < 0 or coalesce(v_fila.premiado, 0) < 0 then
      raise exception 'Ni la venta ni el premiado pueden ser negativos (vendedor %).',
        v_fila.vendedor_id
        using errcode = 'invalid_parameter_value';
    end if;

    -- El vendedor tiene que estar vivo: un dado de baja no genera venta nueva.
    select p.comision, p.factor_pago into v_comision, v_factor
    from public.parametro_vendedor p
    join public.vendedor v on v.id = p.vendedor_id
    where p.vendedor_id = v_fila.vendedor_id
      and p.vigente_hasta is null
      and v.activo
      and v.eliminado_en is null
    limit 1;

    if v_comision is null then
      raise exception 'El vendedor % no está activo o no tiene parámetros vigentes.',
        v_fila.vendedor_id
        using errcode = 'invalid_parameter_value';
    end if;

    -- Se teclea lo APOSTADO; lo que se guarda es lo PAGADO. La multiplicación
    -- la hace la máquina, como en la captura de uno en uno.
    v_premios := round(coalesce(v_fila.premiado, 0) * v_factor, 2);

    /*
     * ¿Ya tenía captura VIVA en este sorteo?
     *
     * Sólo se mira `venta_total`. Sus tickets con números no entran aquí ni
     * para consultarlos: son otra fuente, conviven con la captura, y tocarlos
     * desde esta pantalla sería borrar la venta que él registró.
     */
    select * into v_actual
    from public.venta_total
    where sorteo_id = p_sorteo_id
      and vendedor_id = v_fila.vendedor_id
      and anulado_en is null
    for update;

    if not found then
      insert into public.venta_total (
        sorteo_id, vendedor_id, venta, premios, comision_congelada, creado_por
      ) values (
        p_sorteo_id, v_fila.vendedor_id, coalesce(v_fila.venta, 0), v_premios,
        v_comision, p_usuario_id
      )
      returning id into v_id;

      perform public.fn_auditar('venta_total', v_id, 'registrar', 'venta',
                                null, coalesce(v_fila.venta, 0)::text, p_usuario_id);
      v_creadas := v_creadas + 1;

    elsif v_actual.venta is distinct from coalesce(v_fila.venta, 0)
       or v_actual.premios is distinct from v_premios then

      update public.venta_total
      set venta   = coalesce(v_fila.venta, 0),
          premios = v_premios
      where id = v_actual.id;

      -- Lo de antes y lo de después, campo por campo: es lo que permite
      -- reconstruir con qué cifra se cuadró la hoja de ese vendedor.
      if v_actual.venta is distinct from coalesce(v_fila.venta, 0) then
        perform public.fn_auditar('venta_total', v_actual.id, 'editar', 'venta',
                                  v_actual.venta::text,
                                  coalesce(v_fila.venta, 0)::text, p_usuario_id);
      end if;

      if v_actual.premios is distinct from v_premios then
        perform public.fn_auditar('venta_total', v_actual.id, 'editar', 'premios',
                                  v_actual.premios::text, v_premios::text, p_usuario_id);
      end if;

      v_corregidas := v_corregidas + 1;
    else
      v_igual := v_igual + 1;
    end if;

    v_suma_venta := v_suma_venta + coalesce(v_fila.venta, 0);
    v_suma_prem  := v_suma_prem + v_premios;

    /*
     * Y se rehace la liquidación si el sorteo ya estaba liquidado.
     *
     * Por vendedor, dentro del bucle: `fn_recalcular_liquidacion` trabaja
     * sobre uno. Rechaza si ese sorteo ya se pagó en un corte, y al rechazar
     * se deshace el guardado ENTERO —las 102 filas—, que es lo correcto: media
     * matriz guardada no la sabría reconstruir nadie.
     */
    if v_estado = 'liquidado' then
      perform public.fn_recalcular_liquidacion(p_sorteo_id, v_fila.vendedor_id);
    end if;
  end loop;

  return query select v_creadas, v_corregidas, v_igual, v_suma_venta, v_suma_prem;
end;
$masivo$;

comment on function public.fn_capturar_totales_masivo(uuid, jsonb, uuid) is
  'Guarda de una vez la captura por totales de muchos vendedores. Crea, corrige o deja igual cada fila; nunca toca los tickets con números. Todo o nada.';

revoke execute on function public.fn_capturar_totales_masivo(uuid, jsonb, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- La matriz: un vendedor por fila, con lo que ya tenga.
--
-- Trae el padrón ENTERO —las filas en blanco son las que faltan por teclear—
-- y, para cada uno, lo que ya se le capturó y si registró venta por su
-- teléfono. Lo segundo es lo que permite filtrar: quien ya vendió por el
-- portal normalmente no necesita captura, y teclearle una sumaría dos veces.
-- ---------------------------------------------------------------------------
create or replace function public.fn_matriz_totales(p_sorteo_id uuid)
returns table (
  r_vendedor_id uuid,
  r_codigo      text,
  r_vendedor    text,
  r_factor      numeric,
  r_comision    numeric,
  /* Lo ya capturado por totales, si lo hay. */
  r_venta       numeric,
  /* Lo APOSTADO, deducido del premio pagado: es lo que se teclea. */
  r_premiado    numeric,
  r_captura_id  uuid,
  /* Lo que vendió por su teléfono en este sorteo. Cero si no vendió. */
  r_venta_propia numeric,
  r_tickets      integer
)
language sql
stable
security definer
set search_path = public
as $matriz$
  with propio as (
    select t.vendedor_id,
           count(distinct t.id)::integer as tickets,
           coalesce(sum(l.monto), 0)     as venta
    from public.ticket t
    left join public.linea l on l.ticket_id = t.id
    where t.sorteo_id = p_sorteo_id
      and t.anulado_en is null
    group by t.vendedor_id
  ),
  capturado as (
    select vt.vendedor_id, vt.id, vt.venta, vt.premios
    from public.venta_total vt
    where vt.sorteo_id = p_sorteo_id
      and vt.anulado_en is null
  )
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         p.factor_pago,
         p.comision,
         c.venta,
         -- Se devuelve lo APOSTADO, no lo pagado: es lo que se teclea, y la
         -- casilla tiene que abrir con la misma cifra que se escribió.
         case when c.id is not null and coalesce(p.factor_pago, 0) > 0
              then round(c.premios / p.factor_pago, 2) end,
         c.id,
         coalesce(pr.venta, 0),
         coalesce(pr.tickets, 0)
  from public.vendedor v
  join public.parametro_vendedor p
    on p.vendedor_id = v.id and p.vigente_hasta is null
  left join capturado c on c.vendedor_id = v.id
  left join propio pr on pr.vendedor_id = v.id
  where v.activo and v.eliminado_en is null
  order by v.codigo;
$matriz$;

comment on function public.fn_matriz_totales(uuid) is
  'El padrón entero para capturar por totales un sorteo, con lo ya capturado y lo que cada uno vendió por su teléfono.';

revoke execute on function public.fn_matriz_totales(uuid) from public, anon;
