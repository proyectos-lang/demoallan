-- ===========================================================================
-- Corrige «column reference "hora" is ambiguous» en fn_sembrar_dia_demo.
--
-- La función declara `returns table (hora allan.hora_sorteo, …)`, así que
-- `hora` es también una variable de salida. En
--
--     on conflict (fecha, hora) do nothing
--
-- PostgreSQL no puede decidir si `hora` es la columna de `allan.sorteo` o la
-- variable, y un destino de conflicto NO admite cualificación: no se puede
-- escribir `on conflict (s.fecha, s.hora)`.
--
-- Es el mismo choque que arregló la 0004 en `fn_registrar_ticket`. Allí se
-- renombraron las columnas de salida; aquí basta con evitar el `on conflict`,
-- porque un `where not exists` sí se puede cualificar y deja la firma intacta
-- —lo que permite un `create or replace` sin tener que soltar la función—.
-- ===========================================================================

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

    -- `where not exists` en lugar de `on conflict (fecha, hora)`: aquí las
    -- columnas sí se pueden cualificar y desaparece la ambigüedad con la
    -- variable de salida `hora`.
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

    -- `do update`, no `do nothing`: los sorteos que ya existían traen el tope
    -- de su franja (4.000 a 7.000 L) y la restricción `cupo_no_excedido` haría
    -- fallar la carga en cuanto un número pasara de ahí.
    insert into allan.cupo_numero (sorteo_id, numero, limite_casa, vendido)
    select v_sorteo, n, 90000000, 0 from generate_series(0, 99) n
    on conflict (sorteo_id, numero) do update set limite_casa = 90000000;

    -- Un sorteo que se quedó en `programado` no se puede cerrar ni liquidar
    -- después. Se pasa a `abierto`, que es el estado que corresponde a un
    -- sorteo con ventas.
    update allan.sorteo s set estado = 'abierto'
    where s.id = v_sorteo and s.estado = 'programado';

    -- Perfil de apuesta del sorteo.
    v_dec  := floor(random() * 10)::int * 10;   -- decena de moda
    v_hot1 := floor(random() * 100)::int;       -- dos números perseguidos
    v_hot2 := floor(random() * 100)::int;

    -- Uno de cada diez sorteos "corre el dato" y un número se lleva una tajada
    -- enorme. Es el suceso que produce los meses en pérdida: sin él, con
    -- noventa sorteos al mes la ley de los grandes números aplana el resultado
    -- y nunca se vería un mes malo.
    if random() < 0.10 then
      v_cargado := floor(random() * 100)::int;
      v_pcarga  := 0.25 + random() * 0.20;
    else
      v_cargado := null;
      v_pcarga  := 0;
    end if;

    -- La venta ocurre en las cinco horas previas al cierre.
    v_inicio := ((p_fecha + v_time - interval '5 hours') at time zone 'America/Tegucigalpa');
    v_dur    := interval '4 hours 50 minutes';

    create temp table _tk (id uuid, vendedor_id uuid);

    -- 1. Tickets. `total` entra en 1 porque la restricción exige > 0; el valor
    --    de verdad se calcula en el paso 3, desde las líneas.
    with nuevos as (
      insert into allan.ticket
        (folio, sorteo_id, vendedor_id, canal, total, creado_en, lat, lng)
      select
        'D' || to_char(p_fecha, 'YYMMDD')
             || substr(v_h::text, 1, 2)
             || v.codigo
             || '-' || lpad(g::text, 3, '0'),
        v_sorteo, v.id, 'movil', 1,
        v_inicio + (random() * v_dur),
        -- El vendedor se mueve por su zona; no vende siempre en el mismo metro.
        v.lat + (random() - 0.5) * 0.012,
        v.lng + (random() - 0.5) * 0.012
      from allan.vendedor v
      cross join lateral generate_series(
        1, greatest(1, round(8 * (0.4 + random() * 1.2))::int)) g
      where v.activo
      returning id, vendedor_id
    )
    insert into _tk select id, vendedor_id from nuevos;

    -- 2. Líneas, con los parámetros del vendedor CONGELADOS (§1). Aunque esto
    --    no pase por `fn_registrar_ticket`, el congelamiento se respeta: es lo
    --    que hace que la utilidad histórica no se reescriba nunca.
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
    cross join lateral generate_series(1, 1 + floor(random() * 8)::int) g
    -- Los tres azares se materializan una sola vez por línea. Escribir
    -- random() varias veces en la expresión daría un valor distinto en cada
    -- aparición y la mezcla de probabilidades dejaría de sumar 1.
    cross join lateral (select random() r, random() r2, random() r3) x;

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

revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;
