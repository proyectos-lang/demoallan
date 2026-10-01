/**
 * El abono parcial funciona aunque la deuda incluya un ajuste por corrección.
 *
 * EL FALLO QUE VIGILA
 * -------------------
 * La hoja enseña pendiente = deuda − abonado + ajuste (fn_deuda_vendedor, 0116).
 * Antes de la 0129, fn_registrar_abono topaba el abono contra sólo deuda −
 * abonado, SIN el ajuste. En cuanto un vendedor tenía un ajuste vivo —de
 * corregir un sorteo ya pagado— un abono parcial legítimo se rechazaba con
 * «pasa de lo que debe». El usuario final lo reportó como «el abono parcial no
 * hace nada». Esta prueba lo reproduce y comprueba que ya no ocurre.
 *
 * Monta su propio vendedor/sorteos en fecha lejana y limpia al terminar.
 *
 *     node supabase/pruebas/abono-con-ajuste.mjs
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

const FECHA = "2098-05-09";
const COD = "V-968";
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
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

const liqDe = async (sid, vid) =>
  (await sb.from("liquidacion").select("id, venta, comision, premios, utilidad")
    .eq("sorteo_id", sid).eq("vendedor_id", vid).maybeSingle()).data;
const deuda = async (vid) => {
  const f = (await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: vid })).data?.[0] ?? {};
  return { deuda: Number(f.r_deuda ?? 0), abonado: Number(f.r_abonado ?? 0), pendiente: Number(f.r_pendiente ?? 0) };
};
const abonar = (vid, admin, monto) => sb.rpc("fn_registrar_abono", {
  p_vendedor_id: vid, p_monto: monto, p_fecha_pago: null, p_nota: "abono parcial", p_usuario_id: admin,
});

try {
  await limpiar();
  const { data: admin } = await sb.from("usuario").select("id").eq("rol", "administrador").limit(1).single();
  const { data: nv } = await sb.from("vendedor")
    .insert({ codigo: COD, nombre: "REPRO ABONO AJUSTE", ciudad: "Choloma", zona: "p", color: "#4f46e5", activo: true })
    .select("id").single();
  const vid = nv.id;
  await sb.from("parametro_vendedor").insert({ vendedor_id: vid, comision: 0.10, factor_pago: 70, tope_por_numero: 99999 });
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA).order("hora");

  // Sorteo A: vendido, liquidado y PAGADO; luego corregido al alza -> ajuste +900.
  const sA = sorteos[0].id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sA, p_limite_por_numero: 99999 });
  await sb.rpc("fn_registrar_venta_total", { p_sorteo_id: sA, p_vendedor_id: vid, p_venta: 1000, p_premios: 0, p_usuario_id: admin.id });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sA });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sA, p_numero_ganador: 55 });
  const lA = await liqDe(sA, vid);
  await sb.rpc("fn_registrar_corte", { p_vendedor_id: vid, p_liquidacion_ids: [lA.id], p_desde: FECHA, p_hasta: FECHA, p_usuario_id: admin.id });
  await sb.rpc("fn_editar_liquidacion_manual", { p_liquidacion_id: lA.id, p_venta: 2000, p_premios: 0 });

  console.log("--- Escenario 1: la deuda es SÓLO un ajuste (todos los sorteos pagados) ---");
  let d = await deuda(vid);
  check("la hoja dice que debe 900 (de un ajuste por corrección)", cent(d.pendiente) === cent(900), `pendiente ${d.pendiente}`);
  const { data: r1, error: e1 } = await abonar(vid, admin.id, 450);
  check("acepta un abono PARCIAL de 450", !e1, e1?.message ?? "");
  check("y deja 450 pendiente", cent(r1?.[0]?.r_pendiente) === cent(450), String(r1?.[0]?.r_pendiente));
  d = await deuda(vid);
  check("la hoja ya muestra 450 pendiente", cent(d.pendiente) === cent(450), `pendiente ${d.pendiente}`);

  console.log("\n--- Escenario 2: sorteo vivo (900) + ajuste (900) = 1800 ---");
  const sB = sorteos[1].id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sB, p_limite_por_numero: 99999 });
  await sb.rpc("fn_registrar_venta_total", { p_sorteo_id: sB, p_vendedor_id: vid, p_venta: 1000, p_premios: 0, p_usuario_id: admin.id });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sB });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sB, p_numero_ganador: 77 });
  d = await deuda(vid);
  // Ya abonó 450 en el escenario 1: 900 sorteo + 900 ajuste − 450 = 1350.
  check("la hoja dice 1350 pendiente", cent(d.pendiente) === cent(1350), `pendiente ${d.pendiente}`);
  const { data: r2, error: e2 } = await abonar(vid, admin.id, 1000);
  check("acepta un abono PARCIAL de 1000", !e2, e2?.message ?? "");
  check("y deja 350 pendiente", cent(r2?.[0]?.r_pendiente) === cent(350), String(r2?.[0]?.r_pendiente));

  console.log("\n--- Lo que SÍ se sigue rechazando ---");
  const { error: ePasa } = await abonar(vid, admin.id, 1000);
  check("un abono que pasa del pendiente (350) se rechaza", !!ePasa, ePasa ? "" : "lo aceptó y no debía");

} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  await limpiar();
}
console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
