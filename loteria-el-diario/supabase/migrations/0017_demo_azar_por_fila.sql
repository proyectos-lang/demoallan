-- ===========================================================================
-- El azar del generador se evaluaba UNA VEZ por sentencia, no por fila.
--
-- SÍNTOMA
-- -------
-- El primer día sembrado salió así:
--
--     11:00   390 tickets   390 líneas   L 1,950     -> 1 línea por ticket, todas de 5 L
--     15:00   120 tickets   960 líneas   L 96,000    -> 8 líneas por ticket, todas de 100 L
--     20:00   120 tickets   720 líneas   L 36,000    -> 6 líneas por ticket, todas de 50 L
--
-- Cada sorteo con un único monto repetido y un único número de líneas. No es
-- una distribución improbable: es una constante.
--
-- CAUSA
-- -----
-- Los `cross join lateral` no referenciaban la fila externa:
--
--     cross join lateral generate_series(1, 1 + floor(random() * 8)::int) g
--     cross join lateral (select random() r, random() r2, random() r3) x
--
-- Al no depender de nada de fuera, el planificador los trata como invariantes
-- y los evalúa una sola vez para toda la inserción. `random()` es VOLATILE,
-- pero eso sólo obliga a reevaluarla por cada fila DEL SUBPLAN — y el subplan
-- se ejecuta una vez. En la lista de salida de un SELECT sí se evalúa por
-- fila; dentro de un lateral no correlacionado, no.
--
-- ARREGLO
-- -------
-- Se sustituye `random()` por un azar DERIVADO DE LA PROPIA FILA: el md5 del
-- identificador del ticket más una sal. Como la entrada cambia en cada fila, el
-- valor cambia en cada fila y no hay nada que elevar.
--
-- Efecto secundario que conviene: el histórico pasa a ser reproducible. Volver
-- a sembrarlo da exactamente las mismas cifras, que es lo que uno quiere si el
-- gerente pregunta mañana por un número que vio hoy.
-- ===========================================================================

-- Azar determinista en [0,1) a partir de un texto. Los primeros 8 dígitos
-- hexadecimales del md5 son 32 bits, que se llevan a fracción.
create or replace function allan.fn_azar(p_semilla text)
returns double precision
language sql
immutable
set search_path = allan, public
as $$
  select (('x' || substr(md5(p_semilla), 1, 8))::bit(32)::bigint)::double precision
         / 4294967296.0;
$$;

comment on function allan.fn_azar(text) is
  'Azar reproducible por fila. Sustituye a random() dentro de LATERAL: una expresión que depende de la fila no puede elevarse fuera del bucle.';

create or replace function allan.fn_sembrar_dia_demo(p_fecha date)
returns table (hora allan.hora_sorteo, tickets integer, lineas integer, venta numeric)
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  -- Montos exactos de las hojas manuscritas. Repetir un valor es cómo se
  -- pondera: el 5 y el 10 salen cuatro veces más que el 150.
  v_montos integer[] := array[
    5,5,5,5,10,10,10,10,15,15,20,20,20,25,25,30,30,30,50,50,50,50,
    100,100,100,100,150,200,200,250,250,300,300,300,500,500];
  v_h       allan.hora_sorteo;
  v_time    time;
  v_sorteo  uuid;
  v_sal     text;            -- semilla del sorteo, para que cada uno difiera
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

    -- `where not exists` en lugar de `on conflict (fecha, hora)`: el destino de
    -- un conflicto no admite cualificación y `hora` es también variable de
    -- salida de esta función.
    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    select p_fecha, v_h,
           ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
           'abierto'
    where not exists (
      select 1 from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h);

    select s.id into v_sorteo
    from allan.sorteo s where s.fecha = p_fecha and s.hora = v_h;

    -- Idempotente: un sorteo que ya tiene ventas no se vuelve a sembrar.
    if exists (select 1 from allan.ticket t where t.sorteo_id = v_sorteo limit 1) then
      continue;
    end if;

    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    -- Perfil de apuesta del sorteo, derivado de su fecha y hora para que sea
    -- reproducible pero distinto en cada sorteo.
    v_sal  := p_fecha::text || v_h::text;
    v_dec  := floor(allan.fn_azar(v_sal || 'dec') * 10)::int * 10;
    v_hot1 := floor(allan.fn_azar(v_sal || 'h1') * 100)::int;
    v_hot2 := floor(allan.fn_azar(v_sal || 'h2') * 100)::int;

    -- Uno de cada diez sorteos "corre el dato" y un número se lleva una tajada
    -- enorme. Es el suceso que produce los meses en pérdida: sin él, con
    -- noventa sorteos al mes la ley de los grandes números aplana el resultado.
    if allan.fn_azar(v_sal || 'carga') < 0.10 then
      v_cargado := floor(allan.fn_azar(v_sal || 'cn') * 100)::int;
      v_pcarga  := 0.25 + allan.fn_azar(v_sal || 'cp') * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    create temp table _tk (id uuid, vendedor_id uuid);

    -- 1. Tickets. El número por vendedor sale de su identificador, así que
    --    varía de vendedor a vendedor y de sorteo a sorteo.
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
        -- El vendedor se mueve por su zona; no vende siempre en el mismo metro.
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

    -- 2. Líneas, con los parámetros del vendedor CONGELADOS (§1).
    --    Cada azar se deriva del ticket y del índice de línea: depende de la
    --    fila, y por eso no puede evaluarse una sola vez.
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

    -- 3. Total del ticket = suma de sus líneas.
    update allan.ticket t
    set total = s.suma
    from (select l.ticket_id, sum(l.monto) suma
          from allan.linea l join _tk k on k.id = l.ticket_id
          group by l.ticket_id) s
    where t.id = s.ticket_id;

    -- 4. Contador de cupo, que es lo que leen el control y la liquidación.
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

revoke execute on function allan.fn_azar(text) from public, anon;
revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;
