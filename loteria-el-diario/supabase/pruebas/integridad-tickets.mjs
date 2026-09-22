/**
 * Integridad de los tickets: cada tirilla que se imprime tiene que concordar al
 * 100% con lo que hay en la base.
 *
 * LA REGLA DEL NEGOCIO
 * --------------------
 * Bajo ninguna circunstancia se imprime un ticket sin su registro exacto. Esta
 * prueba lo comprueba sobre TODA la base: recorre cada ticket y verifica que
 *
 *   · tiene FOLIO (sin folio no hay registro);
 *   · su folio es ÚNICO (nadie comparte folio);
 *   · su código de barras es ÚNICO (es lo que identifica al ticket físico);
 *   · su TOTAL es exactamente la suma de sus líneas (cantidad y monto cuadran).
 *
 * Si algo de esto falla, hay un ticket cuyo papel podría no coincidir con el
 * sistema, y eso es justo lo que no puede pasar.
 *
 * OJO CON EL TOPE DE FILAS DE LA API
 * ----------------------------------
 * Las líneas se leen en lotes PEQUEÑOS de tickets (25), porque un `.in(...)`
 * con muchos ids trae más de 1000 líneas y PostgREST las trunca —y entonces a
 * los últimos tickets del lote les «faltarían» líneas que sí existen, dando un
 * falso descuadre. Es el mismo tope que arregló la 0105.
 *
 *     node supabase/pruebas/integridad-tickets.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" }, auth: { persistSession: false },
});

let ok = 0, fallos = 0;
const check = (n, c, d = "") => { if (c) { ok++; console.log(`  ok    ${n}`); } else { fallos++; console.log(`  FALLA ${n} ${d}`); } };
const cent = (n) => Math.round(Number(n) * 100);

// Todos los tickets.
let ticks = [], d = 0;
while (true) {
  const { data } = await sb.from("ticket").select("id, folio, total, codigo_barras").range(d, d + 999);
  if (!data || !data.length) break;
  ticks = ticks.concat(data);
  if (data.length < 1000) break;
  d += 1000;
}
console.log(`\nTickets en la base: ${ticks.length}\n`);
check("hay tickets que verificar", ticks.length > 0);

// 1. Folio presente y único.
const sinFolio = ticks.filter((t) => !t.folio || !t.folio.trim());
check("todos los tickets tienen folio", sinFolio.length === 0, `${sinFolio.length} sin folio`);
const cf = new Map();
for (const t of ticks) cf.set(t.folio, (cf.get(t.folio) ?? 0) + 1);
const folioDup = [...cf].filter(([, n]) => n > 1);
check("ningún folio está duplicado", folioDup.length === 0, folioDup.slice(0, 5).map(([f]) => f).join(", "));

// 2. Código de barras único (los que lo tienen).
const cb = new Map();
for (const t of ticks) if (t.codigo_barras) cb.set(t.codigo_barras, (cb.get(t.codigo_barras) ?? 0) + 1);
const barrasDup = [...cb].filter(([, n]) => n > 1);
check("ningún código de barras está duplicado", barrasDup.length === 0, barrasDup.slice(0, 5).map(([b]) => b).join(", "));

// 3. total == suma(líneas), en TODOS. Lotes pequeños por el tope de filas.
let descuadrados = [], sinLineas = 0;
for (let i = 0; i < ticks.length; i += 25) {
  const lote = ticks.slice(i, i + 25);
  const ids = lote.map((t) => t.id);
  const { data: ls } = await sb.from("linea").select("ticket_id, monto").in("ticket_id", ids);
  const suma = new Map(), cnt = new Map();
  for (const l of ls ?? []) {
    suma.set(l.ticket_id, (suma.get(l.ticket_id) ?? 0) + Number(l.monto));
    cnt.set(l.ticket_id, (cnt.get(l.ticket_id) ?? 0) + 1);
  }
  for (const t of lote) {
    // Un ticket con monto y sin detalle es lo grave: un papel con total pero
    // sin las apuestas que lo componen.
    if (!cnt.get(t.id) && cent(t.total) > 0) sinLineas++;
    const s = suma.get(t.id) ?? 0;
    if (cent(s) !== cent(t.total)) descuadrados.push(`${t.folio}: total=${t.total} suma=${s}`);
  }
  if (i % 5000 === 0) process.stdout.write(`\r  verificando líneas ${i}/${ticks.length}`);
}
process.stdout.write("\r".padEnd(40) + "\r");
check("ningún ticket tiene total > 0 sin líneas", sinLineas === 0, `${sinLineas} sin líneas`);
check(
  "el total de cada ticket es la suma exacta de sus líneas",
  descuadrados.length === 0,
  `${descuadrados.length} descuadrados · ${descuadrados.slice(0, 5).join(" | ")}`,
);

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
