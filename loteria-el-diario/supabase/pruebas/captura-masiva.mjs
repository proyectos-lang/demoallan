/**
 * Capturar por totales el padrón entero de un sorteo, de una vez.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que NO SE TOQUE LA VENTA DEL VENDEDOR. Sus tickets con números son otra
 *     fuente y conviven con la captura. Si el guardado masivo los rozara,
 *     estaría borrando la venta de alguien al teclear su hoja, y eso no se
 *     descubre hasta que él reclama.
 *
 *   · Que una fila EN BLANCO no anule lo ya capturado. Dejar un hueco vacío es
 *     «no tengo su hoja», no «vendió cero».
 *
 *   · Que lo ya capturado se CORRIJA en vez de chocar contra el unique, y que
 *     lo que no cambió no se toque.
 *
 *   · Que sea TODO O NADA: si una fila falla, no se guarda ninguna. Media
 *     matriz guardada no la sabría reconstruir nadie.
 *
 *   · Que se teclee lo APOSTADO y se guarde lo PAGADO, multiplicado por el
 *     factor de cada vendedor —que no es el mismo para todos—.
 *
 *     node supabase/pruebas/captura-masiva.mjs
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

const FECHA = "2031-04-22";
const NOMBRE = "ZZZ Masiva";

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

  // Factores DISTINTOS: el premio pagado sale de multiplicar por el de cada
  // uno, y con el mismo factor para todos un error de asignación no se vería.
  const crear = async (sufijo, factor) => {
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
      p_factor_pago: factor,
      p_tope_por_numero: 500000,
      p_alias: null,
    });
    if (error) throw new Error(`${sufijo}: ${error.message}`);
    return data[0].vendedor_id;
  };

  const uno = await crear("UNO", 70);
  const dos = await crear("DOS", 80);
  const conVenta = await crear("CONVENTA", 70);

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
  const sorteo = sorteos[0];
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteo.id, p_limite_por_numero: 500000 });

  // Uno de ellos vende por su TELÉFONO: eso es lo que no se puede tocar.
  const { data: tanda, error: eVenta } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteo.id,
    p_vendedor_id: conVenta,
    p_tickets: [[{ numero: 7, monto: 900 }]],
    p_forzar: true,
    p_usuario_id: admin.id,
  });
  if (eVenta) throw new Error(`vender: ${eVenta.message}`);

  // --- La matriz trae el padrón con lo que hay --------------------------------
  console.log("--- La matriz ---");
  const { data: matriz, error: eM } = await sb.rpc("fn_matriz_totales", {
    p_sorteo_id: sorteo.id,
  });
  check("la matriz responde", !eM, eM?.message ?? "");

  const mios = (matriz ?? []).filter((f) => f.r_vendedor.startsWith(NOMBRE));
  check("trae a los tres vendedores de prueba", mios.length === 3, `${mios.length}`);
  check(
    "y a todo el padrón activo, no sólo a los que tienen captura",
    (matriz ?? []).length > 3,
    `${(matriz ?? []).length} filas`,
  );

  const filaConVenta = mios.find((f) => f.r_vendedor_id === conVenta);
  check(
    "dice quién vendió por su teléfono",
    Number(filaConVenta?.r_venta_propia) === 900 && filaConVenta?.r_tickets === 1,
    `${filaConVenta?.r_venta_propia} en ${filaConVenta?.r_tickets} tickets`,
  );
  check(
    "y que todavía no tiene captura",
    filaConVenta?.r_venta === null,
    String(filaConVenta?.r_venta),
  );

  // --- El primer guardado -----------------------------------------------------
  console.log("\n--- Guardar la matriz ---");
  const { data: r1, error: e1 } = await sb.rpc("fn_capturar_totales_masivo", {
    p_sorteo_id: sorteo.id,
    p_filas: [
      { vendedor_id: uno, venta: 1000, premiado: 20 },   // 20 x 70 = 1400
      { vendedor_id: dos, venta: 2000, premiado: 10 },   // 10 x 80 =  800
      // El tercero se deja EN BLANCO a propósito.
      { vendedor_id: conVenta, venta: 0, premiado: 0 },
    ],
    p_usuario_id: admin.id,
  });
  check("el guardado no da error", !e1, e1?.message ?? "");
  check("crea dos capturas", r1?.[0]?.r_creadas === 2, String(r1?.[0]?.r_creadas));
  check("y suma la venta", Number(r1?.[0]?.r_venta) === 3000, String(r1?.[0]?.r_venta));
  check(
    "EL PREMIO USA EL FACTOR DE CADA UNO: 1400 + 800",
    Number(r1?.[0]?.r_premios) === 2200,
    String(r1?.[0]?.r_premios),
  );

  const { data: guardadas } = await sb
    .from("venta_total")
    .select("vendedor_id, venta, premios")
    .eq("sorteo_id", sorteo.id)
    .is("anulado_en", null);
  check("la fila en blanco NO se registró", (guardadas ?? []).length === 2,
        `${(guardadas ?? []).length} capturas`);

  // --- LO QUE MÁS IMPORTA: la venta del vendedor no se toca --------------------
  console.log("\n--- La venta del vendedor sigue intacta ---");
  const { data: tk } = await sb
    .from("ticket")
    .select("id, total, anulado_en")
    .eq("folio", tanda[0].r_folio)
    .single();
  check("su ticket sigue vivo", tk.anulado_en === null, String(tk.anulado_en));
  check("con su total", Number(tk.total) === 900, String(tk.total));

  const { data: ls } = await sb.from("linea").select("monto").eq("ticket_id", tk.id);
  check(
    "y sus líneas sin tocar",
    (ls ?? []).length === 1 && Number(ls[0].monto) === 900,
    JSON.stringify(ls),
  );

  // --- Corregir: se vuelve a guardar la misma matriz ---------------------------
  console.log("\n--- Guardar otra vez, con una cifra corregida ---");
  const { data: r2, error: e2 } = await sb.rpc("fn_capturar_totales_masivo", {
    p_sorteo_id: sorteo.id,
    p_filas: [
      { vendedor_id: uno, venta: 1500, premiado: 20 },   // cambia la venta
      { vendedor_id: dos, venta: 2000, premiado: 10 },   // igual que antes
    ],
    p_usuario_id: admin.id,
  });
  check("no choca contra el unique", !e2, e2?.message ?? "");
  check("corrige una", r2?.[0]?.r_corregidas === 1, String(r2?.[0]?.r_corregidas));
  check("y deja la otra en paz", r2?.[0]?.r_sin_cambio === 1, String(r2?.[0]?.r_sin_cambio));
  check("sin crear nada nuevo", r2?.[0]?.r_creadas === 0, String(r2?.[0]?.r_creadas));

  const { data: tras } = await sb
    .from("venta_total")
    .select("venta")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", uno)
    .is("anulado_en", null)
    .single();
  check("la cifra corregida quedó", Number(tras.venta) === 1500, String(tras.venta));

  // --- La fila en blanco no anula lo ya capturado -----------------------------
  console.log("\n--- Una fila en blanco no borra lo que había ---");
  const { error: e3 } = await sb.rpc("fn_capturar_totales_masivo", {
    p_sorteo_id: sorteo.id,
    p_filas: [
      { vendedor_id: uno, venta: 0, premiado: 0 },   // se deja vacía
      { vendedor_id: dos, venta: 2000, premiado: 10 },
    ],
    p_usuario_id: admin.id,
  });
  check("se guarda sin error", !e3, e3?.message ?? "");

  const { data: sigue } = await sb
    .from("venta_total")
    .select("venta")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", uno)
    .is("anulado_en", null)
    .maybeSingle();
  check(
    "SU CAPTURA SIGUE AHÍ: una fila vacía es «no tengo su hoja»",
    sigue !== null && Number(sigue.venta) === 1500,
    JSON.stringify(sigue),
  );

  // --- Todo o nada ------------------------------------------------------------
  console.log("\n--- Si una fila falla, no se guarda ninguna ---");
  const { data: antesDelFallo } = await sb
    .from("venta_total")
    .select("venta")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", dos)
    .is("anulado_en", null)
    .single();

  const { error: eFallo } = await sb.rpc("fn_capturar_totales_masivo", {
    p_sorteo_id: sorteo.id,
    p_filas: [
      { vendedor_id: dos, venta: 9999, premiado: 0 },
      // Un vendedor que no existe: la fila 2 revienta.
      { vendedor_id: "00000000-0000-0000-0000-000000000000", venta: 100, premiado: 0 },
    ],
    p_usuario_id: admin.id,
  });
  check("el guardado se rechaza", !!eFallo, eFallo ? "" : "no dio error");

  const { data: trasFallo } = await sb
    .from("venta_total")
    .select("venta")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", dos)
    .is("anulado_en", null)
    .single();
  check(
    "y NO se guardó la fila buena que iba antes",
    Number(trasFallo.venta) === Number(antesDelFallo.venta),
    `${trasFallo.venta}, era ${antesDelFallo.venta}`,
  );

  // --- La matriz refleja lo guardado ------------------------------------------
  console.log("\n--- La matriz vuelve a abrir con lo que hay ---");
  const { data: matriz2 } = await sb.rpc("fn_matriz_totales", { p_sorteo_id: sorteo.id });
  const fUno = (matriz2 ?? []).find((f) => f.r_vendedor_id === uno);
  check("trae la venta guardada", Number(fUno?.r_venta) === 1500, String(fUno?.r_venta));
  check(
    "y lo APOSTADO, no lo pagado: 1400 ÷ 70 = 20",
    Number(fUno?.r_premiado) === 20,
    String(fUno?.r_premiado),
  );

  // --- Y queda en auditoría con su autor --------------------------------------
  console.log("\n--- Con quién lo hizo ---");
  const { data: cap } = await sb
    .from("venta_total")
    .select("id")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", uno)
    .single();
  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, valor_anterior, valor_nuevo, usuario_id")
    .eq("entidad_id", cap.id);
  check("hay apuntes de auditoría", (aud ?? []).length >= 2, `${(aud ?? []).length}`);
  check(
    "todos con autor",
    (aud ?? []).every((a) => a.usuario_id === admin.id),
    JSON.stringify((aud ?? []).map((a) => a.usuario_id)),
  );
  const corr = (aud ?? []).find((a) => a.accion === "editar" && a.valor_anterior === "1000.00");
  check(
    "y la corrección guarda de qué a qué",
    !!corr && corr.valor_nuevo === "1500",
    JSON.stringify(corr),
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
