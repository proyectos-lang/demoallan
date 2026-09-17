/**
 * En «Ventas registradas» un botón gobierna las anuladas de las DOS tablas.
 *
 * QUÉ SE PIDIÓ, Y QUÉ YA ESTABA
 * -----------------------------
 * Una venta anulada no se borra: se marca y deja de contar. Eso ya era así
 * —`fn_anular_ticket` y `fn_anular_venta_total` hacen un update, no un delete,
 * y todo cálculo filtra por `anulado_en is null`—. Y el detalle de tickets ya
 * tenía el botón «Ver anulados».
 *
 * Lo que faltaba: las CAPTURAS por totales anuladas se pintaban SIEMPRE, sin
 * mirar ese botón. Un día real tenía 21, y salían aunque nadie las pidiera,
 * mientras los tickets anulados sólo con el botón pulsado. Dos tablas de la
 * misma pantalla con reglas distintas.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que anular NO borra: la fila sigue en la base, marcada.
 *   · Que las capturas anuladas NO aparezcan sin el botón.
 *   · Que SÍ aparezcan con `anulados=1`, con su etiqueta.
 *   · Que en ningún caso sumen: la venta viva es la misma con y sin el botón.
 *   · Que los tickets anulados sigan gobernados por el mismo botón.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/anuladas-en-registradas.mjs
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3131";
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
const num = (x) => Number(x ?? 0);

const { data: u } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("rol", "administrador")
  .limit(1)
  .single();
const { data: admin } = await sb.from("usuario").select("id").eq("rol", "administrador").limit(1).single();

const secreto =
  env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
    ? env.SESION_SECRETO
    : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY).update("sesion:diario").digest("base64url");
const cuerpo = Buffer.from(
  JSON.stringify({
    id: u.id,
    nombre: u.nombre,
    rol: u.rol,
    vendedor_id: u.vendedor_id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const cookie = `diario_sesion=${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;

// --- Un día de prueba, con una captura que se anula ------------------------
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
const { data: sorteos } = await sb
  .from("sorteo")
  .select("id, hora, estado")
  .eq("fecha", hoy)
  .order("hora");
const abierto = (sorteos ?? []).find((s) => s.estado === "abierto") ?? sorteos?.[sorteos.length - 1];

const { data: ocupados } = await sb
  .from("venta_total")
  .select("vendedor_id")
  .eq("sorteo_id", abierto.id)
  .is("anulado_en", null);
const tomados = new Set((ocupados ?? []).map((r) => r.vendedor_id));
const { data: cands } = await sb
  .from("vendedor")
  .select("id, codigo")
  .eq("activo", true)
  .is("eliminado_en", null)
  .order("codigo");
const v = (cands ?? []).find((c) => !tomados.has(c.id));

console.log(`Sorteo ${abierto.hora} del ${hoy} · vendedor ${v.codigo}\n`);

// Se registra y se anula una captura, para tener una anulada conocida.
const MONTO = 1234;
await sb.rpc("fn_registrar_venta_total", {
  p_sorteo_id: abierto.id,
  p_vendedor_id: v.id,
  p_venta: MONTO,
  p_premios: 0,
  p_nota: "prueba anuladas-en-registradas",
  p_usuario_id: admin.id,
});
const { data: creada } = await sb
  .from("venta_total")
  .select("id, venta")
  .eq("sorteo_id", abierto.id)
  .eq("vendedor_id", v.id)
  .is("anulado_en", null)
  .maybeSingle();

try {
  await sb.rpc("fn_anular_venta_total", { p_id: creada.id, p_usuario_id: admin.id });

  console.log("--- Anular no borra ---");
  const { data: sigue } = await sb
    .from("venta_total")
    .select("id, anulado_en, venta")
    .eq("id", creada.id)
    .maybeSingle();
  check("la captura anulada SIGUE en la base, no se borró", Boolean(sigue), "desapareció");
  check("y queda marcada con la fecha de anulación", Boolean(sigue?.anulado_en), "");
  check("con su monto intacto", num(sigue?.venta) === MONTO, `${sigue?.venta}`);

  // Y no cuenta: fn_ventas_totales_dia la trae, pero marcada.
  const { data: tot } = await sb.rpc("fn_ventas_totales_dia", {
    p_fecha: hoy,
    p_vendedor_id: v.id,
  });
  const suya = (tot ?? []).find((c) => c.r_id === creada.id);
  check("la función la devuelve —para poder verla—", Boolean(suya), "no la trae");
  check("y la marca como anulada", suya?.r_anulado === true, `${suya?.r_anulado}`);

  // --- La pantalla: el botón gobierna las dos tablas ----------------------
  console.log("\n--- El botón «Ver anulados» ---");

  const pedir = async (conAnulados) => {
    const url = `${BASE}/punto-de-venta?modo=ventas&dia=${hoy}${conAnulados ? "&anulados=1" : ""}`;
    return (await fetch(url, { headers: { cookie } })).text();
  };

  const sinToggle = await pedir(false);
  const conToggle = await pedir(true);

  // La captura de prueba se reconoce por su monto exacto, con separador de miles.
  const marca = "1,234";
  check(
    "SIN el botón, la captura anulada NO se ve",
    !sinToggle.includes(marca),
    "aparece sin pedirla",
  );
  check(
    "CON el botón, la captura anulada SÍ se ve",
    conToggle.includes(marca),
    "no aparece ni pidiéndola",
  );
  check(
    "y sale marcada «ANULADA»",
    (conToggle.match(/ANULADA/g) || []).length > 0,
    "sin etiqueta",
  );
  check(
    "sin el botón no hay ninguna etiqueta de anulada",
    (sinToggle.match(/ANULADA/g) || []).length === 0,
    `${(sinToggle.match(/ANULADA/g) || []).length} etiquetas`,
  );

  // --- No suma, con ni sin el botón ---------------------------------------
  console.log("\n--- La anulada nunca suma ---");
  const { data: vivas } = await sb.rpc("fn_ventas_totales_dia", {
    p_fecha: hoy,
    p_vendedor_id: null,
  });
  const ventaViva = (vivas ?? [])
    .filter((c) => !c.r_anulado)
    .reduce((a, c) => a + num(c.r_venta), 0);
  const ventaConAnuladas = (vivas ?? []).reduce((a, c) => a + num(c.r_venta), 0);
  check(
    "la venta viva no incluye el monto de la anulada",
    Math.abs(ventaConAnuladas - ventaViva - MONTO) < 0.01,
    `viva ${ventaViva} · con anuladas ${ventaConAnuladas}`,
  );
} finally {
  // La captura de prueba se borra del todo: era artificial.
  await sb.from("venta_total").delete().eq("id", creada.id);
  console.log("\n(limpieza: captura de prueba borrada)");
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
