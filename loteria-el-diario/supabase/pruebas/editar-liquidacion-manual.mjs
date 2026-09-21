/**
 * Edición manual de venta/premios desde la hoja del vendedor.
 *
 * El gerente puede corregir a mano la venta y los premios de un sorteo POR
 * TOTALES, y el cambio tiene que propagarse a la liquidación, al saldo y a la
 * hoja —igual que si se hubiera capturado así—. Lo que se comprueba:
 *
 *   · editar venta y premios rehace la liquidación (comisión y saldo se
 *     recalculan solos);
 *   · un sorteo con TICKETS de números RECHAZA la edición manual;
 *   · editar un sorteo YA PAGADO en un corte deja sólo la diferencia (0104);
 *   · queda constancia en la auditoría.
 *
 * Monta su propio sorteo en una fecha lejana y limpia al terminar.
 *
 *     node supabase/pruebas/editar-liquidacion-manual.mjs
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

const FECHA = "2098-03-11";
const GANADOR = 27;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
const cent = (v) => Math.round(Number(v ?? 0) * 100);

const limpiar = async () => {
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: lqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const lq of lqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", lq.id);
    await sb.from("ajuste_liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  await sb.from("corte_vendedor").delete().eq("desde", FECHA);
  await sb.from("abono_vendedor").delete().like("nota", "Reconocimiento por corrección%");
};

const liqDe = async (sorteoId, vendedorId) => {
  const { data } = await sb
    .from("liquidacion")
    .select("id, venta, comision, premios, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", vendedorId)
    .maybeSingle();
  return data;
};

try {
  await limpiar();

  console.log("\n1. Montaje");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sTot = sorteos.find((s) => s.hora === "11:00").id; // por totales
  const sTk = sorteos.find((s) => s.hora === "15:00").id; // con tickets
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sTot, p_limite_por_numero: 50000 });
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sTk, p_limite_por_numero: 50000 });

  const { data: admin } = await sb.from("usuario").select("id").eq("rol", "administrador").limit(1).single();
  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");
  const v = vs[0];
  const p = Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor;
  const comisionTasa = Number(p.comision);
  check("hay un vendedor con parámetros para la prueba", Boolean(v));

  // --- Un sorteo POR TOTALES, capturado y liquidado -----------------------
  console.log("\n2. Sorteo por totales: capturar y liquidar");
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sTot,
    p_vendedor_id: v.id,
    p_venta: 1000,
    p_premios: 200,
    p_usuario_id: admin.id,
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sTot });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sTot, p_numero_ganador: GANADOR });

  const l0 = await liqDe(sTot, v.id);
  check("la liquidación arrancó con la venta capturada (1000)", cent(l0.venta) === cent(1000), `da ${l0?.venta}`);

  // --- Edición manual: cambiar venta y premios ----------------------------
  console.log("\n3. Editar a mano venta y premios");
  const { data: r1, error: e1 } = await sb.rpc("fn_editar_liquidacion_manual", {
    p_liquidacion_id: l0.id,
    p_venta: 1500,
    p_premios: 300,
    p_usuario_id: admin.id,
  });
  check("la edición manual entra sin error", !e1, e1?.message ?? "");

  const l1 = await liqDe(sTot, v.id);
  check("la venta cambió a 1500", cent(l1.venta) === cent(1500), `da ${l1?.venta}`);
  check("los premios cambiaron a 300", cent(l1.premios) === cent(300), `da ${l1?.premios}`);
  check(
    "la comisión se recalculó (1500 × comisión)",
    cent(l1.comision) === cent(1500 * comisionTasa),
    `da ${l1?.comision}, esperaba ${1500 * comisionTasa}`,
  );
  check(
    "el saldo se recalculó (venta − comisión − premios)",
    cent(l1.utilidad) === cent(1500 - 1500 * comisionTasa - 300),
    `da ${l1?.utilidad}`,
  );
  check(
    "la función devolvió la fila rehecha",
    r1?.[0] && cent(r1[0].r_venta) === cent(1500) && cent(r1[0].r_saldo) === cent(1500 - 1500 * comisionTasa - 300),
    JSON.stringify(r1?.[0]),
  );

  // La captura por totales quedó reescrita, no duplicada.
  const { data: caps } = await sb
    .from("venta_total")
    .select("venta, premios")
    .eq("sorteo_id", sTot)
    .eq("vendedor_id", v.id)
    .is("anulado_en", null);
  check("hay una sola captura viva, ya con la cifra nueva",
    (caps ?? []).length === 1 && cent(caps[0].venta) === cent(1500), JSON.stringify(caps));

  // Queda en auditoría.
  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, campo, valor_nuevo")
    .eq("entidad", "venta_total")
    .eq("accion", "editar");
  check("el cambio quedó en auditoría", (aud ?? []).some((a) => a.campo === "venta"), `${(aud ?? []).length} entradas`);

  // --- Un sorteo con TICKETS rechaza la edición manual --------------------
  console.log("\n4. Sorteo con tickets: se rechaza");
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sTk,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: GANADOR, monto: 100 }, { numero: 5, monto: 50 }],
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sTk });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sTk, p_numero_ganador: GANADOR });
  const lTk = await liqDe(sTk, v.id);

  const { error: eTk } = await sb.rpc("fn_editar_liquidacion_manual", {
    p_liquidacion_id: lTk.id,
    p_venta: 999,
    p_premios: 0,
    p_usuario_id: admin.id,
  });
  check("un sorteo con tickets RECHAZA la edición manual", !!eTk && /tickets con n/i.test(eTk.message), eTk?.message ?? "entró igual");
  const lTk2 = await liqDe(sTk, v.id);
  check("y no tocó su liquidación (sigue en 150)", cent(lTk2.venta) === cent(150), `da ${lTk2?.venta}`);

  // --- Editar un sorteo YA PAGADO: la liquidación NO se toca; queda un ajuste -
  //
  // Modelo nuevo (0114-0118): una liquidación pagada es inmutable. Corregirla
  // no la reescribe ni la desliga del corte; la diferencia queda como un ajuste
  // pendiente (a favor o en contra). Así el corte firmado no se mueve.
  console.log("\n5. Editar un sorteo ya pagado: la liquidación no se toca, queda un ajuste");
  await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: [l1.id],
    p_desde: FECHA,
    p_hasta: FECHA,
    p_usuario_id: admin.id,
  });
  const viejo = Number(l1.utilidad); // lo que el corte pagó por este sorteo

  const { data: deudaAntes } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: v.id });
  const pendAntes = Number(deudaAntes?.[0]?.r_pendiente ?? 0);

  const { error: e2 } = await sb.rpc("fn_editar_liquidacion_manual", {
    p_liquidacion_id: l1.id,
    p_venta: 1700, // +200 de venta respecto de lo pagado (1500)
    p_premios: 300,
    p_usuario_id: admin.id,
  });
  check("editar un sorteo ya pagado no da error", !e2, e2?.message ?? "");

  const l2 = await liqDe(sTot, v.id);
  // El nuevo saldo que TENDRÍA el sorteo, para calcular la diferencia esperada.
  const nuevoUtil = 1700 - 1700 * comisionTasa - 300;

  check("la liquidación NO cambió (sigue con su valor pagado)", cent(l2.venta) === cent(1500), `da ${l2?.venta}`);

  // NO se desligó: sigue en el corte.
  const { data: det } = await sb.from("corte_detalle").select("liquidacion_id").eq("liquidacion_id", l1.id);
  check("la liquidación sigue en el corte (no se desligó)", (det ?? []).length === 1);

  // Apareció un ajuste vivo = la diferencia (nuevo − viejo).
  const ajuste = Number((await sb.rpc("fn_ajuste_pendiente", { p_vendedor_id: v.id })).data ?? 0);
  check(
    "apareció un ajuste = la diferencia (nuevo − viejo)",
    cent(ajuste) === cent(nuevoUtil - viejo),
    `ajuste ${ajuste}, esperaba ${nuevoUtil - viejo}`,
  );

  const { data: deudaDespues } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: v.id });
  const pendDespues = Number(deudaDespues?.[0]?.r_pendiente ?? 0);
  check(
    "el pendiente creció exactamente en la diferencia",
    Math.abs((pendDespues - pendAntes) - (nuevoUtil - viejo)) < 0.01,
    `Δpendiente ${pendDespues - pendAntes}, diferencia ${nuevoUtil - viejo}`,
  );
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
} finally {
  console.log("\n6. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
