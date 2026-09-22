/**
 * El folio lleva la franja del sorteo, es único, y a prueba de concurrencia.
 *
 * EL CASO DE V-105
 * ----------------
 * Un vendedor tenía tres tirillas con el mismo folio pero horas de sorteo
 * distintas: era la misma venta reimpresa, y la línea «SORTEO» salía del estado
 * de la pantalla. Aparte, el folio se generaba con `count(*)+1` sin bloqueo:
 * dos ventas casi simultáneas podían chocar.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · El folio nuevo lleva la franja: V###-YYYYMMDD-<1|2|3>-####.
 *   · Cada sorteo tiene su propia numeración (mañana y tarde no comparten).
 *   · Dos tandas SIMULTÁNEAS del mismo vendedor no chocan: dos folios
 *     distintos, ninguna falla.
 *   · La tanda devuelve el SORTEO REAL del ticket (fecha y hora).
 *
 * Monta su propio vendedor/sorteos en fecha lejana y limpia al terminar.
 *
 *     node supabase/pruebas/folio-franja.mjs
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

const FECHA = "2099-08-12";
const COD = "V-966";
let ok = 0, fallos = 0;
const check = (n, c, d = "") => { if (c) { ok++; console.log(`  ok    ${n}`); } else { fallos++; console.log(`  FALLA ${n} ${d}`); } };

const limpiar = async () => {
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", COD).maybeSingle();
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  if (v) {
    await sb.from("consecutivo_folio").delete().eq("vendedor_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

try {
  await limpiar();
  console.log("\n1. Montaje");
  const { data: nv } = await sb.from("vendedor").insert({ codigo: COD, nombre: "REPRO FOLIO", ciudad: "Choloma", zona: "p", color: "#4f46e5", activo: true }).select("id").single();
  const vid = nv.id;
  await sb.from("parametro_vendedor").insert({ vendedor_id: vid, comision: 0.15, factor_pago: 70, tope_por_numero: 999999 });
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sManiana = sorteos.find((s) => s.hora === "11:00").id;
  const sTarde = sorteos.find((s) => s.hora === "15:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sManiana, p_limite_por_numero: 999999 });
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sTarde, p_limite_por_numero: 999999 });

  // --- Folio con franja -------------------------------------------------
  console.log("\n2. El folio lleva la franja del sorteo");
  const { data: r1 } = await sb.rpc("fn_registrar_tanda", { p_sorteo_id: sManiana, p_vendedor_id: vid, p_tickets: [[{ numero: 10, monto: 20 }]] });
  const folioMan = r1?.[0]?.r_folio;
  check("el folio de la mañana lleva franja 1", /-1-\d{4}$/.test(folioMan ?? ""), `folio ${folioMan}`);
  check("la tanda devuelve el sorteo real (hora)", r1?.[0]?.r_sorteo_hora === "11:00", `da ${r1?.[0]?.r_sorteo_hora}`);
  check("y la fecha real", r1?.[0]?.r_sorteo_fecha === FECHA, `da ${r1?.[0]?.r_sorteo_fecha}`);

  const { data: r2 } = await sb.rpc("fn_registrar_tanda", { p_sorteo_id: sTarde, p_vendedor_id: vid, p_tickets: [[{ numero: 10, monto: 20 }]] });
  const folioTar = r2?.[0]?.r_folio;
  check("el folio de la tarde lleva franja 2", /-2-\d{4}$/.test(folioTar ?? ""), `folio ${folioTar}`);

  // Cada franja tiene su propio consecutivo: ambos son -0001.
  check("mañana y tarde tienen numeración independiente (ambos 0001)",
    folioMan?.endsWith("-1-0001") && folioTar?.endsWith("-2-0001"), `${folioMan} / ${folioTar}`);

  // --- Consecutivo sube dentro de la misma franja -----------------------
  console.log("\n3. El consecutivo sube dentro de la franja");
  const { data: r3 } = await sb.rpc("fn_registrar_tanda", { p_sorteo_id: sManiana, p_vendedor_id: vid, p_tickets: [[{ numero: 11, monto: 20 }]] });
  check("la segunda venta de la mañana es -1-0002", r3?.[0]?.r_folio?.endsWith("-1-0002"), `folio ${r3?.[0]?.r_folio}`);

  // --- Concurrencia: dos tandas simultáneas no chocan -------------------
  console.log("\n4. Dos tandas simultáneas del mismo vendedor no chocan");
  const [a, b] = await Promise.all([
    sb.rpc("fn_registrar_tanda", { p_sorteo_id: sManiana, p_vendedor_id: vid, p_tickets: [[{ numero: 20, monto: 20 }]] }),
    sb.rpc("fn_registrar_tanda", { p_sorteo_id: sManiana, p_vendedor_id: vid, p_tickets: [[{ numero: 21, monto: 20 }]] }),
  ]);
  check("ninguna de las dos falló", !a.error && !b.error, `${a.error?.message ?? ""} ${b.error?.message ?? ""}`);
  const fa = a.data?.[0]?.r_folio, fb = b.data?.[0]?.r_folio;
  check("los dos folios son distintos", fa && fb && fa !== fb, `${fa} vs ${fb}`);

  // --- No hay folios duplicados de este vendedor hoy --------------------
  console.log("\n5. Sin folios duplicados");
  const { data: sorteosF } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  const ids = (sorteosF ?? []).map((s) => s.id);
  const { data: tks } = await sb.from("ticket").select("folio").eq("vendedor_id", vid).in("sorteo_id", ids);
  const folios = (tks ?? []).map((t) => t.folio);
  check("todos los folios son únicos", new Set(folios).size === folios.length, `${folios.length} folios, ${new Set(folios).size} únicos`);
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  console.log("\n6. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
