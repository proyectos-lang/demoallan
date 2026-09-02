/**
 * Ciclo automático de sorteos y consulta pública.
 *
 * Lo que se pone a prueba:
 *   1. Que el ciclo sea IDEMPOTENTE: corre cada cinco minutos, así que hacer
 *      algo dos veces sería duplicar cupos o reabrir lo cerrado.
 *   2. Que cierre lo vencido y abra lo vigente, y nada más.
 *   3. Que la superficie pública no exponga más de fecha, hora y número.
 *
 *     PW=<clave-admin> node supabase/pruebas/ciclo.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const U = env.NEXT_PUBLIC_SUPABASE_URL;
const sb = createClient(U, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});
const anon = createClient(U, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const hoyHn = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());

let sorteoPrueba = null;
let vendedorPrueba = null;

// Restos de una corrida interrumpida. Si quedaran, el sorteo de 2099 seguiría
// roto y la sección 7 mediría una reparación que ya ocurrió.
{
  const { data: viejos } = await sb.from("sorteo").select("id").eq("fecha", "2099-06-15");
  for (const s of viejos ?? []) {
    const { data: tk } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of tk ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  const { data: vv } = await sb.from("vendedor").select("id").eq("codigo", "V-903");
  for (const x of vv ?? []) {
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", x.id);
    await sb.from("vendedor").delete().eq("id", x.id);
  }
}

try {
  console.log("\n1. Límites por franja");
  const { data: limites, error: eLim } = await sb
    .from("limite_franja").select("hora, limite_casa").order("hora");
  check("la tabla existe y trae las tres franjas", !eLim && limites?.length === 3, eLim?.message);
  if (limites) {
    console.log("   " + limites.map((l) => `${l.hora}: L ${l.limite_casa}`).join(" · "));
    check(
      "la noche tiene más límite que la mañana (§13)",
      Number(limites.find((l) => l.hora === "20:00").limite_casa) >
        Number(limites.find((l) => l.hora === "11:00").limite_casa),
    );
  }

  console.log("\n2. El ciclo corre");
  const { data: primera, error: eCiclo } = await sb.rpc("fn_ciclo_sorteos");
  check("fn_ciclo_sorteos responde", !eCiclo, eCiclo?.message);
  if (primera?.length) {
    for (const a of primera) console.log(`   ${a.accion} ${a.fecha} ${a.hora}`);
  } else {
    console.log("   (sin acciones: el estado ya era el correcto)");
  }

  const hoy = hoyHn();
  const manana = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" })
    .format(new Date(Date.now() + 86_400_000));

  const { data: sorteosHoy } = await sb
    .from("sorteo").select("hora, estado, hora_cierre").eq("fecha", hoy).order("hora");
  const { data: sorteosManana } = await sb
    .from("sorteo").select("hora, estado").eq("fecha", manana).order("hora");

  check("programa los tres sorteos de hoy", sorteosHoy?.length === 3, `${sorteosHoy?.length}`);
  check("y adelanta los de mañana", sorteosManana?.length === 3, `${sorteosManana?.length}`);

  console.log("   hoy:    " + (sorteosHoy ?? []).map((s) => `${s.hora}/${s.estado}`).join("  "));
  console.log("   mañana: " + (sorteosManana ?? []).map((s) => `${s.hora}/${s.estado}`).join("  "));

  console.log("\n3. Coherencia entre estado y hora");
  const ahora = new Date();
  const vencidosAbiertos = (sorteosHoy ?? []).filter(
    (s) => s.estado === "abierto" && new Date(s.hora_cierre) <= ahora,
  );
  check("ningún sorteo abierto con la venta ya vencida", vencidosAbiertos.length === 0,
    JSON.stringify(vencidosAbiertos));

  const vigentesSinAbrir = (sorteosHoy ?? []).filter(
    (s) => s.estado === "programado" && new Date(s.hora_cierre) > ahora,
  );
  check("ningún sorteo vigente sin abrir", vigentesSinAbrir.length === 0,
    JSON.stringify(vigentesSinAbrir));

  console.log("\n4. Idempotencia: correrlo otra vez no debe cambiar nada");
  const antes = JSON.stringify(
    (await sb.from("sorteo").select("fecha, hora, estado").order("fecha").order("hora")).data,
  );
  const { data: cuposAntes } = await sb.from("cupo_numero").select("sorteo_id, numero, limite_casa");

  const { data: segunda, error: eSeg } = await sb.rpc("fn_ciclo_sorteos");
  check("la segunda pasada no falla", !eSeg, eSeg?.message);
  check("y no hace nada", (segunda ?? []).length === 0,
    JSON.stringify(segunda));

  const despues = JSON.stringify(
    (await sb.from("sorteo").select("fecha, hora, estado").order("fecha").order("hora")).data,
  );
  const { data: cuposDespues } = await sb.from("cupo_numero").select("sorteo_id, numero");

  check("los estados no cambiaron", antes === despues);
  check("no duplicó filas de cupo", (cuposAntes ?? []).length === (cuposDespues ?? []).length,
    `${cuposAntes?.length} vs ${cuposDespues?.length}`);

  console.log("\n5. Cupo sembrado en lo que abrió");
  const { data: abiertos } = await sb.from("sorteo").select("id, hora").eq("estado", "abierto");
  for (const s of abiertos ?? []) {
    const { data: c } = await sb.from("cupo_numero").select("numero, limite_casa").eq("sorteo_id", s.id);
    const limite = limites?.find((l) => l.hora === s.hora)?.limite_casa;
    check(`${s.hora}: 100 números sembrados`, (c ?? []).length === 100, `${c?.length}`);
    check(`${s.hora}: con el límite de su franja (L ${limite})`,
      (c ?? []).every((x) => Number(x.limite_casa) === Number(limite)));
  }

  console.log("\n6. La superficie pública");
  const { data: publicos, error: ePub } = await anon
    .from("v_resultado_publico").select("*").limit(50);
  check("anon puede leer la vista", !ePub, ePub?.message);
  check(
    "sólo expone fecha, hora y numero_ganador",
    (publicos ?? []).every((r) => Object.keys(r).sort().join(",") === "fecha,hora,numero_ganador"),
    JSON.stringify(publicos?.[0]),
  );

  const { error: eSorteo } = await anon.from("sorteo").select("id").limit(1);
  check("anon NO puede leer la tabla sorteo", !!eSorteo, "sin error");

  const { error: eCiclo2 } = await anon.rpc("fn_ciclo_sorteos");
  check("anon NO puede disparar el ciclo", !!eCiclo2, "sin error");

  const { data: sinLiquidar } = await sb
    .from("sorteo").select("fecha, hora").neq("estado", "liquidado").limit(5);
  const publicosSet = new Set((publicos ?? []).map((r) => `${r.fecha} ${r.hora}`));
  check(
    "ningún sorteo sin liquidar aparece en público",
    (sinLiquidar ?? []).every((s) => !publicosSet.has(`${s.fecha} ${s.hora}`)),
  );

  // -------------------------------------------------------------------------
  console.log("\n7. Reparación de cupo faltante");
  // Un sorteo `abierto` sin filas de cupo rechaza TODA venta. `fn_abrir_sorteo`
  // no lo arregla porque sólo mira los `programado`, así que el ciclo tiene que
  // detectarlo. Y al reponerlo no puede poner `vendido` en cero: eso regalaría
  // cupo ya consumido y abriría la puerta a sobrevender.
  //
  // Se monta sobre un sorteo de 2099 para no tocar la operación real. El ciclo
  // no lo abrirá ni lo cerrará (sólo actúa hasta mañana), pero sí lo repara:
  // la reparación no discrimina por fecha, porque un sorteo roto lo está
  // independientemente de cuándo se juegue.
  const { data: vend } = await sb.from("vendedor").insert({
    codigo: "V-903", nombre: "Prueba Ciclo", ciudad: "San Pedro Sula",
    zona: "SPS · Prueba", color: "#2563eb",
  }).select("id").single();
  vendedorPrueba = vend?.id;
  await sb.rpc("fn_guardar_parametros", {
    p_vendedor_id: vendedorPrueba, p_comision: 0.125,
    p_factor_pago: 70, p_tope_por_numero: 1000,
  });

  const { data: sPrueba } = await sb.from("sorteo").insert({
    fecha: "2099-06-15", hora: "20:00",
    hora_cierre: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
  }).select("id").single();
  sorteoPrueba = sPrueba?.id;

  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoPrueba, p_limite_por_numero: 7000 });
  const { error: eVenta } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoPrueba, p_vendedor_id: vendedorPrueba,
    p_lineas: [{ numero: 47, monto: 300 }, { numero: 47, monto: 150 }],
  });
  check("venta previa registrada", !eVenta, eVenta?.message);

  // El destrozo: se borra el cupo del número que tiene ventas y el de dos que
  // no. Es exactamente el estado en que quedaron los sorteos reales.
  await sb.from("cupo_numero").delete().eq("sorteo_id", sorteoPrueba).in("numero", [47, 48, 49]);
  const { data: rotas } = await sb.from("cupo_numero").select("numero").eq("sorteo_id", sorteoPrueba);
  check("el sorteo queda con 97 números", (rotas ?? []).length === 97, `${rotas?.length}`);

  const { error: eVentaRota } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoPrueba, p_vendedor_id: vendedorPrueba,
    p_lineas: [{ numero: 47, monto: 50 }],
  });
  check("y en ese estado no admite venta", !!eVentaRota, "la venta pasó");

  const { data: tercera, error: eTer } = await sb.rpc("fn_ciclo_sorteos");
  check("el ciclo corre sobre el sorteo roto", !eTer, eTer?.message);
  check(
    "y reporta la reparación",
    (tercera ?? []).some((a) => a.accion === "reparar_cupo" && a.fecha === "2099-06-15"),
    JSON.stringify(tercera),
  );

  const { data: reparadas } = await sb
    .from("cupo_numero").select("numero, limite_casa, vendido").eq("sorteo_id", sorteoPrueba);
  check("repone los 100 números", (reparadas ?? []).length === 100, `${reparadas?.length}`);

  const n47 = (reparadas ?? []).find((c) => c.numero === 47);
  const n48 = (reparadas ?? []).find((c) => c.numero === 48);
  check(
    "reconstruye lo vendido desde las líneas (47 → L 450)",
    Number(n47?.vendido) === 450,
    `vendido=${n47?.vendido}`,
  );
  check("y deja en cero el número sin ventas (48)", Number(n48?.vendido) === 0, `${n48?.vendido}`);
  check("con el límite de la franja de las 20:00", Number(n47?.limite_casa) === 7000, `${n47?.limite_casa}`);

  const { error: eVentaSana } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoPrueba, p_vendedor_id: vendedorPrueba,
    p_lineas: [{ numero: 47, monto: 50 }],
  });
  check("el sorteo vuelve a admitir venta", !eVentaSana, eVentaSana?.message);

  // El tope del vendedor es 1000 y ya lleva 500 en el 47: si la reparación
  // hubiera puesto `vendido` en cero, esta venta de 600 pasaría.
  const { error: eTope } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoPrueba, p_vendedor_id: vendedorPrueba,
    p_lineas: [{ numero: 47, monto: 600 }],
  });
  check("y el cupo reconstruido sigue frenando el exceso", !!eTope, "la venta pasó");

  const { data: cuarta } = await sb.rpc("fn_ciclo_sorteos");
  check(
    "la reparación no se repite en la pasada siguiente",
    !(cuarta ?? []).some((a) => a.accion === "reparar_cupo"),
    JSON.stringify(cuarta),
  );
} finally {
  // Los sorteos del día son los reales y no se tocan. Lo único que se retira es
  // el escenario de 2099 montado para la prueba de reparación.
  if (sorteoPrueba) {
    const { data: tk } = await sb.from("ticket").select("id").eq("sorteo_id", sorteoPrueba);
    for (const t of tk ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", sorteoPrueba);
    await sb.from("cupo_numero").delete().eq("sorteo_id", sorteoPrueba);
    await sb.from("sorteo").delete().eq("id", sorteoPrueba);
  }
  if (vendedorPrueba) {
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", vendedorPrueba);
    await sb.from("vendedor").delete().eq("id", vendedorPrueba);
  }
  console.log("\n(los sorteos del día no se tocan: son los reales)");
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
