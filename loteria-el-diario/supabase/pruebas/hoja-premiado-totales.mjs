/**
 * La hoja de liquidación no puede pagar premios por nada.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * Imprimible de V-011 MEXICOL, semana del 07/09/2026: aparecían venta y
 * premios, pero el valor premiado salía vacío, con una raya. Eso no puede ser
 * —si se pagaron 11.550 de premio, alguien acertó y hubo algo apostado al
 * número que salió— y el papel quedaba diciendo una contradicción.
 *
 * La causa: ese día MEXICOL no vendió por su teléfono. Sus tres sorteos eran
 * capturas por totales, y `fn_semana_completa` calculaba el premiado mirando
 * sólo `linea`. Una captura guarda el premio PAGADO, no lo apostado.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que con SÓLO capturas el premiado deje de ser cero: se deduce del
 *     factor, igual que en el informe (0070) y el panel del vendedor (0080).
 *   · Que el FACTOR vuelva a salir, porque se calcula dividiendo premios entre
 *     premiado y con cero abajo también salía en cero.
 *   · Que nunca queden premios pagados con premiado en cero. Es la regla que
 *     de verdad importa: la contradicción del papel.
 *   · Que las ventas con números sigan contando igual, y que sumen con las
 *     capturas cuando hay de las dos.
 *   · Que la hoja coincida con el informe de gerencia, que es contra lo que se
 *     cuadra por teléfono.
 *
 *     node supabase/pruebas/hoja-premiado-totales.mjs
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

const FECHA = "2031-05-05";
const NOMBRE = "ZZZ Hoja premiado";
const FACTOR = 70;

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
    p_comision: 0.15,
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

  const [manana, tarde, noche] = sorteos;
  const GANADOR = 18;

  /*
   * El escenario del caso real y su control.
   *
   *   11:00 — SÓLO captura por totales. Es el caso que fallaba: venta y
   *           premios sin premiado.
   *   15:00 — sólo venta con números, para comprobar que no se rompió.
   *   21:00 — las dos fuentes, para comprobar que suman.
   */
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: manana.id,
    p_vendedor_id: vendedor,
    p_venta: 3000,
    p_premios: 1400,   // 1400 / 70 = 20 de premiado deducido
    p_nota: "hoja de papel",
    p_usuario_id: admin.id,
  });

  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: tarde.id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: GANADOR, monto: 100 }, { numero: 7, monto: 900 }]],
    p_forzar: true,
  });

  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: noche.id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: GANADOR, monto: 50 }]],
    p_forzar: true,
  });
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: noche.id,
    p_vendedor_id: vendedor,
    p_venta: 2000,
    p_premios: 700,   // 700 / 70 = 10 deducidos, que se suman a los 50 propios
    p_nota: null,
    p_usuario_id: admin.id,
  });

  for (const s of sorteos) {
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: GANADOR });
  }

  const { data: semana, error } = await sb.rpc("fn_semana_completa", {
    p_vendedor_id: vendedor,
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  check("fn_semana_completa responde", !error, error?.message ?? "");

  const fila = (h) => (semana ?? []).find((x) => x.r_hora === h);

  // --- El caso que fallaba ----------------------------------------------------
  console.log("--- Sólo captura por totales (el caso reportado) ---");
  const f11 = fila("11:00");
  console.log(
    `        venta ${f11?.r_venta} · premiado ${f11?.r_premiado} · premios ${f11?.r_premios} · factor ${f11?.r_factor}`,
  );
  check("hay premios pagados", Number(f11?.r_premios) === 1400, String(f11?.r_premios));
  check(
    "EL PREMIADO YA NO SALE EN CERO: 1400 ÷ 70 = 20",
    Number(f11?.r_premiado) === 20,
    String(f11?.r_premiado),
  );
  check(
    "y el factor vuelve a verse",
    Number(f11?.r_factor) === FACTOR,
    String(f11?.r_factor),
  );

  // --- Lo de siempre no se rompió --------------------------------------------
  console.log("\n--- Sólo venta con números ---");
  const f15 = fila("15:00");
  check("el premiado es lo apostado al ganador", Number(f15?.r_premiado) === 100,
        String(f15?.r_premiado));
  check("y el factor sale igual", Number(f15?.r_factor) === FACTOR, String(f15?.r_factor));

  // --- Las dos fuentes suman --------------------------------------------------
  console.log("\n--- Las dos fuentes en el mismo sorteo ---");
  const f21 = fila("21:00");
  console.log(`        premiado ${f21?.r_premiado} · premios ${f21?.r_premios}`);
  check(
    "premiado = 50 suyos + 10 deducidos",
    Number(f21?.r_premiado) === 60,
    String(f21?.r_premiado),
  );
  check(
    "premios = 3500 suyos + 700 de la captura",
    Number(f21?.r_premios) === 4200,
    String(f21?.r_premios),
  );

  // --- LA REGLA QUE IMPORTA ---------------------------------------------------
  console.log("\n--- La contradicción del papel ---");
  const contradice = (semana ?? []).filter(
    (x) => Number(x.r_premios) > 0 && Number(x.r_premiado) === 0,
  );
  check(
    "NINGÚN SORTEO PAGA PREMIOS CON PREMIADO EN CERO",
    contradice.length === 0,
    `${contradice.length} filas: ${contradice.map((x) => x.r_hora).join(", ")}`,
  );

  // --- La hoja coincide con el informe ---------------------------------------
  console.log("\n--- La hoja y el informe dicen lo mismo ---");
  for (const h of ["11:00", "15:00", "21:00"]) {
    const { data: inf } = await sb.rpc("fn_informe_gerencia", {
      p_desde: FECHA,
      p_hasta: FECHA,
      p_hora: h,
    });
    const a = (inf ?? []).find((x) => x.r_vendedor_id === vendedor);
    const f = fila(h);
    check(
      `${h} · el premiado coincide`,
      Number(f?.r_premiado) === Number(a?.r_premiado),
      `hoja ${f?.r_premiado} vs informe ${a?.r_premiado}`,
    );
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
