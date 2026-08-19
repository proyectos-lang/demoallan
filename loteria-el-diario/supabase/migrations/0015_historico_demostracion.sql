-- ===========================================================================
-- Histórico sintético para demostración.
--
-- QUÉ ES Y QUÉ NO ES
-- ------------------
-- Datos INVENTADOS con la forma de los reales. Sirven para enseñar el sistema
-- funcionando con volumen; no son operación. Todo lo que crea queda marcado:
-- los vendedores de demostración van del V-101 en adelante, y `fn_borrar_demo`
-- lo retira entero. Que la retirada exista desde el primer día es deliberado:
-- un juego de datos de demo sin forma de quitarlo termina confundido con la
-- operación real.
--
-- DE DÓNDE SALEN LOS NÚMEROS
-- --------------------------
-- Los montos por línea replican los de dos hojas manuscritas reales: moda
-- entre 5 y 30 L, cola hasta 500. La concentración también es de las hojas —
-- en una de ellas la decena del 90 llevaba de 200 a 500 L por número mientras
-- el resto iba a 30.
--
-- Esa concentración es lo que hace que el negocio pierda: si sale un número
-- cargado, el premio se dispara. Sin ella el resultado mensual sería casi
-- constante y la demostración mentiría sobre el riesgo del negocio.
--
-- SIN TOPE POR NÚMERO
-- -------------------
-- Por decisión explícita, el histórico se genera sin tope efectivo: el interés
-- es ver el movimiento, no cuánto se habría rechazado. `limite_casa` se fija
-- absurdamente alto para que la restricción `cupo_no_excedido` no estorbe.
-- ===========================================================================

-- --- Padrón de demostración ------------------------------------------------

create or replace function allan.fn_sembrar_vendedores_demo(p_cuantos integer default 25)
returns integer
language plpgsql
security definer
set search_path = allan, public
as $$
declare
  v_nombres text[] := array[
    'Ana L. Interiano','Marvin O. Cáceres','Yolanda Sabillón','Óscar R. Turcios',
    'Karla P. Mejía','Wilmer A. Discua','Suyapa Banegas','Élmer J. Fajardo',
    'Nolvia E. Barahona','Rigoberto Mencía','Xiomara Pineda','Denis A. Corrales',
    'Blanca R. Hernández','Osman F. Velásquez','Iris N. Maldonado','Gerson Aguilar',
    'Lourdes A. Cárcamo','Fredy O. Palma','Mirna S. Portillo','Allan D. Bustillo',
    'Reina I. Zúniga','Héctor M. Andino','Delmy A. Rivera','Josué E. Pavón',
    'Sandra L. Guevara','Erick A. Bonilla','Marlen O. Castellanos','Tito R. Lanza',
    'Norma E. Alvarado','Julio C. Sierra'];
  v_zonas text[] := array[
    'SPS · Centro','SPS · Guamilito','SPS · Río de Piedras','SPS · Cofradía',
    'SPS · Satélite','SPS · Medina','SPS · Bella Vista','SPS · Sunseri',
    'SPS · El Benque','SPS · Las Palmas','SPS · Suyapa','SPS · Barandillas',
    'SPS · Cabañas','SPS · La Guardia',
    'Choloma · Centro','Choloma · López Arellano','Choloma · Las Brisas',
    'Choloma · Buenos Aires','Choloma · Sector 3','Choloma · El Higuero',
    'Choloma · Zona Norte',
    'Villanueva · Centro','Villanueva · Cofradía','Villanueva · Búfalo',
    'Villanueva · Río Blanco',
    'La Lima · Centro','La Lima · Campo Rojo','La Lima · Planta',
    'Puerto Cortés · Centro','Puerto Cortés · Laguna'];
  v_ciudades text[] := array[
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula','San Pedro Sula','San Pedro Sula',
    'San Pedro Sula','San Pedro Sula',
    'Choloma','Choloma','Choloma','Choloma','Choloma','Choloma','Choloma',
    'Villanueva','Villanueva','Villanueva','Villanueva',
    'La Lima','La Lima','La Lima',
    'Puerto Cortés','Puerto Cortés'];
  -- Centro aproximado de cada zona, para que el mapa no amontone a todo el
  -- padrón en un mismo punto.
  v_lat numeric[] := array[
    15.5045,15.5120,15.4980,15.4560,15.5310,15.5180,15.5240,15.4420,
    15.4890,15.5390,15.5070,15.4950,15.5150,15.4790,
    15.6120,15.5980,15.6210,15.6050,15.6180,15.5890,15.6340,
    15.3160,15.3040,15.3280,15.2950,
    15.4340,15.4210,15.4460,
    15.8420,15.8310];
  v_lng numeric[] := array[
    -88.0250,-88.0310,-88.0180,-88.0890,-88.0210,-88.0340,-88.0120,-88.0760,
    -88.0430,-88.0290,-88.0380,-88.0150,-88.0470,-88.0620,
    -87.9510,-87.9620,-87.9430,-87.9580,-87.9390,-87.9670,-87.9480,
    -87.9980,-88.0120,-87.9860,-88.0230,
    -87.9110,-87.9240,-87.8980,
    -87.9450,-87.9560];
  v_colores text[] := array['#2563eb','#0891b2','#e11d48','#7c3aed','#059669',
                            '#d97706','#0d9488','#4f46e5','#ea580c','#be123c'];
  i         integer;
  v_id      uuid;
  v_creados integer := 0;
begin
  perform allan.fn_exige(array['administrador']::allan.rol_usuario[]);

  for i in 1..least(p_cuantos, array_length(v_nombres, 1)) loop
    v_id := null;

    insert into allan.vendedor (codigo, nombre, ciudad, barrio, zona, color,
                                lat, lng, telefono)
    values (
      'V-' || lpad((100 + i)::text, 3, '0'),
      v_nombres[i],
      v_ciudades[i],
      split_part(v_zonas[i], ' · ', 2),
      v_zonas[i],
      v_colores[1 + (i % 10)],
      -- Dispersión de kilómetro y medio alrededor del centro de la zona.
      v_lat[i] + (random() - 0.5) * 0.028,
      v_lng[i] + (random() - 0.5) * 0.028,
      '9' || lpad((floor(random() * 9999999))::int::text, 7, '0')
    )
    on conflict (codigo) do nothing
    returning id into v_id;

    if v_id is not null then
      -- Comisión de 10 % a 13 % y factor de 70 a 72, que es lo que se ve en la
      -- plaza. El tope del vendedor va altísimo: el histórico se pidió sin tope.
      insert into allan.parametro_vendedor
        (vendedor_id, comision, factor_pago, tope_por_numero, vigente_desde)
      values (
        v_id,
        round((0.10 + random() * 0.03)::numeric, 5),
        70 + floor(random() * 3),
        9000000,
        '2025-12-31 00:00:00-06'::timestamptz
      );
      v_creados := v_creados + 1;
    end if;
  end loop;

  return v_creados;
end;
$$;

-- --- Un día de histórico ---------------------------------------------------
-- Se siembra día a día en lugar de por todo el rango: cada llamada es corta, el
-- avance se ve, y si algo se corta se reanuda donde iba. Un único statement de
-- setecientas mil filas se arriesga a agotar el tiempo límite.

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

    insert into allan.sorteo (fecha, hora, hora_cierre, estado)
    values (p_fecha, v_h,
            ((p_fecha + v_time - interval '10 minutes') at time zone 'America/Tegucigalpa'),
            'abierto')
    on conflict (fecha, hora) do nothing;

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
    -- después. Se pasa a `abierto`, que es el estado que le corresponde a un
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

-- --- Retirada --------------------------------------------------------------

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
    select t.id from allan.ticket t
    join allan.vendedor v on v.id = t.vendedor_id
    where v.codigo ~ '^V-1[0-9]{2}$');
  get diagnostics v_l = row_count;

  delete from allan.ticket t
  using allan.vendedor v
  where v.id = t.vendedor_id and v.codigo ~ '^V-1[0-9]{2}$';
  get diagnostics v_t = row_count;

  -- Sorteos que quedaron sin una sola venta, anteriores a hoy. Los de hoy y los
  -- futuros son de la operación y no se tocan.
  delete from allan.liquidacion lq
  where lq.sorteo_id in (
    select s.id from allan.sorteo s
    where s.fecha < v_hoy
      and not exists (select 1 from allan.ticket t where t.sorteo_id = s.id));

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

revoke execute on function allan.fn_sembrar_vendedores_demo(integer) from public, anon, authenticated;
revoke execute on function allan.fn_sembrar_dia_demo(date) from public, anon, authenticated;
revoke execute on function allan.fn_borrar_demo() from public, anon, authenticated;
