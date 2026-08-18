/**
 * Impacto económico y liquidación, con las cuentas hechas a mano.
 *
 * El punto de la prueba es que las cifras que la pantalla enseña ANTES de
 * liquidar coincidan exactamente con lo que la liquidación acaba escribiendo.
 * Si la vista previa y el resultado discrepan, alguien capturó un número
 * confiando en un número que no era.
 *
 *     node supabase/pruebas/liquidacion.mjs
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
  db: { schema: "allan" },
  auth: { persistSession: false },
});

const FECHA = "2097-05-05";
const GANADOR = 42;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const limpiar = async () => {
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
};

try {
  await limpiar();

  // --- Montaje -----------------------------------------------------------
  console.log("\n1. Montaje");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sorteoId = sorteos.find((s) => s.hora === "20:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: 50000 });

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");

  const param = (v) => (Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor);
  const v1 = vs[0], v2 = vs[1];
  const p1 = param(v1), p2 = param(v2);

  // Dos vendedores, con comisión y factor distintos. El número ganador lo
  // juegan los dos; hay además un número que no sale.
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId, p_vendedor_id: v1.id,
    p_lineas: [{ numero: GANADOR, monto: 100 }, { numero: 7, monto: 200 }],
  });
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId, p_vendedor_id: v2.id,
    p_lineas: [{ numero: GANADOR, monto: 50 }],
  });

  // Cuentas a mano, con el factor y la comisión de cada vendedor.
  const ventaEsperada = 100 + 200 + 50;
  const comisionEsperada = (100 + 200) * Number(p1.comision) + 50 * Number(p2.comision);
  const pagoEsperado = 100 * Number(p1.factor_pago) + 50 * Number(p2.factor_pago);
  const utilidadEsperada = ventaEsperada - comisionEsperada - pagoEsperado;

  console.log(`   venta ${ventaEsperada} · comisión ${comisionEsperada.toFixed(2)} · pago si sale ${GANADOR}: ${pagoEsperado}`);

  // --- Vista previa ------------------------------------------------------
  console.log("\n2. Revisión de impacto (antes de liquidar)");
  const { data: imp, error: eImp } = await sb.rpc("fn_impacto_numero", {
    p_sorteo_id: sorteoId, p_numero: GANADOR,
  });
  if (eImp) throw new Error(eImp.message);
  const i = imp[0];

  check("venta", Number(i.venta) === ventaEsperada, `${i.venta}`);
  check("comisión con los factores de cada vendedor", Math.abs(Number(i.comision) - comisionEsperada) < 0.01, `${i.comision}`);
  check("tickets", Number(i.tickets) === 2, `${i.tickets}`);
  check("líneas ganadoras", Number(i.lineas_ganadoras) === 2, `${i.lineas_ganadoras}`);
  check("pago potencial", Number(i.pago) === pagoEsperado, `${i.pago}`);
  check("utilidad proyectada", Math.abs(Number(i.utilidad) - utilidadEsperada) < 0.01, `${i.utilidad}`);

  const { data: sinNumero } = await sb.rpc("fn_impacto_numero", { p_sorteo_id: sorteoId });
  check("sin número: no inventa premios", Number(sinNumero[0].pago) === 0 && Number(sinNumero[0].lineas_ganadoras) === 0);

  // --- Peor escenario ----------------------------------------------------
  console.log("\n3. Peor escenario");
  const { data: peor, error: ePeor } = await sb.rpc("fn_peor_escenario", { p_sorteo_id: sorteoId });
  if (ePeor) throw new Error(ePeor.message);
  // El 7 lleva 200 al factor de v1; el 42 lleva 100×f1 + 50×f2.
  const pago7 = 200 * Number(p1.factor_pago);
  const esperadoPeor = pago7 >= pagoEsperado ? { n: 7, pago: pago7 } : { n: GANADOR, pago: pagoEsperado };
  check(
    `el número más caro es el ${esperadoPeor.n}`,
    Number(peor[0].numero) === esperadoPeor.n && Number(peor[0].pago) === esperadoPeor.pago,
    JSON.stringify(peor[0]),
  );

  // --- Liquidación -------------------------------------------------------
  console.log("\n4. Liquidación");
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteoId });
  const { data: liq, error: eLiq } = await sb.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: sorteoId, p_numero_ganador: GANADOR,
  });
  if (eLiq) throw new Error(eLiq.message);

  check("los premios coinciden con la vista previa", Number(liq[0].total_premios) === pagoEsperado, `${liq[0].total_premios} vs ${pagoEsperado}`);
  check("una liquidación por vendedor", Number(liq[0].total_vendedores) === 2, `${liq[0].total_vendedores}`);

  const { data: filas } = await sb
    .from("liquidacion").select("vendedor_id, venta, comision, premios, utilidad").eq("sorteo_id", sorteoId);

  const f1 = filas.find((f) => f.vendedor_id === v1.id);
  const f2 = filas.find((f) => f.vendedor_id === v2.id);

  check("vendedor 1: venta 300", Number(f1.venta) === 300, `${f1.venta}`);
  check("vendedor 1: premio 100 × su factor", Number(f1.premios) === 100 * Number(p1.factor_pago), `${f1.premios}`);
  check("vendedor 2: premio 50 × su factor", Number(f2.premios) === 50 * Number(p2.factor_pago), `${f2.premios}`);
  check(
    "utilidad = venta − comisión − premios en cada fila",
    filas.every((f) => Math.abs(Number(f.utilidad) - (Number(f.venta) - Number(f.comision) - Number(f.premios))) < 0.01),
    JSON.stringify(filas),
  );
  check(
    "la suma de las filas cuadra con el total",
    Math.abs(filas.reduce((a, f) => a + Number(f.premios), 0) - pagoEsperado) < 0.01,
  );

  const { data: s } = await sb.from("sorteo").select("estado, numero_ganador").eq("id", sorteoId).single();
  check("el sorteo queda liquidado y bloqueado", s.estado === "liquidado" && s.numero_ganador === GANADOR, JSON.stringify(s));

  const { data: lineasGanadoras } = await sb
    .from("linea").select("numero, monto, premio, factor_congelado, gana").eq("gana", true);
  check(
    "el premio de cada línea es monto × su factor congelado, sin recortes",
    lineasGanadoras.every((l) => Math.abs(Number(l.premio) - Number(l.monto) * Number(l.factor_congelado)) < 0.01),
    JSON.stringify(lineasGanadoras),
  );

  // Las líneas del número que no salió no deben tener premio.
  const { data: perdedoras } = await sb.from("linea").select("premio, gana").eq("gana", false);
  check("las líneas que no ganan quedan en cero", perdedoras.every((l) => Number(l.premio) === 0));
} finally {
  console.log("\n5. Limpieza");
  await limpiar();
  await sb.from("auditoria").delete().gt("id", 0);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
