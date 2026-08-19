-- ===========================================================================
-- El sembrado se degradaba hasta agotar el tiempo límite.
--
-- SÍNTOMA
-- -------
-- Los primeros días tardaban ~450 ms. Hacia el día 207, con `allan.linea` ya en
-- 650 mil filas, una llamada superó el `statement_timeout` y abortó:
--
--     2026-07-26: canceling statement due to statement timeout
--
-- CAUSA
-- -----
-- La tabla temporal `_tk` se crea vacía y se llena en la misma transacción, así
-- que NUNCA tiene estadísticas. El planificador le supone un tamaño por defecto
-- —del orden de mil filas— y con esa estimación decide que, para
--
--     from allan.linea l join _tk k on k.id = l.ticket_id
--
-- sale más barato recorrer `allan.linea` entera y hacer un hash join que
-- entrar por el índice `linea_ticket`. Cuando `linea` tenía diez mil filas ese
-- recorrido era gratis; con 650 mil, multiplicado por los tres sorteos del día,
-- deja de serlo. El plan no empeoró: siempre fue el mismo, y lo que creció fue
-- lo que costaba.
--
-- ARREGLO
-- -------
-- Clave primaria en `_tk` —que da índice para el join— y un `analyze` en cuanto
-- se llena, para que el planificador conozca su tamaño real y elija el bucle
-- anidado por índice.
-- ===========================================================================

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_sal     text;
  v_dec     integer;
  v_hot1    integer;
  v_hot2    integer;
  v_cargado integer;
  v_pcarga  numeric;
  v_inicio  timestamptz;
  v_dur     interval;
  v_n       integer;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  foreach v_h in array array['11:00','15:00','20:00']::allan.hora_sorteo[]
  loop
    v_time := case v_h when '11:00' then time '11:00'
                       when '15:00' then time '15:00'
                       else time '20:00' end;

    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    select p_fecha, v_h,
           ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
           'abierto'
    where not exists (
      select 1 from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h);

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    v_sal  := p_fecha::text || v_h::text;
    v_dec  := floor(allan.fn_azar(v_sal || 'dec') * 10)::int * 10;
    v_hot1 := floor(allan.fn_azar(v_sal || 'h1') * 100)::int;
    v_hot2 := floor(allan.fn_azar(v_sal || 'h2') * 100)::int;

    if allan.fn_azar(v_sal || 'carga') < 0.10 then
      v_cargado := floor(allan.fn_azar(v_sal || 'cn') * 100)::int;
      v_pcarga  := 0.25 + allan.fn_azar(v_sal || 'cp') * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    -- Con clave primaria: el join contra `allan.linea` tiene por dónde entrar.
    create temp table _tk (id uuid primary key, vendedor_id uuid);

    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (allan.fn_azar(v.id::text || v_sal || g::text || 'h') * v_dur),
        v.lat + (allan.fn_azar(v.id::text || v_sal || g::text || 'la') - 0.5) * 0.012,
        v.lng + (allan.fn_azar(v.id::text || v_sal || g::text || 'ln') - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1,
        greatest(1, round(8 * (0.4 + allan.fn_azar(v.id::text || v_sal || 'nt') * 1.2))::int)
      ) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- Sin esto el planificador le supone un tamaño por defecto y prefiere
    -- recorrer `allan.linea` entera antes que entrar por `linea_ticket`.
    analyze _tk;

    insert into allan.linea
      (ticket_id, numero, monto, comision_congelada, factor_congelado)
    select
      t.id,
      case
        when v_cargado is not null and x.r < v_pcarga then v_cargado
        when x.r < v_pcarga + 0.15 then v_dec + floor(x.r2 * 10)::int
        when x.r < v_pcarga + 0.45 then case when x.r2 < 0.5 then v_hot1 else v_hot2 end
        else floor(x.r2 * 100)::int
      end,
      v_montos[1 + floor(x.r3 * array_length(v_montos, 1))::int],
      p.comision,
      p.factor_pago
    from _tk t
    join allan.parametro_vendedor p
      on p.vendedor_id = t.vendedor_id and p.vigente_hasta is null
    cross join lateral generate_series(
      1, 1 + floor(allan.fn_azar(t.id::text || 'nl') * 8)::int) g
    cross join lateral (
      select allan.fn_azar(t.id::text || g::text || 'a') r,
             allan.fn_azar(t.id::text || g::text || 'b') r2,
             allan.fn_azar(t.id::text || g::text || 'c') r3
    ) x;

    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    update allan.cupo_numero c
    set vendido = c.vendido + s.suma
    from (select l.numero, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.numero) s
    where c.sorteo_id = v_sorteo and c.numero = s.numero;

    select count(*)::int into v_n from _tk;
    select count(*)::int, coalesce(sum(l.monto), 0)
      into lineas, venta
      from allan.linea l join _tk k on k.id = l.ticket_id;

    hora := v_h;
    tickets := v_n;
    return next;

    drop table _tk;
  end loop;
end;
$$;

revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;
