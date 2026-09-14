/**
 * El vendedor ve las mismas cifras que el administrador.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * V-011 MEXICOL, 12/09/2026, sorteo de las 21:00. El administrador veía 7.285
 * de venta y 130 de premiado; el vendedor, en su teléfono, 3.940 y 110.
 *
 * Ninguna cifra estaba mal: la diferencia era una captura por totales de 3.345
 * que administración registró por él y que su panel no miraba. El resultado
 * práctico era el peor posible — el vendedor cuadraba con una cifra y se le
 * cobraba con otra.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que `fn_mi_periodo` y `fn_informe_gerencia` devuelvan LA MISMA venta y
 *     el MISMO premiado. Es la comprobación central: si alguna vez vuelven a
 *     separarse, esta prueba lo dice.
 *   · Que `fn_mi_dia` sume igual.
 *   · Que el premiado de la captura se DEDUZCA del factor, como en la 0070.
 *   · Que se diga cuánto viene de administración: sin eso el vendedor ve su
 *     venta crecer sin explicación y no puede cuadrar su libreta.
 *   · Que una captura ANULADA no cuente para ninguno de los dos.
 *   · Que un sorteo sin liquidar no invente premiado.
 *
 *     node supabase/pruebas/vendedor-ve-totales.mjs
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

const FECHA = "2031-07-09";
const NOMBRE = "ZZZ Vendedor ve totales";
const FACTOR = 70;
const COMISION = 0.15;

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
    const { data: liqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const l of liqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", l.id);
    const { data: vts } = await sb.from("venta_total").select("id").eq("sorteo_id", s.id);
    for (const vt of vts ?? []) await sb.from("auditoria").delete().eq("entidad_id", vt.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
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
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

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
    p_comision: COMISION,
    p_factor_pago: FACTOR,
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

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora")
    .eq("fecha", FECHA)
    .order("hora");
  for (const s of sorteos) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }

  /*
   * El escenario del caso real, con cifras redondas.
   *
   * Sorteo de la noche: el vendedor jugó 1.000 por su teléfono —de los cuales
   * 200 al número que saldrá— y administración capturó por él una hoja de 500
   * con 140 de premio pagado.
   *
   * 140 / 70 = 2 de premiado deducido. Si el sistema dedujera mal, el premiado
   * del admin y el del vendedor dejarían de coincidir y se vería aquí.
   */
  const noche = sorteos[2];
  const GANADOR = 46;

  const { error: eVenta } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: noche.id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: GANADOR, monto: 200 }, { numero: 7, monto: 800 }]],
    p_forzar: true,
  });
  if (eVenta) throw new Error(`vender: ${eVenta.message}`);

  const { error: eCap } = await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: noche.id,
    p_vendedor_id: vendedor,
    p_venta: 500,
    p_premios: 140,
    p_nota: "hoja de papel",
    p_usuario_id: admin.id,
  });
  if (eCap) throw new Error(`capturar: ${eCap.message}`);

  // --- Antes de liquidar ------------------------------------------------------
  console.log("--- Antes de liquidar ---");
  const { data: antes } = await sb.rpc("fn_mi_periodo", {
    p_vendedor_id: vendedor,
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  const fAntes = (antes ?? []).find((x) => x.r_hora === "21:00");
  check("la venta ya suma las dos fuentes", Number(fAntes?.r_venta) === 1500,
        String(fAntes?.r_venta));
  check(
    "pero SIN número ganador no se inventa premiado",
    Number(fAntes?.r_premiado) === 0,
    String(fAntes?.r_premiado),
  );

  // --- Liquidado --------------------------------------------------------------
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: noche.id });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: noche.id, p_numero_ganador: GANADOR });

  console.log("\n--- Lo que ve el VENDEDOR ---");
  const { data: mio, error: eMio } = await sb.rpc("fn_mi_periodo", {
    p_vendedor_id: vendedor,
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  check("fn_mi_periodo responde", !eMio, eMio?.message ?? "");
  const v = (mio ?? []).find((x) => x.r_hora === "21:00");
  console.log(
    `        venta ${v?.r_venta} · premiado ${v?.r_premiado} · premios ${v?.r_premios}`,
  );
  check("venta = 1000 suyos + 500 de administración", Number(v?.r_venta) === 1500,
        String(v?.r_venta));
  check(
    "premiado = 200 suyos + 2 deducidos (140 ÷ 70)",
    Number(v?.r_premiado) === 202,
    String(v?.r_premiado),
  );
  check("premios = 14000 suyos + 140 de la captura",
        Number(v?.r_premios) === 14140, String(v?.r_premios));
  check(
    "SE DICE cuánto viene de administración",
    Number(v?.r_venta_admin) === 500 && v?.r_capturas === 1,
    `${v?.r_venta_admin} en ${v?.r_capturas} capturas`,
  );

  console.log("\n--- Lo que ve el ADMINISTRADOR ---");
  const { data: inf } = await sb.rpc("fn_informe_gerencia", {
    p_desde: FECHA,
    p_hasta: FECHA,
    p_hora: "21:00",
  });
  const a = (inf ?? []).find((x) => x.r_vendedor_id === vendedor);
  console.log(`        venta ${a?.r_venta} · premiado ${a?.r_premiado} · pago ${a?.r_pago}`);

  // --- LA COMPROBACIÓN CENTRAL ------------------------------------------------
  console.log("\n--- Las dos pantallas dicen lo mismo ---");
  check(
    "LA VENTA COINCIDE",
    Number(v?.r_venta) === Number(a?.r_venta),
    `vendedor ${v?.r_venta} vs admin ${a?.r_venta}`,
  );
  check(
    "EL PREMIADO COINCIDE",
    Number(v?.r_premiado) === Number(a?.r_premiado),
    `vendedor ${v?.r_premiado} vs admin ${a?.r_premiado}`,
  );
  check(
    "y lo pagado en premios también",
    Number(v?.r_premios) === Number(a?.r_pago),
    `vendedor ${v?.r_premios} vs admin ${a?.r_pago}`,
  );

  // --- fn_mi_dia suma igual ---------------------------------------------------
  console.log("\n--- El día del vendedor ---");
  const { data: dia, error: eDia } = await sb.rpc("fn_mi_dia", {
    p_vendedor_id: vendedor,
    p_fecha: FECHA,
  });
  check("fn_mi_dia responde", !eDia, eDia?.message ?? "");
  const d = (dia ?? []).find((x) => x.r_hora === "21:00");
  check("suma las dos fuentes igual", Number(d?.r_venta) === 1500, String(d?.r_venta));
  check("y también lo dice", Number(d?.r_venta_admin) === 500, String(d?.r_venta_admin));
  check(
    "la comisión usa la congelada de cada fuente",
    Math.abs(Number(d?.r_comision) - (1000 * COMISION + 500 * COMISION)) < 0.01,
    String(d?.r_comision),
  );

  // --- Una captura anulada no cuenta para nadie -------------------------------
  console.log("\n--- Una captura anulada ---");
  const { data: cap } = await sb
    .from("venta_total")
    .select("id")
    .eq("sorteo_id", noche.id)
    .eq("vendedor_id", vendedor)
    .single();

  const { error: eAnul } = await sb.rpc("fn_anular_venta_total", {
    p_id: cap.id,
    p_usuario_id: admin.id,
  });
  check("se puede anular", !eAnul, eAnul?.message ?? "");

  const { data: tras } = await sb.rpc("fn_mi_periodo", {
    p_vendedor_id: vendedor,
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  const v2 = (tras ?? []).find((x) => x.r_hora === "21:00");
  check("el vendedor vuelve a ver sólo lo suyo", Number(v2?.r_venta) === 1000,
        String(v2?.r_venta));
  check("sin el premiado deducido", Number(v2?.r_premiado) === 200,
        String(v2?.r_premiado));
  check("y sin nada de administración", Number(v2?.r_venta_admin) === 0,
        String(v2?.r_venta_admin));

  const { data: inf2 } = await sb.rpc("fn_informe_gerencia", {
    p_desde: FECHA,
    p_hasta: FECHA,
    p_hora: "21:00",
  });
  const a2 = (inf2 ?? []).find((x) => x.r_vendedor_id === vendedor);
  check(
    "y las dos pantallas siguen coincidiendo",
    Number(v2?.r_venta) === Number(a2?.r_venta) &&
      Number(v2?.r_premiado) === Number(a2?.r_premiado),
    `vendedor ${v2?.r_venta}/${v2?.r_premiado} vs admin ${a2?.r_venta}/${a2?.r_premiado}`,
  );

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
