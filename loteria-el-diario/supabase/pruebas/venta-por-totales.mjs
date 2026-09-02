/**
 * La venta por totales, y que no haya roto la liquidación de siempre.
 *
 * La 0048 reescribió `fn_liquidar_sorteo`, que es la función que convierte un
 * número ganador en dinero: de ella salen la liquidación, el corte semanal y
 * todos los informes. Lo primero que hay que demostrar no es que la novedad
 * funcione, sino que lo de antes sigue dando EXACTAMENTE lo mismo — un céntimo
 * de diferencia aquí se propaga a todo el sistema.
 *
 * Monta su propio sorteo en una fecha lejana y limpia al terminar.
 *
 *     node supabase/pruebas/venta-por-totales.mjs
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

const FECHA = "2097-07-07";
const GANADOR = 33;

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
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: 500000 });

  const { data: vend } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, vigente_hasta)")
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .limit(2);

  const [uno, dos] = vend;
  check("hay dos vendedores con parámetros", Boolean(uno && dos));

  // `uno` vende número a número; `dos` sólo tendrá captura por totales.
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: uno.id,
    p_lineas: [
      { numero: GANADOR, monto: 100 },
      { numero: 7, monto: 250 },
    ],
  });

  // --- La cuenta de siempre ----------------------------------------------
  // Se calcula a mano desde las líneas, con la MISMA fórmula que usaba la
  // función antes de la 0048.
  const esperado = async (vendedorId) => {
    const { data: ts } = await sb
      .from("ticket").select("id").eq("sorteo_id", sorteoId).eq("vendedor_id", vendedorId)
      .is("anulado_en", null);
    const ids = (ts ?? []).map((t) => t.id);
    if (ids.length === 0) return { venta: 0, comision: 0, premios: 0 };
    const { data: ls } = await sb
      .from("linea").select("monto, premio, comision_congelada, gana").in("ticket_id", ids);
    return (ls ?? []).reduce(
      (a, l) => ({
        venta: a.venta + cent(l.monto),
        comision: a.comision + Math.round(Number(l.monto) * Number(l.comision_congelada) * 100),
        premios: a.premios + cent(l.premio),
      }),
      { venta: 0, comision: 0, premios: 0 },
    );
  };

  // --- 2. Sin capturas: idéntico a antes ----------------------------------
  console.log("\n2. Sin capturas por totales, la liquidación no cambia");
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteoId });
  const { error: eLiq } = await sb.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: sorteoId,
    p_numero_ganador: GANADOR,
  });
  check("liquida sin error", !eLiq, eLiq?.message ?? "");

  const previsto = await esperado(uno.id);
  const { data: lq1 } = await sb
    .from("liquidacion").select("*").eq("sorteo_id", sorteoId).eq("vendedor_id", uno.id).maybeSingle();

  check("la venta coincide al céntimo", cent(lq1?.venta) === previsto.venta,
    `${cent(lq1?.venta)} vs ${previsto.venta}`);
  check("la comisión coincide al céntimo", cent(lq1?.comision) === previsto.comision,
    `${cent(lq1?.comision)} vs ${previsto.comision}`);
  check("los premios coinciden al céntimo", cent(lq1?.premios) === previsto.premios,
    `${cent(lq1?.premios)} vs ${previsto.premios}`);
  check("la utilidad es venta − comisión − premios",
    cent(lq1?.utilidad) === previsto.venta - previsto.comision - previsto.premios);
  check("el vendedor sin nada no tiene fila",
    !(await sb.from("liquidacion").select("id").eq("sorteo_id", sorteoId).eq("vendedor_id", dos.id).maybeSingle()).data);

  // --- 3. Una captura por totales ----------------------------------------
  console.log("\n3. La captura por totales entra en la liquidación");
  const VENTA = 4200, PREMIO = 8400;
  const { data: reg, error: eReg } = await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: dos.id,
    p_venta: VENTA,
    p_premios: PREMIO,
    p_nota: "prueba",
  });
  check("se registra", !eReg, eReg?.message ?? "");

  const { data: lq2 } = await sb
    .from("liquidacion").select("*").eq("sorteo_id", sorteoId).eq("vendedor_id", dos.id).maybeSingle();
  check("aparece en la liquidación aunque el sorteo ya estaba liquidado", Boolean(lq2));

  const tasa = Number(dos.parametro_vendedor[0].comision);
  check("la venta es la capturada", cent(lq2?.venta) === cent(VENTA), `${lq2?.venta}`);
  check("los premios son los capturados", cent(lq2?.premios) === cent(PREMIO), `${lq2?.premios}`);
  check("la comisión usa la tasa vigente del vendedor",
    Math.abs(Number(lq2?.comision) - VENTA * tasa) < 0.01,
    `${lq2?.comision} vs ${VENTA * tasa}`);
  check("el saldo lo devuelve la función igual que la tabla",
    Math.abs(Number(reg?.[0]?.r_saldo) - Number(lq2?.utilidad)) < 0.01,
    `${reg?.[0]?.r_saldo} vs ${lq2?.utilidad}`);

  // El que vendía por líneas no se movió.
  const { data: lq1b } = await sb
    .from("liquidacion").select("*").eq("sorteo_id", sorteoId).eq("vendedor_id", uno.id).maybeSingle();
  check("no toca al vendedor que vendió por líneas",
    cent(lq1b?.venta) === cent(lq1?.venta) && cent(lq1b?.premios) === cent(lq1?.premios));

  // --- 4. No consume cupo -------------------------------------------------
  console.log("\n4. No consume cupo, como se decidió");
  const { data: cupos } = await sb
    .from("cupo_numero").select("numero, vendido").eq("sorteo_id", sorteoId).gt("vendido", 0);
  const total = (cupos ?? []).reduce((a, c) => a + cent(c.vendido), 0);
  check("el cupo sólo refleja lo vendido por número", total === previsto.venta,
    `cupo ${total} vs líneas ${previsto.venta}`);

  // --- 5. Anular devuelve la liquidación a su sitio -----------------------
  console.log("\n5. Anular");
  const { error: eAnu } = await sb.rpc("fn_anular_venta_total", { p_id: reg[0].r_id });
  check("se anula sin error", !eAnu, eAnu?.message ?? "");
  const { data: lq3 } = await sb
    .from("liquidacion").select("id").eq("sorteo_id", sorteoId).eq("vendedor_id", dos.id).maybeSingle();
  check("la fila del vendedor desaparece al anular", !lq3);

  // --- 6. Las dos fuentes en el mismo vendedor ----------------------------
  console.log("\n6. Un vendedor con las dos formas a la vez");
  const { error: eMix } = await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: uno.id,
    p_venta: 1000,
    p_premios: 0,
  });
  check("se registra sobre quien ya tenía líneas", !eMix, eMix?.message ?? "");
  const { data: lq4 } = await sb
    .from("liquidacion").select("*").eq("sorteo_id", sorteoId).eq("vendedor_id", uno.id).maybeSingle();
  check("la venta es la suma de las dos fuentes",
    cent(lq4?.venta) === previsto.venta + cent(1000),
    `${cent(lq4?.venta)} vs ${previsto.venta + cent(1000)}`);
  check("los premios no cambian: la captura no traía premio",
    cent(lq4?.premios) === previsto.premios);
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
