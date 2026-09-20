/**
 * El factor de pago se congela en la captura por totales.
 *
 * EL CASO REPORTADO (V-064)
 * -------------------------
 * Un premio se registró bien —venta y premio correctos— pero al buscar los
 * premiados salían de menos. La causa: el «premiado» de una captura por totales
 * se deduce dividiendo el premio entre el factor, y esa división usaba el factor
 * VIGENTE HOY. Si al vendedor le cambió el factor después de capturar, el
 * premiado deducido cambiaba solo.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Una captura hecha con factor 70 sigue deduciendo el premiado con 70
 *     aunque el factor del vendedor pase a 80 —no baja—.
 *   · La captura guardó el factor (factor_congelado).
 *   · La venta y el premio (pago) no cambian: el fallo era sólo el premiado.
 *   · La liquidación (saldo) no se movió: no depende del premiado deducido.
 *
 * Monta su propio vendedor y sorteo en fechas lejanas y limpia al terminar.
 *
 *     node supabase/pruebas/factor-congelado.mjs
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

const FECHA = "2099-04-08";
const GANADOR = 44;
const COD = "V-968";

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
const cent = (v) => Math.round(Number(v ?? 0) * 100);

const limpiar = async () => {
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", COD).maybeSingle();
  if (v) {
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

const premiadoEnHoja = async (vid) => {
  const { data } = await sb.rpc("fn_semana_completa", {
    p_vendedor_id: vid,
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  return (data ?? []).reduce((a, f) => a + Number(f.r_premiado), 0);
};

try {
  await limpiar();

  console.log("\n1. Montaje: vendedor con factor 70 y un sorteo");
  const { data: admin } = await sb.from("usuario").select("id").eq("rol", "administrador").limit(1).single();
  const { data: nv } = await sb
    .from("vendedor")
    .insert({ codigo: COD, nombre: "REPRO FACTOR", ciudad: "Choloma", zona: "p", color: "#4f46e5", activo: true })
    .select("id")
    .single();
  const vid = nv.id;
  // Factor 70 vigente desde antes de la fecha del sorteo.
  await sb.from("parametro_vendedor").insert({
    vendedor_id: vid, comision: 0.15, factor_pago: 70, tope_por_numero: 99999,
    vigente_desde: `${FECHA}T00:00:00-06:00`,
  });

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sId = sorteos.find((s) => s.hora === "11:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sId, p_limite_por_numero: 999999 });

  // Captura por totales: apostado 90 → premio 90×70 = 6300.
  console.log("\n2. Capturar por totales con factor 70 (apostado 90 → premio 6300)");
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sId,
    p_vendedor_id: vid,
    p_venta: 5000,
    p_premios: 6300,
    p_usuario_id: admin.id,
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sId });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sId, p_numero_ganador: GANADOR });

  const { data: cap } = await sb
    .from("venta_total")
    .select("venta, premios, factor_congelado")
    .eq("sorteo_id", sId)
    .eq("vendedor_id", vid)
    .single();
  check("la captura guardó el factor congelado (70)", cent(cap.factor_congelado) === cent(70), `da ${cap.factor_congelado}`);

  const prem70 = await premiadoEnHoja(vid);
  check("el premiado deducido es 90 (6300 / 70)", cent(prem70) === cent(90), `da ${prem70}`);

  const { data: liq0 } = await sb
    .from("liquidacion")
    .select("venta, premios, utilidad")
    .eq("sorteo_id", sId).eq("vendedor_id", vid).single();
  const saldo0 = Number(liq0.utilidad);

  // --- Cambiar el factor a 80: el premiado NO debe bajar ------------------
  console.log("\n3. Cambiar el factor del vendedor a 80");
  await sb.from("parametro_vendedor").update({ vigente_hasta: `${FECHA}T18:00:00-06:00` })
    .eq("vendedor_id", vid).is("vigente_hasta", null);
  await sb.from("parametro_vendedor").insert({
    vendedor_id: vid, comision: 0.15, factor_pago: 80, tope_por_numero: 99999,
    vigente_desde: `${FECHA}T18:00:01-06:00`,
  });

  const prem80 = await premiadoEnHoja(vid);
  check(
    "el premiado SIGUE en 90 pese al cambio de factor (antes bajaba a ~78.75)",
    cent(prem80) === cent(90),
    `da ${prem80}`,
  );

  // La venta y el premio no cambian; el saldo tampoco.
  const { data: liq1 } = await sb
    .from("liquidacion")
    .select("venta, premios, utilidad")
    .eq("sorteo_id", sId).eq("vendedor_id", vid).single();
  check("la venta no cambió (5000)", cent(liq1.venta) === cent(5000), `da ${liq1.venta}`);
  check("el premio pagado no cambió (6300)", cent(liq1.premios) === cent(6300), `da ${liq1.premios}`);
  check("el saldo no se movió con el cambio de factor", cent(liq1.utilidad) === cent(saldo0), `${liq1.utilidad} vs ${saldo0}`);

  // --- Una captura NUEVA congela el factor vigente (80) ------------------
  console.log("\n4. Una captura nueva congela el factor vigente");
  const s2 = sorteos.find((s) => s.hora === "15:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s2, p_limite_por_numero: 999999 });
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: s2, p_vendedor_id: vid, p_venta: 1000, p_premios: 800, p_usuario_id: admin.id,
  });
  const { data: cap2 } = await sb
    .from("venta_total").select("factor_congelado").eq("sorteo_id", s2).eq("vendedor_id", vid).single();
  check("la captura nueva congeló el factor vigente (80)", cent(cap2.factor_congelado) === cent(80), `da ${cap2.factor_congelado}`);
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  console.log("\n5. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
