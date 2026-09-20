-- ===========================================================================
-- La captura masiva por totales también congela el factor.
--
-- Ya leía el factor del vendedor (`v_factor`) para multiplicar el premiado
-- tecleado; ahora además lo GUARDA en `factor_congelado`, para que el premiado
-- se deduzca luego con el factor de la captura y no con el vigente. Ver la 0107.
--
-- Se reproduce entera —una función es indivisible— con el único cambio en el
-- INSERT. La firma no cambia: `create or replace`.
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
        sorteo_id, vendedor_id, venta, premios, comision_congelada, factor_congelado, creado_por
      ) values (
        p_sorteo_id, v_fila.vendedor_id, coalesce(v_fila.venta, 0), v_premios,
        v_comision, v_factor, p_usuario_id
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

revoke execute on function public.fn_capturar_totales_masivo(uuid, jsonb, uuid)
  from public, anon;
