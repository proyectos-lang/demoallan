/**
 * Renderizado real de las pantallas, con sesión.
 *
 * Inicia sesión, arma la cookie y pide cada página por HTTP para comprobar que
 * el servidor las sirve completas. Cubre lo que ni el typecheck ni el build
 * ven: errores de consulta en tiempo de ejecución y ramas que sólo aparecen
 * con datos.
 *
 *     BASE=http://localhost:3000 USUARIO=admin PW=<clave> node supabase/pruebas/render.mjs
 *
 * LA SESIÓN YA NO ES DE SUPABASE AUTH
 * -----------------------------------
 * Este guion iniciaba sesión con `signInWithPassword` y armaba una cookie
 * `sb-<ref>-auth-token` con el formato de @supabase/ssr. Desde la migración
 * 0024 los usuarios viven en `allan.usuario` y la sesión es una cookie propia,
 * `diario_sesion`, firmada con HMAC por el servidor. La cookie vieja ya no la
 * lee nadie: el proxy la ignoraba y las nueve rutas contestaban un 307 hacia
 * /login, así que el guion no probaba nada aunque terminara.
 *
 * Ahora se autentica con `fn_autenticar` —la misma función que usa la pantalla
 * de acceso— y firma la cookie replicando lo que hace `lib/sesion.ts`.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const BASE = process.env.BASE ?? "http://localhost:3000";
const USUARIO = process.env.USUARIO ?? "admin";
const CLAVE = process.env.PW;
if (!CLAVE) {
  console.error("Falta PW=<clave del administrador>");
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});

const { data: cuentas, error } = await sb.rpc("fn_autenticar", {
  p_usuario: USUARIO,
  p_contrasena: CLAVE,
});

if (error) {
  console.error("No se pudo iniciar sesión:", error.message);
  process.exit(1);
}
if (!cuentas?.length) {
  console.error(`Credenciales incorrectas para «${USUARIO}».`);
  process.exit(1);
}

const cuenta = cuentas[0];
if (cuenta.r_rol === "vendedor") {
  console.error("Este guion recorre pantallas administrativas: use una cuenta que no sea de vendedor.");
  process.exit(1);
}

/**
 * La misma firma que `lib/sesion.ts`: cuerpo en base64url, un punto, y el
 * HMAC-SHA256 del cuerpo. Sin SESION_SECRETO se deriva de la llave de
 * servicio, exactamente igual que el servidor.
 */
const secreto =
  env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
    ? env.SESION_SECRETO
    : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY).update("sesion:diario").digest("base64url");

const sesion = {
  id: cuenta.r_id,
  nombre: cuenta.r_nombre,
  rol: cuenta.r_rol,
  vendedor_id: cuenta.r_vendedor_id,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const cuerpo = Buffer.from(JSON.stringify(sesion)).toString("base64url");
const firma = createHmac("sha256", secreto).update(cuerpo).digest("base64url");
const cookie = `diario_sesion=${cuerpo}.${firma}`;

console.log(`Sesión de ${cuenta.r_nombre} (${cuenta.r_rol}) contra ${BASE}\n`);

const RUTAS = [
  ["/tablero", ["Tablero"]],
  ["/punto-de-venta", ["Punto de venta"]],
  ["/resultados", ["Sorteos y resultados"]],
  ["/vendedores", ["Vendedores y límites", "María F. Cruz", "EXPOSICIÓN"]],
  ["/liquidacion", ["Liquidación semanal"]],
  ["/informe", ["Informe de gerencia"]],
  ["/analisis", ["Análisis de resultados"]],
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
for (const t of ["Sistema de Control", "OPERACIÓN", "ANÁLISIS", "CONFIGURACIÓN", "Administrador"]) {
  if (htmlShell.includes(t)) { ok++; console.log(`  ok    shell: ${t}`); }
  else { fallos++; console.log(`  FALLA shell: falta ${t}`); }
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
