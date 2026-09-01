/**
 * La pantalla de análisis, servida de verdad, con la dirección manipulada.
 *
 * `analisis.mjs` prueba que las cifras cuadren; esta prueba el otro lado: que
 * la página aguante lo que le llegue por la URL. Los filtros de este módulo
 * viven en la dirección —es lo que permite compartir una vista por chat— y eso
 * significa que cualquiera puede escribir ahí lo que se le ocurra.
 *
 * QUÉ CAZÓ ESTA PRUEBA
 * --------------------
 * El padrón de vendedores y la consulta salían en un `Promise.all`, así que el
 * `?vendedor=` de la dirección viajaba a la base ANTES de compararse con la
 * lista real. Con un id que no era un uuid, postgres rechazaba la consulta y
 * la pantalla entera quedaba en «No se pudo cargar el análisis». El comentario
 * del código ya decía que un id inventado no debía pasar; la comprobación
 * simplemente corría después. Ahora el padrón va primero.
 *
 * No usa contraseña: firma la cookie de sesión con el mismo HMAC que el
 * servidor, igual que `render.mjs`. Necesita `npm run dev` levantado.
 *
 *     node supabase/pruebas/pantalla-analisis.mjs
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "allan" }, auth: { persistSession: false } });
const { data: u } = await sb.from("usuario").select("id, nombre, rol").eq("rol", "administrador").limit(1);
const secreto = env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
  ? env.SESION_SECRETO
  : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY).update("sesion:diario").digest("base64url");
const cuerpo = Buffer.from(JSON.stringify({
  id: u[0].id, nombre: u[0].nombre, rol: u[0].rol, vendedor_id: null,
  exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
const cookie = `diario_sesion=${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;

const CASOS = [
  ["mes por defecto", "/analisis"],
  ["agosto sorteo a sorteo", "/analisis?desde=2026-08-01&hasta=2026-08-19&grano=sorteo"],
  ["año sorteo a sorteo", "/analisis?desde=2026-01-01&hasta=2026-12-31&grano=sorteo"],
  ["agosto día a día", "/analisis?desde=2026-08-01&hasta=2026-08-19&grano=dia"],
  ["agosto semana a semana", "/analisis?desde=2026-08-01&hasta=2026-08-19&grano=semana"],
  ["semana cortada", "/analisis?desde=2026-08-05&hasta=2026-08-19&grano=semana"],
  ["una lotería", "/analisis?desde=2026-08-01&hasta=2026-08-19&grano=dia&hora=15:00"],
  ["rango vacío", "/analisis?desde=2099-01-01&hasta=2099-01-31&grano=dia"],
  ["grano inventado", "/analisis?desde=2026-08-01&hasta=2026-08-19&grano=trimestre"],
  ["vendedor inventado", "/analisis?desde=2026-08-01&hasta=2026-08-19&vendedor=no-es-un-uuid"],
  ["fechas al revés", "/analisis?desde=2026-08-19&hasta=2026-08-01&grano=dia"],
];
let fallos = 0;
for (const [n, ruta] of CASOS) {
  const r = await fetch("http://localhost:3000" + ruta, { headers: { cookie }, redirect: "manual" });
  const html = r.status === 200 ? await r.text() : "";
  const revento = /Application error|Internal Server Error|No se pudo cargar/i.test(html);
  const titulo = html.includes("Análisis de resultados");
  const tarjetas = (html.match(/Utilidad neta/g) ?? []).length;
  const vacio = html.includes("No hay ningún sorteo liquidado");
  const topado = /Se dibujan las primeras/.test(html);
  if (r.status !== 200 || revento || !titulo) { fallos++; console.log(`  FALLA ${n.padEnd(24)} http=${r.status} ${revento ? "reventó" : !titulo ? "sin título" : ""}`); }
  else console.log(`  ok    ${n.padEnd(24)} ${String(tarjetas).padStart(2)} tarjetas${vacio ? " (aviso de vacío)" : ""}${topado ? " (topado)" : ""}  ${(html.length / 1024).toFixed(0)} kB`);
}
console.log(fallos ? `\n=== ${fallos} fallos ===` : "\n=== todo servido ===");
process.exit(fallos ? 1 : 0);
