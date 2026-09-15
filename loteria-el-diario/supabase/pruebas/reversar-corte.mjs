/**
 * Reversar una liquidación: dejarla como si nunca se hubiera hecho.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que LOS ABONOS VUELVAN A ESTAR VIVOS. Es lo que puede romperse en
 *     silencio: si el vendedor había entregado 400 a cuenta, ese dinero estaba
 *     contado DENTRO del corte. Al revertir, si los abonos no se liberan, esos
 *     400 desaparecen de la cuenta y se le vuelven a cobrar. Nadie lo nota
 *     hasta que el vendedor reclama.
 *
 *   · Que los sorteos VUELVAN A ESTAR PENDIENTES, que es lo visible.
 *
 *   · Que el corte DESAPAREZCA del historial de pagos: uno anulado seguiría
 *     diciendo que se le entregó algo.
 *
 *   · Que quede la HUELLA en auditoría, con lo que el corte decía: una vez
 *     borrado no hay forma de reconstruirlo.
 *
 *   · Que después se pueda volver a liquidar, que es para lo que se revierte.
 *
 *     node supabase/pruebas/reversar-corte.mjs
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

const FECHA = "2031-01-20";
const NOMBRE = "ZZZ Reversar";

let ok = 0;
let fallos = 0;
const check = (n, c, d = "") => {
  if (c) {
    ok++;
    console.log(`  ok    ${n}`);
  } else {
    fallos++;
    console.log(`  FALLA ${n} ${d}`);
  }
};

async function limpiar() {
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
    for (const c of cs ?? []) {
      await sb.from("corte_detalle").delete().eq("corte_id", c.id);
      await sb.from("auditoria").delete().eq("entidad_id", c.id);
    }
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
  }

  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: liqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const l of liqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", l.id);
    const { data: tks } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of tks ?? []) {
      await sb.from("auditoria").delete().eq("entidad_id", t.id);
      await sb.from("linea").delete().eq("ticket_id", t.id);
    }
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("auditoria").delete().eq("entidad_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }

  for (const v of vs ?? []) {
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

const deuda = async (id) => {
  const { data } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: id });
  const f = data?.[0];
  return {
    sorteos: f?.r_sorteos ?? 0,
    deuda: Number(f?.r_deuda ?? 0),
    abonado: Number(f?.r_abonado ?? 0),
    pendiente: Number(f?.r_pendiente ?? 0),
  };
};

async function main() {
  await limpiar();

  const { data: alta, error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: `${NOMBRE} UNO`,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.1,
    p_factor_pago: 70,
    p_tope_por_numero: 500000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedor = alta[0].vendedor_id;

  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  // Tres sorteos vendidos y liquidados: 1000 cada uno al 10 %, sin premios.
  // Debe 900 por sorteo = 2700.
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora")
    .eq("fecha", FECHA)
    .order("hora");

  for (const s of sorteos) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
    const { error } = await sb.rpc("fn_registrar_tanda", {
      p_sorteo_id: s.id,
      p_vendedor_id: vendedor,
      p_tickets: [[{ numero: 7, monto: 1000 }]],
      p_forzar: true,
    });
    if (error) throw new Error(`vender: ${error.message}`);
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: 55 });
  }

  // Entregó 400 a cuenta antes de cerrar.
  const { error: eAbono } = await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 400,
    p_fecha_pago: null,
    p_nota: "a cuenta",
    p_usuario_id: admin.id,
  });
  if (eAbono) throw new Error(`abono: ${eAbono.message}`);

  console.log("--- Antes de liquidar ---");
  let d = await deuda(vendedor);
  check("debe 2700 en tres sorteos", d.deuda === 2700 && d.sorteos === 3,
        `${d.deuda} en ${d.sorteos}`);
  check("con 400 ya entregados a cuenta", d.abonado === 400, String(d.abonado));

  // --- Se liquida SÓLO UN SORTEO, que es lo que se pidió poder hacer ---------
  console.log("\n--- Liquidar un solo sorteo del día ---");
  const { data: liqs } = await sb
    .from("liquidacion")
    .select("id, sorteo_id")
    .eq("vendedor_id", vendedor);
  const soloUno = liqs.find((l) => l.sorteo_id === sorteos[0].id);

  const { data: corte1, error: eC1 } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedor,
    p_liquidacion_ids: [soloUno.id],
    p_desde: FECHA,
    p_hasta: FECHA,
    p_nota: "sólo la mañana",
    p_usuario_id: admin.id,
  });
  check("se puede liquidar un solo sorteo", !eC1, eC1?.message ?? "");
  check("el corte cubre un sorteo", corte1?.[0]?.r_sorteos === 1, String(corte1?.[0]?.r_sorteos));

  d = await deuda(vendedor);
  check("quedan dos sorteos pendientes", d.sorteos === 2, String(d.sorteos));

  // --- Y se revierte ----------------------------------------------------------
  console.log("\n--- Reversar esa liquidación ---");
  const { data: det, error: eDet } = await sb.rpc("fn_detalle_corte", {
    p_corte_id: corte1[0].r_corte_id,
  });
  check("se puede ver qué contiene antes de deshacer", !eDet && (det ?? []).length === 1,
        eDet?.message ?? `${(det ?? []).length} sorteos`);

  const { data: rev, error: eRev } = await sb.rpc("fn_reversar_corte", {
    p_corte_id: corte1[0].r_corte_id,
    p_motivo: "era la semana equivocada",
    p_usuario_id: admin.id,
  });
  check("la reversa no da error", !eRev, eRev?.message ?? "");
  check("devuelve cuántos sorteos vuelven", rev?.[0]?.r_sorteos === 1,
        String(rev?.[0]?.r_sorteos));

  d = await deuda(vendedor);
  check("LOS TRES SORTEOS VUELVEN A ESTAR PENDIENTES", d.sorteos === 3, String(d.sorteos));
  check("y la deuda vuelve a 2700", d.deuda === 2700, String(d.deuda));

  const { data: sigue } = await sb
    .from("corte_vendedor")
    .select("id")
    .eq("id", corte1[0].r_corte_id)
    .maybeSingle();
  check("EL CORTE DESAPARECE del historial", sigue === null, "sigue existiendo");

  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, valor_anterior, valor_nuevo, usuario_id")
    .eq("entidad_id", corte1[0].r_corte_id)
    .eq("accion", "reversar");
  check("pero queda la huella en auditoría", (aud ?? []).length >= 1, `${(aud ?? []).length}`);
  check("con lo que el corte decía", /revertido/.test(String(aud?.[0]?.valor_nuevo)),
        String(aud?.[0]?.valor_nuevo));
  check("y con quién lo hizo", aud?.[0]?.usuario_id === admin.id,
        String(aud?.[0]?.usuario_id));

  // --- LO QUE MÁS IMPORTA: el abono absorbido vuelve a la vida ----------------
  console.log("\n--- Un corte que absorbió abonos ---");

  // Ahora se cierra TODO, que absorbe el abono de 400.
  const { data: todas } = await sb
    .from("liquidacion")
    .select("id")
    .eq("vendedor_id", vendedor);

  const { data: corte2, error: eC2 } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedor,
    p_liquidacion_ids: todas.map((l) => l.id),
    p_desde: FECHA,
    p_hasta: FECHA,
    p_nota: "todo",
    p_usuario_id: admin.id,
  });
  check("se cierra la semana entera", !eC2, eC2?.message ?? "");
  check("y absorbe el abono de 400", Number(corte2?.[0]?.r_abonado) === 400,
        String(corte2?.[0]?.r_abonado));

  d = await deuda(vendedor);
  check("no queda deuda ni abono suelto", d.deuda === 0 && d.abonado === 0,
        `deuda ${d.deuda}, abonado ${d.abonado}`);

  const { data: rev2, error: eRev2 } = await sb.rpc("fn_reversar_corte", {
    p_corte_id: corte2[0].r_corte_id,
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("se revierte", !eRev2, eRev2?.message ?? "");
  check("dice cuántos abonos libera", rev2?.[0]?.r_abonos === 1, String(rev2?.[0]?.r_abonos));

  d = await deuda(vendedor);
  check(
    "EL ABONO VUELVE A ESTAR VIVO: los 400 no se pierden",
    d.abonado === 400,
    String(d.abonado),
  );
  check("la deuda vuelve entera", d.deuda === 2700, String(d.deuda));
  check(
    "y el pendiente descuenta lo entregado: 2700 − 400",
    d.pendiente === 2300,
    String(d.pendiente),
  );

  // --- Se puede volver a liquidar, que es para lo que se revierte -------------
  console.log("\n--- Y se puede liquidar otra vez ---");
  const { data: otraVez } = await sb
    .from("liquidacion")
    .select("id")
    .eq("vendedor_id", vendedor);

  const { error: eC3 } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedor,
    p_liquidacion_ids: otraVez.map((l) => l.id),
    p_desde: FECHA,
    p_hasta: FECHA,
    p_nota: "esta vez bien",
    p_usuario_id: admin.id,
  });
  check("se vuelve a liquidar sin chocar con el unique", !eC3, eC3?.message ?? "");

  // --- Rechazos ---------------------------------------------------------------
  console.log("\n--- Lo que no se acepta ---");
  const { error: eDoble } = await sb.rpc("fn_reversar_corte", {
    p_corte_id: corte2[0].r_corte_id,
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("un corte ya revertido no se revierte dos veces", !!eDoble,
        eDoble ? "" : "no dio error");

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
