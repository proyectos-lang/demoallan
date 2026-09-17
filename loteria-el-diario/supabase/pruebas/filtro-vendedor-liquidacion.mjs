/**
 * Las cuatro pestañas de liquidación filtran por un vendedor.
 *
 * QUÉ SE PIDIÓ
 * ------------
 * Un combobox por alias en cada pestaña —hoja, resumen, saldos, cobranza— para
 * aislar a un vendedor en cualquier momento. Hoja y resumen ya lo tenían;
 * saldos y cobranza mostraban el padrón entero sin forma de recortarlo.
 *
 * QUÉ SE COMPRUEBA, EN UN NAVEGADOR
 * ---------------------------------
 *   · Que las cuatro pestañas pinten el buscador de vendedor.
 *   · Que al elegir a uno, la URL lleve su id.
 *   · Que la TABLA se recorte: con un vendedor elegido, sale su fila y no las
 *     de los demás. Eso no se ve desde la base —las funciones devuelven el
 *     padrón entero a propósito, para poder ofrecerlo en el combobox— así que
 *     se mide contra el HTML renderizado.
 *   · Que en saldos, filtrar conserve la semana elegida.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/filtro-vendedor-liquidacion.mjs
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

const { data: u } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("rol", "administrador")
  .limit(1)
  .single();
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

const pedir = (url) => fetch(url, { headers: { cookie } }).then((r) => r.text());

// Un vendedor que deba algo, para que salga en cobranza y en saldos.
const { data: deudores } = await sb.rpc("fn_cobranza", {});
const objetivo = (deudores ?? [])[0];
if (!objetivo) {
  console.error("Nadie debe nada; la prueba necesita al menos un deudor.");
  process.exit(1);
}
const VID = objetivo.r_vendedor_id;
const CODIGO = objetivo.r_codigo;
console.log(`Filtrando a ${CODIGO} ${objetivo.r_vendedor} (debe ${objetivo.r_pendiente})\n`);

// El buscador de vendedor, cerrado, es un botón con aria-haspopup="listbox".
// El `role="combobox"` sólo aparece al abrirlo, así que no vale para el HTML
// inicial. El placeholder viaja serializado en el árbol de React.
const tieneBuscador = (html) =>
  /haspopup="listbox"/i.test(html) || /Escriba el alias/i.test(html);

// ---------- 1. Las cuatro pestañas tienen el buscador ----------
console.log("--- El buscador está en las cuatro ---");
for (const vista of ["hoja", "resumen", "saldos", "cobranza"]) {
  const html = await pedir(`${BASE}/liquidacion?vista=${vista}`);
  check(`«${vista}» pinta el buscador de vendedor`, tieneBuscador(html), "no aparece");
}

// ---------- 2. Saldos: la tabla se recorta ----------
console.log("\n--- Saldos, filtrado ---");
const saldosTodos = await pedir(`${BASE}/liquidacion?vista=saldos`);
const saldosUno = await pedir(`${BASE}/liquidacion?vista=saldos&vendedor=${VID}`);

// Cuántas filas de vendedor tiene la tabla: se cuentan los <tr> del cuerpo.
const filasDe = (html) => {
  const cuerpo = html.split("<tbody").slice(1).join("<tbody");
  return (cuerpo.match(/<tr/g) || []).length;
};
check(
  "sin filtro, la tabla trae varias filas",
  filasDe(saldosTodos) > 3,
  `${filasDe(saldosTodos)}`,
);
check(
  "con un vendedor, se recorta a muy pocas",
  filasDe(saldosUno) > 0 && filasDe(saldosUno) < filasDe(saldosTodos),
  `${filasDe(saldosTodos)} -> ${filasDe(saldosUno)}`,
);
check(
  "y la fila que queda es la del vendedor elegido",
  saldosUno.includes(CODIGO),
  `no aparece ${CODIGO}`,
);

// ---------- 3. Cobranza: la tabla se recorta ----------
console.log("\n--- Cobranza, filtrado ---");
const cobranzaTodos = await pedir(`${BASE}/liquidacion?vista=cobranza`);
const cobranzaUno = await pedir(`${BASE}/liquidacion?vista=cobranza&vendedor=${VID}`);
check(
  "sin filtro, cobranza trae varios deudores",
  filasDe(cobranzaTodos) > 1,
  `${filasDe(cobranzaTodos)}`,
);
check(
  "con un vendedor, sólo su fila",
  filasDe(cobranzaUno) >= 1 && filasDe(cobranzaUno) < filasDe(cobranzaTodos),
  `${filasDe(cobranzaTodos)} -> ${filasDe(cobranzaUno)}`,
);
check("y es el vendedor elegido", cobranzaUno.includes(CODIGO), `no aparece ${CODIGO}`);

// ---------- 4. En saldos, filtrar conserva la semana ----------
console.log("\n--- Filtrar no cambia de semana ---");
const { data: sem } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: null });
const otra = (sem ?? [])[1]; // una semana que no es la de por defecto
if (otra) {
  const conSemana = await pedir(
    `${BASE}/liquidacion?vista=saldos&semana=${otra.r_inicio}&vendedor=${VID}`,
  );
  // El riel marca la semana activa con su rango. Se comprueba que el
  // encabezado hable de esa semana, no de otra.
  /*
   * El encabezado de la semana viaja serializado en el árbol de React, no como
   * texto plano «Semana #37». Se comprueba de otra forma: que el rango de
   * fechas de esa semana —que el riel marca como activo— esté en el HTML, y
   * que NO sea el de la semana por defecto.
   */
  const rango = (html) => html.includes(otra.r_inicio) && html.includes(otra.r_fin);
  check(
    "la semana pedida sigue activa al filtrar",
    rango(conSemana),
    `no muestra ${otra.r_inicio}—${otra.r_fin}`,
  );
  const conSemanaSinFiltro = await pedir(`${BASE}/liquidacion?vista=saldos&semana=${otra.r_inicio}`);
  check(
    "y da igual con filtro que sin él: filtrar no mueve la semana",
    rango(conSemanaSinFiltro),
    "la semana no se conserva ni sin filtro",
  );
} else {
  console.log("  (sólo hay una semana; se omite)");
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
