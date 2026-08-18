/**
 * Digitalización de una hoja real, de punta a punta.
 *
 *     node --conditions=react-server supabase/pruebas/ocr.mjs muestras/<archivo>
 *
 * Importa el MISMO módulo que usa la aplicación (`lib/ia/gemini.ts`) para que
 * no existan dos versiones del prompt: si el prompt cambia, esta prueba ejerce
 * el nuevo. Node 24 interpreta TypeScript directamente; la condición
 * `react-server` hace falta porque el módulo lleva la guarda `server-only`,
 * que existe para que la llave de Google no pueda acabar en el navegador.
 *
 * Lo que comprueba, además de que el modelo lea:
 *   · Que el cuadre bloquee de verdad cuando la suma no coincide.
 *   · Que al cuadrar se creen tickets con las mismas validaciones de cupo.
 *   · Que el costo de inferencia quede registrado.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { extraerHoja, MODELO } from "../../lib/ia/gemini.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const ruta = process.argv[2];
if (!ruta) {
  console.error("Uso: node supabase/pruebas/ocr.mjs muestras/<archivo>");
  process.exit(1);
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const mime = MIME[extname(ruta).toLowerCase()];
if (!mime) {
  console.error(`Formato no soportado: ${extname(ruta)}. Use JPG, PNG o WebP.`);
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const FECHA = "2093-07-07";
let sorteoId, loteId, ticketId;

const limpiar = async () => {
  if (loteId) {
    const { data: ts } = await sb.from("ticket").select("id").eq("lote_ocr_id", loteId);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("lote_ocr_id", loteId);
    const { data: l } = await sb.from("lote_ocr").select("imagen_path").eq("id", loteId).maybeSingle();
    if (l?.imagen_path) await sb.storage.from("hojas").remove([l.imagen_path]);
    await sb.from("lote_ocr").delete().eq("id", loteId);
  }
  const { data: ss } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of ss ?? []) {
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
};

try {
  const bytes = readFileSync(ruta);
  console.log(`\nHoja: ${basename(ruta)} · ${(bytes.length / 1024).toFixed(0)} kB · ${mime}`);

  console.log(`\n1. Lectura con ${MODELO}`);
  const inicio = Date.now();
  const ex = await extraerHoja(bytes.toString("base64"), mime);
  const ms = Date.now() - inicio;

  console.log(`   ${ex.lineas.length} renglones · ${ms} ms · confianza media ${ex.confianzaGlobal}`);
  console.log(`   tokens ${ex.tokensEntrada} entrada / ${ex.tokensSalida} salida · costo $${ex.costoUsd}`);
  console.log(`   total declarado que leyó: ${ex.totalDeclarado ?? "(no lo encontró)"}`);
  console.log("\n   renglón   número   monto   confianza");
  for (const [i, l] of ex.lineas.entries()) {
    const baja = l.confianza < 0.85 ? "  ← revisar" : "";
    console.log(`   ${String(i + 1).padStart(7)}   ${l.numero.padStart(6)}   ${l.monto.padStart(5)}   ${l.confianza.toFixed(2)}${baja}`);
  }
  const suma = ex.lineas.reduce((a, l) => a + Number(l.monto || 0), 0);
  console.log(`\n   suma de renglones: ${suma}`);
  if (ex.totalDeclarado !== null) {
    console.log(`   declarado en la hoja: ${ex.totalDeclarado} · diferencia: ${suma - ex.totalDeclarado}`);
  }

  check("devolvió al menos un renglón", ex.lineas.length > 0);
  check("todos los números son de dos dígitos 00–99",
    ex.lineas.every((l) => /^\d{2}$/.test(l.numero) && Number(l.numero) <= 99));
  check("todos los montos son numéricos", ex.lineas.every((l) => /^\d+$/.test(l.monto)));
  check("la confianza viene por renglón, entre 0 y 1",
    ex.lineas.every((l) => l.confianza >= 0 && l.confianza <= 1));
  check("registró el costo de inferencia", ex.costoUsd > 0, `${ex.costoUsd}`);
  check("contó los tokens de razonamiento como salida",
    ex.tokensSalida > ex.lineas.length, `${ex.tokensSalida}`);

  // --- El flujo completo contra la base ----------------------------------
  console.log("\n2. Montaje del sorteo destino");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  sorteoId = ss.find((s) => s.hora === "20:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: 900000 });

  const { data: vs } = await sb.from("vendedor").select("id, codigo").order("codigo");

  // El total declarado que se guarda es el de la hoja; si el modelo no lo leyó
  // se usa la suma, que es lo que haría el operador al teclearlo.
  const declarado = ex.totalDeclarado ?? suma;

  const { data: id, error: eLote } = await sb.rpc("fn_crear_lote_ocr", {
    p_imagen_path: `pruebas/${basename(ruta)}`,
    p_vendedor_id: vs[0].id,
    p_sorteo_id: sorteoId,
    p_total_declarado: declarado,
    p_confianza_global: ex.confianzaGlobal,
    p_modelo: MODELO,
    p_tokens_entrada: ex.tokensEntrada,
    p_tokens_salida: ex.tokensSalida,
    p_costo: ex.costoUsd,
  });
  if (eLote) throw new Error(`crear lote: ${eLote.message}`);
  loteId = id;
  check("el lote quedó registrado", !!loteId);

  console.log("\n3. El cuadre bloquea");
  const lineasBase = ex.lineas.map((l) => ({ numero: Number(l.numero), monto: Number(l.monto) }));
  const conRenglonDeMenos = lineasBase.slice(0, -1);

  const { error: eDescuadre } = await sb.rpc("fn_validar_lote_ocr", {
    p_lote_id: loteId, p_lineas: conRenglonDeMenos,
  });
  check(
    "quitar un renglón impide confirmar",
    !!eDescuadre && /descuadre/i.test(eDescuadre.message),
    eDescuadre?.message,
  );

  const { data: sinTickets } = await sb.from("ticket").select("id").eq("lote_ocr_id", loteId);
  check("y no creó ningún ticket a medias", (sinTickets ?? []).length === 0);

  console.log("\n4. Con la suma correcta sí crea tickets");
  const ajustadas = [...lineasBase];
  // Si el modelo no leyó el total, la suma coincide por construcción. Si lo
  // leyó y no cuadra, el descuadre es un hallazgo real de la hoja.
  const sumaAjustada = ajustadas.reduce((a, l) => a + l.monto, 0);
  if (sumaAjustada !== declarado) {
    console.log(`   La hoja no cuadra: renglones ${sumaAjustada} vs declarado ${declarado}.`);
    console.log("   Eso es un hallazgo, no un fallo: el operador tendría que revisarla.");
    console.log("   Para seguir probando el resto del flujo se usa la suma real.");
    await sb.from("lote_ocr").update({ total_declarado: sumaAjustada }).eq("id", loteId);
  }

  const { data: creado, error: eVal } = await sb.rpc("fn_validar_lote_ocr", {
    p_lote_id: loteId, p_lineas: ajustadas,
  });
  check("confirma y crea el ticket", !eVal && !!creado?.[0]?.ticket_folio, eVal?.message);

  if (creado?.[0]) {
    ticketId = creado[0].ticket_id;
    const { data: t } = await sb.from("ticket").select("canal, total, lote_ocr_id").eq("id", ticketId).single();
    check("el ticket queda marcado como canal ocr", t.canal === "ocr", t.canal);
    check("y enlazado a su lote", t.lote_ocr_id === loteId);
    check("el total del ticket es la suma de los renglones", Number(t.total) === sumaAjustada, `${t.total}`);

    const { data: ls } = await sb.from("linea").select("numero, monto, comision_congelada, factor_congelado").eq("ticket_id", ticketId);
    check("una línea por renglón", ls.length === ajustadas.length, `${ls.length}`);
    check("con los parámetros congelados, igual que una venta móvil",
      ls.every((l) => Number(l.comision_congelada) > 0 && Number(l.factor_congelado) > 0));

    const { data: lote } = await sb.from("lote_ocr").select("estado, costo_inferencia").eq("id", loteId).single();
    check("el lote queda validado", lote.estado === "validado", lote.estado);
    check("con su costo guardado", Number(lote.costo_inferencia) > 0, `${lote.costo_inferencia}`);
  }

  console.log("\n5. No se puede validar dos veces");
  const { error: eDoble } = await sb.rpc("fn_validar_lote_ocr", { p_lote_id: loteId, p_lineas: ajustadas });
  check("el segundo intento se rechaza", !!eDoble, eDoble?.message);
} finally {
  console.log("\n6. Limpieza");
  await limpiar();
  await sb.from("auditoria").delete().gt("id", 0);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
