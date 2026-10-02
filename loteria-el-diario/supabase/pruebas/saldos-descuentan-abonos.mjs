/**
 * Las pantallas de cobro descuentan los abonos a cuenta.
 *
 * Antes de la 0130, un abono bajaba el pendiente en fn_deuda_vendedor pero NO
 * el «acumulado» de la hoja (fn_liquidacion_por_semana) ni el «saldo actual» de
 * la tabla de saldos (fn_saldos_por_vendedor). El usuario registraba abonos y
 * no veía diferencia. Esta prueba comprueba que ahora sí bajan, que el abono se
 * reporta aparte (r_abonado), y que una semana pasada no se toca.
 *
 *     node supabase/pruebas/saldos-descuentan-abonos.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { db:{schema:"public"}, auth:{persistSession:false} });

// Dos semanas: una "pasada" y la vigente (la más reciente con ventas del vendedor).
const SEM_PASADA = "2097-03-11";   // lunes
const SEM_VIGENTE = "2097-03-18";  // lunes siguiente
const COD = "V-970";
let ok = 0, fallos = 0;
const check = (n, c, d = "") => { if (c) { ok++; console.log(`  ok    ${n}`); } else { fallos++; console.log(`  FALLA ${n} ${d}`); } };
const cent = (v) => Math.round(Number(v ?? 0) * 100);

const limpiar = async () => {
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", COD).maybeSingle();
  for (const F of [SEM_PASADA, SEM_VIGENTE]) {
    for (let d = 0; d < 7; d++) {
      const fecha = new Date(F); fecha.setDate(fecha.getDate() + d);
      const iso = fecha.toISOString().slice(0, 10);
      const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", iso);
      for (const s of sorteos ?? []) {
        const { data: lqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
        for (const lq of lqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", lq.id);
        await sb.from("ajuste_liquidacion").delete().eq("sorteo_id", s.id);
        await sb.from("venta_total").delete().eq("sorteo_id", s.id);
        await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
        await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
        await sb.from("sorteo").delete().eq("id", s.id);
      }
    }
  }
  if (v) {
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

const vender = async (vid, admin, lunes, monto) => {
  await sb.rpc("fn_programar_dia", { p_fecha: lunes });
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", lunes).order("hora");
  const sid = sorteos[0].id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sid, p_limite_por_numero: 99999 });
  await sb.rpc("fn_registrar_venta_total", { p_sorteo_id: sid, p_vendedor_id: vid, p_venta: monto, p_premios: 0, p_usuario_id: admin });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sid });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sid, p_numero_ganador: 12 });
};

const hoja = async (vid, lunes) => {
  const { data } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: vid });
  const f = (data ?? []).find((r) => r.r_inicio === lunes) ?? {};
  return { arrastre:+f.r_arrastre||0, abonado:+f.r_abonado||0, acumulado:+f.r_acumulado||0, pendiente:+f.r_pendiente||0 };
};
const saldos = async (vid, lunes) => {
  const fin = new Date(lunes); fin.setDate(fin.getDate() + 6);
  const { data } = await sb.rpc("fn_saldos_por_vendedor", { p_desde: lunes, p_hasta: fin.toISOString().slice(0,10) });
  const f = (data ?? []).find((r) => r.r_vendedor_id === vid) ?? {};
  return { anterior:+f.r_anterior||0, abonado:+f.r_abonado||0, actual:+f.r_actual||0 };
};

try {
  await limpiar();
  const { data: admin } = await sb.from("usuario").select("id").eq("rol","administrador").limit(1).single();
  const { data: nv } = await sb.from("vendedor").insert({ codigo: COD, nombre:"REPRO SALDOS ABONOS", ciudad:"Choloma", zona:"p", color:"#4f46e5", activo:true }).select("id").single();
  const vid = nv.id;
  await sb.from("parametro_vendedor").insert({ vendedor_id: vid, comision:0.10, factor_pago:70, tope_por_numero:99999 });

  // Semana pasada: vende 3000 (saldo 2700, sin cerrar). Semana vigente: vende 5000 (saldo 4500).
  await vender(vid, admin.id, SEM_PASADA, 3000);
  await vender(vid, admin.id, SEM_VIGENTE, 5000);

  console.log("--- Antes del abono ---");
  let hv = await hoja(vid, SEM_VIGENTE), sv = await saldos(vid, SEM_VIGENTE);
  check("hoja vigente: arrastre 2700", cent(hv.arrastre) === cent(2700), `${hv.arrastre}`);
  check("hoja vigente: acumulado 7200", cent(hv.acumulado) === cent(7200), `${hv.acumulado}`);
  check("saldos vigente: actual 7200", cent(sv.actual) === cent(7200), `${sv.actual}`);

  // Abono parcial de 2000.
  const { error } = await sb.rpc("fn_registrar_abono", { p_vendedor_id: vid, p_monto: 2000, p_fecha_pago: null, p_nota: "parcial", p_usuario_id: admin.id });
  check("el abono de 2000 entra", !error, error?.message ?? "");

  console.log("\n--- Después del abono ---");
  hv = await hoja(vid, SEM_VIGENTE); sv = await saldos(vid, SEM_VIGENTE);
  check("hoja vigente: reporta abonado 2000", cent(hv.abonado) === cent(2000), `${hv.abonado}`);
  check("hoja vigente: ACUMULADO baja a 5200", cent(hv.acumulado) === cent(5200), `${hv.acumulado}`);
  check("hoja vigente: arrastre NO cambia (sigue 2700)", cent(hv.arrastre) === cent(2700), `${hv.arrastre}`);
  check("saldos vigente: reporta abonado 2000", cent(sv.abonado) === cent(2000), `${sv.abonado}`);
  check("saldos vigente: ACTUAL baja a 5200", cent(sv.actual) === cent(5200), `${sv.actual}`);

  console.log("\n--- La semana pasada NO se toca ---");
  const hp = await hoja(vid, SEM_PASADA), sp = await saldos(vid, SEM_PASADA);
  check("hoja pasada: acumulado sigue 2700 (sin restar el abono de hoy)", cent(hp.acumulado) === cent(2700), `${hp.acumulado}`);
  check("saldos pasada: actual sigue 2700", cent(sp.actual) === cent(2700), `${sp.actual}`);

  console.log("\n--- Cuadra con fn_deuda_vendedor ---");
  const dv = (await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: vid })).data?.[0] ?? {};
  check("deuda.pendiente = acumulado vigente (5200)", cent(dv.r_pendiente) === cent(5200), `${dv.r_pendiente}`);

} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  await limpiar();
}
console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
