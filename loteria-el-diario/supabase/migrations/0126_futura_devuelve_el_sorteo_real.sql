-- ===========================================================================
-- La venta futura también devuelve el SORTEO REAL del ticket.
--
-- `fn_registrar_venta_futura` delega en `fn_registrar_tanda`, cuyo retorno ganó
-- dos columnas (fecha y hora del sorteo, ver la 0125). Su `returns table` tiene
-- que coincidir, así que se suelta y se vuelve a crear con las mismas columnas.
-- El cuerpo no cambia: sigue asegurando el sorteo y delegando con `select *`.
-- ===========================================================================

drop function if exists public.fn_registrar_venta_futura(
  date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid
);

create function public.fn_registrar_venta_futura(
  p_fecha       date,
  p_hora        public.hora_sorteo,
  p_vendedor_id uuid,
  p_tickets     jsonb,
  p_lat         double precision default null,
  p_lng         double precision default null,
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
  v_sorteo uuid;
begin
  v_sorteo := public.fn_asegurar_sorteo(p_fecha, p_hora);

  -- `p_forzar` en false: una venta futura no levanta el corte de hora.
  return query
    select * from public.fn_registrar_tanda(
      v_sorteo, p_vendedor_id, p_tickets,
      p_lat, p_lng, false, p_usuario_id, p_envio_id
    );
end;
$$;

revoke execute on function public.fn_registrar_venta_futura(
  date, public.hora_sorteo, uuid, jsonb, double precision, double precision, uuid, uuid
) from public, anon;
