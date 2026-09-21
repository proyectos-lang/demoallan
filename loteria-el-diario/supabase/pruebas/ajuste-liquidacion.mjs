/**
 * Corregir un sorteo YA PAGADO no reabre la liquidación: deja un ajuste.
 *
 * Decisión del gerente: las liquidaciones hechas son inmutables. Si se corrige
 * un sorteo ya pagado, la liquidación y el corte NO se tocan; la diferencia
 * queda como un saldo pendiente por liquidar (a favor o en contra).
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · la liquidación pagada NO cambia y sigue en su corte (no se desliga);
 *   · la diferencia aparece como ajuste vivo, con su signo;
 *   · la deuda del vendedor incluye el ajuste;
 *   · una segunda corrección acumula sobre el mismo ajuste (no crea otro);
 *   · al liquidar, el ajuste se salda y deja de sumar.
 *
 * Monta su propio vendedor/sorteo en fechas lejanas y limpia al terminar.
 *
 *     node supabase/pruebas/ajuste-liquidacion.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" }, auth: { persistSession: false },
});

const FECHA = "2099-06-13";
const GANADOR = 33;
const COD = "V-967";
let ok = 0, fallos = 0;
const check = (n, c, d = "") => { if (c) { ok++; console.log(`  ok    ${n}`); } else { fallos++; console.log(`  FALLA ${n} ${d}`); } };
const cent = (v) => Math.round(Number(v ?? 0) * 100);

const limpiar = async () => {
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", COD).maybeSingle();
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: lqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const lq of lqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", lq.id);
    await sb.from("ajuste_liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  if (v) {
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

const liqDe = async (sid, vid) => (await sb.from("liquidacion").select("id, venta, comision, premios, utilidad").eq("sorteo_id", sid).eq("vendedor_id", vid).maybeSingle()).data;
const ajusteVivo = async (vid) => (await sb.rpc("fn_ajuste_pendiente", { p_vendedor_id: vid })).data;
const pendiente = async (vid) => Number((await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: vid })).data?.[0]?.r_pendiente ?? 0);

try {
  await limpiar();
  console.log("\n1. Montaje");
  const { data: admin } = await sb.from("usuario").select("id").eq("rol", "administrador").limit(1).single();
  const { data: nv } = await sb.from("vendedor").insert({ codigo: COD, nombre: "REPRO AJUSTE", ciudad: "Choloma", zona: "p", color: "#4f46e5", activo: true }).select("id").single();
  const vid = nv.id;
  await sb.from("parametro_vendedor").insert({ vendedor_id: vid, comision: 0.15, factor_pago: 70, tope_por_numero: 99999 });
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sid = sorteos.find((s) => s.hora === "11:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sid, p_limite_por_numero: 999999 });

  // Captura por totales, liquidar, pagar.
  await sb.rpc("fn_registrar_venta_total", { p_sorteo_id: sid, p_vendedor_id: vid, p_venta: 1000, p_premios: 0, p_usuario_id: admin.id });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sid });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sid, p_numero_ganador: GANADOR });
  const l0 = await liqDe(sid, vid);
  const util0 = Number(l0.utilidad);
  await sb.rpc("fn_registrar_corte", { p_vendedor_id: vid, p_liquidacion_ids: [l0.id], p_desde: FECHA, p_hasta: FECHA, p_usuario_id: admin.id });
  check("el sorteo quedó pagado (en corte_detalle)", ((await sb.from("corte_detalle").select("liquidacion_id").eq("liquidacion_id", l0.id)).data ?? []).length === 1);
  check("no hay ajuste todavía", cent(await ajusteVivo(vid)) === 0);

  // --- Corregir el sorteo ya pagado: subir la venta ----------------------
  console.log("\n2. Corregir venta 1000 -> 1500 (sorteo ya pagado)");
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: l0.id, p_venta: 1500, p_premios: 0 });

  const l1 = await liqDe(sid, vid);
  check("la liquidación NO cambió (sigue con su valor pagado)", cent(l1.venta) === cent(1000) && cent(l1.utilidad) === cent(util0), `venta ${l1.venta}`);
  check("la liquidación SIGUE en el corte (no se desligó)", ((await sb.from("corte_detalle").select("liquidacion_id").eq("liquidacion_id", l0.id)).data ?? []).length === 1);

  // nuevo util = 1500 - 1500*0.15 - 0 = 1275; viejo = 850; diferencia = 425
  const nuevoUtil = 1500 - 1500 * 0.15;
  const dif = nuevoUtil - util0;
  check("apareció un ajuste vivo = la diferencia", cent(await ajusteVivo(vid)) === cent(dif), `ajuste ${await ajusteVivo(vid)}, esperaba ${dif}`);
  check("la deuda del vendedor incluye el ajuste", cent(await pendiente(vid)) === cent(dif), `pendiente ${await pendiente(vid)}`);

  // --- Segunda corrección: acumula, no crea otro -------------------------
  console.log("\n3. Segunda corrección 1500 -> 1200: acumula sobre el mismo ajuste");
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: l0.id, p_venta: 1200, p_premios: 0 });
  const { data: filas } = await sb.from("ajuste_liquidacion").select("id, monto").eq("sorteo_id", sid).eq("vendedor_id", vid).is("saldado_corte_id", null);
  check("sigue habiendo UN solo ajuste vivo", (filas ?? []).length === 1, `${(filas ?? []).length} filas`);
  const nuevoUtil2 = 1200 - 1200 * 0.15;
  check("el ajuste refleja la nueva diferencia", cent(filas[0].monto) === cent(nuevoUtil2 - util0), `da ${filas[0].monto}`);

  // --- Bajar por debajo de lo pagado: ajuste NEGATIVO --------------------
  console.log("\n4. Corregir a 500: el ajuste queda a favor del vendedor (negativo)");
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: l0.id, p_venta: 500, p_premios: 0 });
  const nuevoUtil3 = 500 - 500 * 0.15;
  check("el ajuste es negativo (a favor)", cent(await ajusteVivo(vid)) === cent(nuevoUtil3 - util0) && (nuevoUtil3 - util0) < 0, `da ${await ajusteVivo(vid)}`);

  // --- Volver al valor pagado: el ajuste desaparece ----------------------
  console.log("\n5. Volver a 1000: el ajuste se retira");
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: l0.id, p_venta: 1000, p_premios: 0 });
  check("sin diferencia, no queda ajuste", cent(await ajusteVivo(vid)) === 0, `da ${await ajusteVivo(vid)}`);

  // --- Un ajuste vivo se salda al liquidar -------------------------------
  console.log("\n6. Un ajuste vivo se salda con un corte");
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: l0.id, p_venta: 1500, p_premios: 0 });
  check("hay ajuste vivo otra vez", cent(await ajusteVivo(vid)) !== 0);
  // insertar un ajuste requiere un corte para saldarlo: se hace un corte del arrastre... pero el ajuste no está atado a una liquidacion nueva.
  // Se registra un corte con la MISMA liquidación no se puede (ya pagada). Se usa un abono/corte de cobranza: aquí basta simular el saldado marcando por corte.
  // Creamos un corte vacío no es posible; en su lugar registramos un abono que absorbe, luego un corte. Simplificación: marcamos con un corte real de otra liquidación.
  // Para la prueba, saldamos vía fn_registrar_corte de una NUEVA liquidación pendiente:
  const s2 = sorteos.find((s) => s.hora === "15:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s2, p_limite_por_numero: 999999 });
  await sb.rpc("fn_registrar_venta_total", { p_sorteo_id: s2, p_vendedor_id: vid, p_venta: 300, p_premios: 0, p_usuario_id: admin.id });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s2 });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s2, p_numero_ganador: 99 });
  const l2 = await liqDe(s2, vid);
  await sb.rpc("fn_registrar_corte", { p_vendedor_id: vid, p_liquidacion_ids: [l2.id], p_desde: FECHA, p_hasta: FECHA, p_usuario_id: admin.id });
  check("tras el corte, el ajuste quedó saldado (ya no suma)", cent(await ajusteVivo(vid)) === 0, `da ${await ajusteVivo(vid)}`);
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  console.log("\n7. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
