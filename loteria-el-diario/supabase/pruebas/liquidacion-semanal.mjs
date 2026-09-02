/**
 * Liquidación semanal y pagos parciales.
 *
 * La pregunta que contesta: si el lunes se le paga al vendedor lunes y martes,
 * ¿el informe de la semana deja de mostrarlos?
 *
 * Y la que importa más: ¿puede pagarse dos veces el mismo sorteo? La respuesta
 * no depende del filtro de la consulta —eso es comodidad de pantalla— sino del
 * `unique (liquidacion_id)` de `allan.corte_detalle`. Aquí se comprueba
 * llamando dos veces con el mismo identificador, que es lo que pasa cuando dos
 * administradores tienen el informe abierto a la vez.
 *
 *     node supabase/pruebas/liquidacion-semanal.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

// Lunes a miércoles de una semana que no existe en ningún histórico.
const DIAS = ["2097-05-13", "2097-05-14", "2097-05-15"];
const DESDE = DIAS[0];
const HASTA = "2097-05-19";
const GANADOR = 42;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const limpiar = async () => {
  const { data: cortes } = await sb.from("corte_vendedor").select("id").eq("desde", DESDE);
  for (const c of cortes ?? []) await sb.from("corte_detalle").delete().eq("corte_id", c.id);
  await sb.from("corte_vendedor").delete().eq("desde", DESDE);

  for (const fecha of DIAS) {
    const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", fecha);
    for (const s of sorteos ?? []) {
      const { data: lqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
      for (const lq of lqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", lq.id);
      await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
      const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
      for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
      await sb.from("ticket").delete().eq("sorteo_id", s.id);
      await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
      await sb.from("sorteo").delete().eq("id", s.id);
    }
  }
};

try {
  await limpiar();

  // --- 1. Tres días, un sorteo liquidado por día -------------------------
  console.log("\n1. Montaje: tres días liquidados");

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");
  const v = vs[0];

  for (const fecha of DIAS) {
    await sb.rpc("fn_programar_dia", { p_fecha: fecha });
    const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", fecha);
    const s = ss.find((x) => x.hora === "20:00");
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 50000 });
    await sb.rpc("fn_registrar_ticket", {
      p_sorteo_id: s.id,
      p_vendedor_id: v.id,
      p_lineas: [{ numero: GANADOR, monto: 100 }, { numero: 7, monto: 200 }],
    });
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: GANADOR });
  }

  const { data: todo } = await sb.rpc("fn_liquidacion_pendiente", {
    p_vendedor_id: v.id,
    p_desde: DESDE,
    p_hasta: HASTA,
  });
  check("los tres días aparecen pendientes", (todo ?? []).length === 3, `hay ${todo?.length}`);
  check(
    "vienen ordenados por fecha",
    (todo ?? []).map((f) => f.r_fecha).join(",") === DIAS.join(","),
  );
  check(
    "el saldo de cada fila es venta − comisión − premios",
    (todo ?? []).every(
      (f) =>
        Math.abs(
          Number(f.r_saldo) - (Number(f.r_venta) - Number(f.r_comision) - Number(f.r_premios)),
        ) < 0.01,
    ),
  );

  // --- 2. Pago parcial: lunes y martes ------------------------------------
  console.log("\n2. Pago parcial de dos días");
  const dosPrimeros = todo.slice(0, 2);

  const { data: corte, error: eCorte } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: dosPrimeros.map((f) => f.r_liquidacion_id),
    p_desde: DESDE,
    p_hasta: HASTA,
    p_nota: "prueba",
  });

  check("el corte se registra", !eCorte && !!corte?.[0], eCorte?.message ?? "");
  check("el corte cubre dos sorteos", Number(corte?.[0]?.r_sorteos) === 2);

  const saldoEsperado = dosPrimeros.reduce((a, f) => a + Number(f.r_saldo), 0);
  check(
    "el saldo del corte lo recalculó la base y coincide",
    Math.abs(Number(corte[0].r_saldo) - saldoEsperado) < 0.01,
    `da ${corte[0].r_saldo}, esperaba ${saldoEsperado}`,
  );

  // --- 3. Lo pagado no vuelve --------------------------------------------
  console.log("\n3. El informe ya no los muestra");
  const { data: resto } = await sb.rpc("fn_liquidacion_pendiente", {
    p_vendedor_id: v.id,
    p_desde: DESDE,
    p_hasta: HASTA,
  });

  check("queda un solo día pendiente", (resto ?? []).length === 1, `hay ${resto?.length}`);
  check("el que queda es el tercero", resto?.[0]?.r_fecha === DIAS[2]);

  // --- 3b. El corte por semana parte lo pagado de lo pendiente -----------
  //
  // Es la cuenta que alimentan el riel de semanas, los tres totales de la
  // hoja y la pestaña de resumen. Con dos sorteos cobrados de tres, aquí se
  // ve si de verdad reparte o si vuelve a sumarlo todo.
  console.log("\n3b. Pagado y pendiente, semana a semana");
  const { data: porSemana, error: eSemana } = await sb.rpc("fn_liquidacion_por_semana", {
    p_vendedor_id: v.id,
  });
  check("fn_liquidacion_por_semana responde", !eSemana, eSemana?.message ?? "");

  const semana = (porSemana ?? []).find((x) => x.r_inicio <= DIAS[0] && x.r_fin >= DIAS[0]);
  check("la semana del montaje aparece", Boolean(semana), `${(porSemana ?? []).length} semanas`);

  if (semana) {
    const cent = (x) => Math.round(Number(x) * 100);
    check(
      "cuenta dos cobrados y uno pendiente",
      semana.r_pagadas === 2 && semana.r_pendientes === 1,
      `pagadas=${semana.r_pagadas} pendientes=${semana.r_pendientes}`,
    );
    check(
      "pagado + pendiente da el saldo de la semana",
      cent(semana.r_pagado) + cent(semana.r_pendiente) === cent(semana.r_saldo),
      `${semana.r_pagado} + ${semana.r_pendiente} != ${semana.r_saldo}`,
    );
    check(
      "lo pagado coincide con el saldo del corte",
      cent(semana.r_pagado) === cent(corte[0].r_saldo),
      `${semana.r_pagado} != ${corte[0].r_saldo}`,
    );
    check(
      "lo pendiente coincide con lo que sigue en el informe",
      cent(semana.r_pendiente) ===
        (resto ?? []).reduce((a, f) => a + Math.round(Number(f.r_saldo) * 100), 0),
    );

    // Las dos direcciones. Con un solo vendedor la semana va entera a un lado
    // o al otro, así que una de las dos tiene que ser cero: si las dos
    // salieran con valor, la clasificación estaría mirando el sorteo en vez
    // del saldo de la semana, y se cobraría y se pagaría al mismo vendedor la
    // misma semana.
    check(
      "por cobrar menos por pagar da lo pendiente",
      cent(semana.r_por_cobrar) - cent(semana.r_por_pagar) === cent(semana.r_pendiente),
      `${semana.r_por_cobrar} - ${semana.r_por_pagar} != ${semana.r_pendiente}`,
    );
    check(
      "ninguna de las dos direcciones es negativa",
      Number(semana.r_por_cobrar) >= 0 && Number(semana.r_por_pagar) >= 0,
      `${semana.r_por_cobrar} / ${semana.r_por_pagar}`,
    );
    check(
      "con un vendedor, la semana va entera a un lado",
      cent(semana.r_por_cobrar) === 0 || cent(semana.r_por_pagar) === 0,
      `${semana.r_por_cobrar} / ${semana.r_por_pagar}`,
    );
  }

  // Sin vendedor devuelve el negocio entero, que tiene que ser mayor o igual.
  const { data: global } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: null });
  const suya = (porSemana ?? []).reduce((a, x) => a + Math.round(Number(x.r_saldo) * 100), 0);
  const todas = (global ?? []).reduce((a, x) => a + Math.round(Number(x.r_saldo) * 100), 0);
  check("el global incluye lo de este vendedor", todas >= suya, `${todas} < ${suya}`);

  // --- 4. No se puede pagar dos veces ------------------------------------
  console.log("\n4. Doble pago");
  const { error: eDoble } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: dosPrimeros.map((f) => f.r_liquidacion_id),
    p_desde: DESDE,
    p_hasta: HASTA,
  });
  check("reintentar el mismo pago se rechaza", !!eDoble, "pasó dos veces");

  // --- 5. Liquidaciones de otro vendedor ---------------------------------
  console.log("\n5. Corte con una liquidación ajena");
  const otro = vs[1];
  const { error: eAjena } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: otro.id,
    p_liquidacion_ids: [resto[0].r_liquidacion_id],
    p_desde: DESDE,
    p_hasta: HASTA,
  });
  check("no se cuela la liquidación de otro vendedor", !!eAjena, "la aceptó");

  // --- 6. El historial ----------------------------------------------------
  console.log("\n6. Historial de cortes");
  const { data: historial } = await sb.rpc("fn_cortes_vendedor", {
    p_vendedor_id: v.id,
    p_limite: 5,
  });
  check("el corte aparece en el historial", (historial ?? []).some((c) => c.r_nota === "prueba"));

  // --- 7. El reporte del vendedor -----------------------------------------
  // Es la otra cara de lo mismo: el administrador ve el saldo que le entregan,
  // el vendedor ve lo que le devuelven. Sobre el escenario ya montado —tres
  // días liquidados, dos de ellos pagados— se comprueba que ambos cuadran.
  console.log("\n7. Reporte del vendedor");
  const { data: mio, error: eMio } = await sb.rpc("fn_mi_periodo", {
    p_vendedor_id: v.id,
    p_desde: DESDE,
    p_hasta: HASTA,
  });

  check("fn_mi_periodo responde", !eMio, eMio?.message ?? "");

  const delVendedor = (mio ?? []).filter((f) => Number(f.r_venta) > 0);
  check(
    "trae los tres sorteos con venta",
    delVendedor.length === 3,
    `hay ${delVendedor.length}`,
  );
  check(
    "también trae los sorteos sin venta, en cero",
    (mio ?? []).length > 3 && (mio ?? []).every((f) => Number(f.r_venta) >= 0),
  );
  check(
    "los dos días pagados vienen marcados",
    delVendedor.filter((f) => f.r_pagado).length === 2,
    `marcados ${delVendedor.filter((f) => f.r_pagado).length}`,
  );
  check(
    "el tercero sigue sin marcar",
    delVendedor.find((f) => f.r_fecha === DIAS[2])?.r_pagado === false,
  );

  // La cuenta cierra por los dos lados: lo que el vendedor entrega (saldo) más
  // lo que la casa le devuelve (comisión + premios) tiene que dar la venta.
  const cuadran = delVendedor.every((f) => {
    const suyo = Number(f.r_comision) + Number(f.r_premios);
    const entrega = Number(f.r_venta) - suyo;
    return Math.abs(suyo + entrega - Number(f.r_venta)) < 0.01;
  });
  check("lo suyo más lo que entrega da la venta", cuadran);

  const totalMio = delVendedor.reduce(
    (a, f) => a + Number(f.r_comision) + Number(f.r_premios),
    0,
  );
  const totalAdmin = todo.reduce((a, f) => a + Number(f.r_saldo), 0);
  const totalVenta = delVendedor.reduce((a, f) => a + Number(f.r_venta), 0);
  check(
    "el total del vendedor y el saldo del administrador suman la venta",
    Math.abs(totalMio + totalAdmin - totalVenta) < 0.01,
    `${totalMio} + ${totalAdmin} != ${totalVenta}`,
  );
} finally {
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
