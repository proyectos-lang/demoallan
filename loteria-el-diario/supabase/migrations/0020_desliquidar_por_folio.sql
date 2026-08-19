-- ===========================================================================
-- El guardián de `fn_desliquidar_demo` miraba el marcador equivocado.
--
-- Comprobaba que ningún ticket del sorteo fuera de un vendedor real (V-001 a
-- V-005), y rechazaba todo con:
--
--     El sorteo tiene 47 ventas de vendedores reales.
--
-- La comprobación era correcta; la premisa, no. El generador siembra para
-- TODOS los vendedores activos, los cinco originales incluidos — que es lo
-- deseable: un padrón donde cinco de treinta no tienen historia se ve raro en
-- el mapa y en los reportes.
--
-- El marcador fiable es el FOLIO, no el vendedor. `fn_registrar_ticket` los
-- compone como `V001-20260819-0001`, siempre empezando por el código del
-- vendedor; el generador de demostración los estampa con `D` y la fecha. Son
-- espacios de nombres disjuntos, y el prefijo identifica el origen del dato
-- sin depender de quién lo vendió.
-- ===========================================================================

create or replace function allan.fn_desliquidar_demo(p_sorteo_id uuid)
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_total  integer := 0;
  v_reales integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  -- Un ticket es de demostración si su folio empieza por 'D'. Los que emite
  -- `fn_registrar_ticket` empiezan por el código del vendedor (V001-…), así
  -- que los dos espacios de nombres no se solapan.
  select count(*),
         count(*) filter (where t.folio !~ '^D[0-9]{6}')
  into v_total, v_reales
  from allan.ticket t
  where t.sorteo_id = p_sorteo_id;

  if v_total = 0 then
    return 'sin ventas: nada que deshacer';
  end if;

  if v_reales > 0 then
    raise exception
      'El sorteo tiene % ventas que no son de demostración. Deshacer una liquidación sólo se permite sobre datos sintéticos.',
      v_reales
      using errcode = 'insufficient_privilege';
  end if;

  update allan.linea l
  set gana = false, premio = 0
  from allan.ticket t
  where t.id = l.ticket_id
    and t.sorteo_id = p_sorteo_id
    and l.gana;

  delete from allan.liquidacion lq where lq.sorteo_id = p_sorteo_id;

  update allan.sorteo s
  set estado = 'cerrado',
      numero_ganador = null,
      liquidado_en = null,
      liquidado_por = null
  where s.id = p_sorteo_id
    and s.estado = 'liquidado';

  perform allan.fn_auditar('sorteo', p_sorteo_id, 'desliquidar_demo', 'estado',
                           'liquidado', 'cerrado');

  return 'deshecho';
end;
$$;

-- --- La retirada, por el mismo criterio ------------------------------------
-- `fn_borrar_demo` borraba por código de vendedor, así que habría dejado atrás
-- todos los tickets sintéticos de los cinco vendedores originales.

create or replace function allan.fn_borrar_demo()
returns text
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_t integer := 0;
  v_l integer := 0;
  v_s integer := 0;
  v_v integer := 0;
  v_hoy date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  delete from allan.linea l
  where l.ticket_id in (
    select t.id from allan.ticket t where t.folio ~ '^D[0-9]{6}');
  get diagnostics v_l = row_count;

  delete from allan.liquidacion lq
  where lq.sorteo_id in (
    select s.id from allan.sorteo s where s.fecha < v_hoy);

  delete from allan.ticket t where t.folio ~ '^D[0-9]{6}';
  get diagnostics v_t = row_count;

  -- Sorteos que quedaron sin una sola venta, anteriores a hoy. Los de hoy y los
  -- futuros son de la operación y no se tocan.
  delete from allan.cupo_numero c
  where c.sorteo_id in (
    select s.id from allan.sorteo s
    where s.fecha < v_hoy
      and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id));

  delete from allan.sorteo s
  where s.fecha < v_hoy
    and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id);
  get diagnostics v_s = row_count;

  delete from allan.parametro_vendedor p
  using allan.vendedor v
  where v.id = p.vendedor_id and v.codigo ~ '^V-1[0-9]{2}$';

  delete from allan.vendedor v where v.codigo ~ '^V-1[0-9]{2}$';
  get diagnostics v_v = row_count;

  return format('retirado: %s líneas, %s tickets, %s sorteos, %s vendedores',
                v_l, v_t, v_s, v_v);
end;
$$;

revoke execute on function allan.fn_desliquidar_demo(uuid) from public, anon, authenticated;
revoke execute on function allan.fn_borrar_demo() from public, anon, authenticated;
