/**
 * Renderizado real de las pantallas, con sesión.
 *
 * Inicia sesión, arma la cookie con el formato de @supabase/ssr y pide cada
 * página por HTTP para comprobar que el servidor las sirve completas. Cubre lo
 * que ni el typecheck ni el build ven: errores de consulta en tiempo de
 * ejecución y ramas que sólo aparecen con datos.
 *
 *     BASE=http://localhost:3001 PW=<clave-admin> node supabase/pruebas/render.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const BASE = process.env.BASE ?? "http://localhost:3000";
const CLAVE = process.env.PW;
if (!CLAVE) {
  console.error("Falta PW=<clave del administrador>");
  process.exit(1);
}

const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await sb.auth.signInWithPassword({
  email: "admin@eldiario.hn",
  password: CLAVE,
});
if (error) {
  console.error("No se pudo iniciar sesión:", error.message);
  process.exit(1);
}

/**
 * @supabase/ssr guarda la sesión como `base64-<json en base64>`, troceada en
 * cookies `.0`, `.1`… cuando pasa del tamaño máximo de una cookie.
 */
const valor = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64");
const TROZO = 3180;
const trozos = [];
for (let i = 0; i < valor.length; i += TROZO) trozos.push(valor.slice(i, i + TROZO));

const cookie =
  trozos.length === 1
    ? `sb-${ref}-auth-token=${trozos[0]}`
    : trozos.map((t, i) => `sb-${ref}-auth-token.${i}=${t}`).join("; ");

const RUTAS = [
  ["/tablero", ["Tablero"]],
  ["/punto-de-venta", ["Punto de venta"]],
  ["/resultados", ["Sorteos y resultados"]],
  ["/vendedores", ["Vendedores y límites", "María F. Cruz", "EXPOSICIÓN"]],
  ["/reportes", ["Reportes"]],
  ["/control", ["Control de vendedores"]],
  ["/geo", ["Geo-referenciación"]],
  ["/simulador", ["Simulador"]],
  ["/digitalizacion", ["Digitalización"]],
];

let ok = 0, fallos = 0;

for (const [ruta, esperados] of RUTAS) {
  const r = await fetch(BASE + ruta, { headers: { cookie }, redirect: "manual" });
  const html = r.status === 200 ? await r.text() : "";

  if (r.status !== 200) {
    fallos++;
    console.log(`  FALLA ${ruta.padEnd(18)} http=${r.status} ${r.headers.get("location") ?? ""}`);
    continue;
  }

  const faltan = esperados.filter((t) => !html.includes(t));
  // Next inyecta el mensaje de error en el HTML cuando una página revienta.
  const reventó = /Application error|Internal Server Error/i.test(html);

  if (faltan.length || reventó) {
    fallos++;
    console.log(`  FALLA ${ruta.padEnd(18)} ${reventó ? "error de servidor" : "falta: " + faltan.join(", ")}`);
  } else {
    ok++;
    console.log(`  ok    ${ruta.padEnd(18)} ${(html.length / 1024).toFixed(0)} kB`);
  }
}

// La barra lateral debe aparecer en todas.
const shell = await fetch(BASE + "/tablero", { headers: { cookie } });
const htmlShell = await shell.text();
for (const t of ["Lotería El Diario", "OPERACIÓN", "ANÁLISIS", "CONFIGURACIÓN", "Administrador"]) {
  if (htmlShell.includes(t)) { ok++; console.log(`  ok    shell: ${t}`); }
  else { fallos++; console.log(`  FALLA shell: falta ${t}`); }
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
