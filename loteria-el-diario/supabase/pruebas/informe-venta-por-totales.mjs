/**
 * El informe de gerencia con venta capturada POR TOTALES.
 *
 * EL CASO QUE LO MOTIVA
 * ---------------------
 * V-006 aparecía con «premiado 0» y a la vez «pago premios 3,850». Se captura
 * por totales —venta y premios en bloque, sin línea a línea— y el informe
 * calculaba dos columnas leyendo sólo de `linea`.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que el PREMIADO deje de ser cero cuando hubo premios, y que salga de
 *     dividir los premios entre el factor. Es el síntoma que se reportó.
 *   · Que el FACTOR deje de ser cero: se calcula dividiendo por el premiado,
 *     así que arrastraba el mismo fallo.
 *   · Que la VENTA de un sorteo abierto capturado por totales SE VEA. Hoy
 *     desaparece del informe hasta que el sorteo se liquida — dinero real
 *     invisible en la pantalla.
 *   · Que un vendedor con LAS DOS VÍAS sume las dos, sin duplicar ninguna.
 *   · Que un vendedor que vende sólo línea a línea NO CAMBIE. Es lo que hay
 *     que proteger: el arreglo no puede mover las cifras de los demás.
 *
 * Crea dos vendedores y sorteos en una fecha lejana; borra todo al final.
 *
 *     node supabase/pruebas/informe-venta-por-totales.mjs
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

const FECHA = "2031-07-21";
const NOMBRE = "ZZZ Totales";

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
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: tks } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of tks ?? []) {
      await sb.from("auditoria").delete().eq("entidad_id", t.id);
      await sb.from("linea").delete().eq("ticket_id", t.id);
    }
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("auditoria").delete().eq("entidad_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

const crear = async (sufijo) => {
  const { data, error } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: `${NOMBRE} ${sufijo}`,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.15,
    p_factor_pago: 70,
    p_tope_por_numero: 500000,
    p_alias: null,
  });
  if (error) throw new Error(`${sufijo}: ${error.message}`);
  return data[0].vendedor_id;
};

async function main() {
  await limpiar();

  // TOT: sólo captura por totales. MIX: las dos vías. LIN: sólo líneas.
  const tot = await crear("TOT");
  const mix = await crear("MIX");
  const lin = await crear("LIN");

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora")
    .eq("fecha", FECHA)
    .order("hora");
  const s11 = sorteos.find((s) => s.hora === "11:00");
  const s15 = sorteos.find((s) => s.hora === "15:00");

  for (const s of [s11, s15]) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }

  // --- Sorteo de las 11:00: se va a liquidar --------------------------------
  // TOT: captura por totales. 7000 de venta, 2100 de premios -> premiado 30.
  const capturar = async (sorteoId, vendedorId, venta, premios) => {
    const { error } = await sb.rpc("fn_registrar_venta_total", {
      p_sorteo_id: sorteoId,
      p_vendedor_id: vendedorId,
      p_venta: venta,
      p_premios: premios,
      p_nota: "prueba",
      p_usuario_id: null,
    });
    if (error) throw new Error(`captura: ${error.message}`);
  };

  await capturar(s11.id, tot, 7000, 2100);

  // MIX: 1000 en líneas al 7 (que no gana) + captura de 2000 con 700 de premio.
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: s11.id,
    p_vendedor_id: mix,
    p_tickets: [[{ numero: 7, monto: 1000 }]],
  });
  await capturar(s11.id, mix, 2000, 700);

  // LIN: sólo líneas, y una de ellas al número que va a ganar.
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: s11.id,
    p_vendedor_id: lin,
    p_tickets: [[{ numero: 55, monto: 50 }, { numero: 7, monto: 900 }]],
  });

  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s11.id });
  const { error: eLiq } = await sb.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: s11.id,
    p_numero_ganador: 55,
  });
  if (eLiq) {
    console.log("no se pudo liquidar:", eLiq.message);
    await limpiar();
    process.exit(1);
  }

  // --- Sorteo de las 15:00: se queda ABIERTO --------------------------------
  // Es el caso de la venta invisible: capturada pero sin liquidar.
  await capturar(s15.id, tot, 3000, 0);

  // --- El informe ------------------------------------------------------------
  const { data, error } = await sb.rpc("fn_informe_gerencia", {
    p_desde: FECHA,
    p_hasta: FECHA,
    p_hora: null,
  });
  if (error) {
    console.log("el informe falló:", error.message);
    await limpiar();
    process.exit(1);
  }

  const fila = (id) => (data ?? []).find((f) => f.r_vendedor_id === id);
  const T = fila(tot);
  const M = fila(mix);
  const L = fila(lin);

  console.log("\n--- Sólo captura por totales ---");
  check("aparece en el informe", !!T, "no aparece");
  if (T) {
    // 7000 del liquidado + 3000 del abierto.
    check("la venta suma los dos sorteos", Number(T.r_venta) === 10000, String(T.r_venta));
    check(
      "LA VENTA DEL SORTEO ABIERTO SE VE",
      Number(T.r_venta_pendiente) === 3000,
      String(T.r_venta_pendiente),
    );
    check("y se marca como pendiente", T.r_tiene_pendiente === true, String(T.r_tiene_pendiente));
    // 2100 / 70 = 30. Era 0 antes del arreglo.
    check("EL PREMIADO YA NO ES CERO", Number(T.r_premiado) === 30, String(T.r_premiado));
    check("el factor sale bien", Number(T.r_factor) === 70, String(T.r_factor));
    check("el pago de premios se mantiene", Number(T.r_pago) === 2100, String(T.r_pago));
  }

  console.log("\n--- Las dos vías a la vez ---");
  if (M) {
    check("la venta suma línea y captura", Number(M.r_venta) === 3000, String(M.r_venta));
    // 700/70 = 10 de la captura; las líneas del 7 no ganaron.
    check("el premiado sale de la captura", Number(M.r_premiado) === 10, String(M.r_premiado));
    check("sin duplicar la venta", Number(M.r_venta) === 3000, String(M.r_venta));
  }

  console.log("\n--- Sólo líneas: NO debe cambiar ---");
  if (L) {
    check("la venta es la de sus líneas", Number(L.r_venta) === 950, String(L.r_venta));
    check("el premiado es lo apostado al 55", Number(L.r_premiado) === 50, String(L.r_premiado));
    check("el factor sigue siendo 70", Number(L.r_factor) === 70, String(L.r_factor));
    check("el pago es 50 × 70", Number(L.r_pago) === 3500, String(L.r_pago));
  }

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
