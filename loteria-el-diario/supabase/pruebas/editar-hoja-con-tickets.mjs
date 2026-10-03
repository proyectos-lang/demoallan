/**
 * Editar la venta en la hoja de liquidación AUNQUE el vendedor tenga tickets.
 *
 * Hasta la 0106, fn_editar_liquidacion_manual rechazaba un sorteo con tickets
 * de números. Desde la 0131 ya no: la captura por totales que escribe la hoja
 * REEMPLAZA esos tickets (el recálculo los ignora mientras la captura viva).
 * Los tickets no se borran; si la captura se anula, vuelven a contar.
 *
 * Qué se comprueba:
 *   · un sorteo con tickets se puede editar a mano desde la hoja (no rechaza);
 *   · la liquidación pasa a ser la del total manual, no la suma;
 *   · el detalle del vendedor (fn_mi_periodo) refleja el total, no los tickets;
 *   · los tickets siguen guardados; al anular la captura, vuelven a contar.
 *
 *     node supabase/pruebas/editar-hoja-con-tickets.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { db:{schema:"public"}, auth:{persistSession:false} });

const FECHA = "2096-02-13";
const COD = "V-971";
const GANADOR = 25;
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
    const { data: tks } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of tks ?? []) { await sb.from("linea").delete().eq("ticket_id", t.id); }
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  if (v) {
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

const liqDe = async (sid, vid) =>
  (await sb.from("liquidacion").select("venta, comision, premios")
    .eq("sorteo_id", sid).eq("vendedor_id", vid).maybeSingle()).data;

try {
  await limpiar();
  const { data: admin } = await sb.from("usuario").select("id").eq("rol","administrador").limit(1).single();
  const { data: nv } = await sb.from("vendedor").insert({ codigo: COD, nombre:"REPRO EDITAR HOJA", ciudad:"Choloma", zona:"p", color:"#4f46e5", activo:true }).select("id").single();
  const vid = nv.id;
  await sb.from("parametro_vendedor").insert({ vendedor_id: vid, comision:0.10, factor_pago:70, tope_por_numero:99999 });
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA).order("hora");
  const sid = sorteos[0].id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sid, p_limite_por_numero: 99999 });

  // El vendedor vende por TICKETS: 300 al 25 (ganador) y 200 al 7. Venta 500.
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sid, p_vendedor_id: vid,
    p_tickets: [[{ numero: GANADOR, monto: 300 }, { numero: 7, monto: 200 }]],
    p_forzar: true,
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sid });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sid, p_numero_ganador: GANADOR });

  console.log("--- Antes de editar: la venta es la de los tickets ---");
  let lq = await liqDe(sid, vid);
  check("venta por tickets = 500", cent(lq?.venta) === cent(500), `${lq?.venta}`);
  // premio = 300 * 70 = 21000; comisión = 500 * 0.10 = 50.
  check("premios por el ticket ganador = 21000", cent(lq?.premios) === cent(21000), `${lq?.premios}`);

  // La liquidación del vendedor, para editarla desde la hoja.
  const { data: liq } = await sb.from("liquidacion").select("id").eq("sorteo_id", sid).eq("vendedor_id", vid).single();

  console.log("\n--- Editar a mano desde la hoja: ya NO rechaza, y reemplaza ---");
  const { data: edit, error: eEdit } = await sb.rpc("fn_editar_liquidacion_manual", {
    p_liquidacion_id: liq.id, p_venta: 800, p_premios: 0, p_usuario_id: admin.id,
  });
  check("NO rechaza aunque haya tickets", !eEdit, eEdit?.message ?? "");

  lq = await liqDe(sid, vid);
  check("la venta pasa a ser SOLO el total manual (800)", cent(lq?.venta) === cent(800), `${lq?.venta}`);
  check("la comisión es la del total (800 * 10% = 80)", cent(lq?.comision) === cent(80), `${lq?.comision}`);
  check("los premios pasan a ser los del total (0): el ticket ganador ya no cuenta",
        cent(lq?.premios) === 0, `${lq?.premios}`);

  // El detalle del vendedor también refleja el total, no los tickets.
  const { data: mp } = await sb.rpc("fn_mi_periodo", { p_vendedor_id: vid, p_desde: FECHA, p_hasta: FECHA });
  const fila = (mp ?? []).find((r) => r.r_hora === sorteos[0].hora) ?? {};
  check("mi-periodo: venta = 800 (el total)", cent(fila.r_venta) === cent(800), `${fila.r_venta}`);
  check("mi-periodo: premiado = 0 (el total no acertó)", cent(fila.r_premiado) === 0, `${fila.r_premiado}`);

  // Los tickets siguen guardados (no se borraron).
  const { data: tks } = await sb.from("ticket").select("id").eq("sorteo_id", sid).eq("vendedor_id", vid).is("anulado_en", null);
  check("los tickets siguen guardados, no se borraron", (tks ?? []).length === 1, `${(tks ?? []).length}`);

  console.log("\n--- Reversible: al anular la captura, los tickets vuelven a contar ---");
  const { data: vt } = await sb.from("venta_total").select("id").eq("sorteo_id", sid).eq("vendedor_id", vid).is("anulado_en", null).single();
  await sb.rpc("fn_anular_venta_total", { p_id: vt.id });
  lq = await liqDe(sid, vid);
  check("anulado el total, la venta vuelve a los tickets (500)", cent(lq?.venta) === cent(500), `${lq?.venta}`);
  check("y el premio del ticket ganador vuelve (21000)", cent(lq?.premios) === cent(21000), `${lq?.premios}`);

} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  await limpiar();
}
console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
