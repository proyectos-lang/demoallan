/**
 * ¿Se puede usar el panel de administración en un teléfono?
 *
 * QUÉ MIDE Y POR QUÉ ESO
 * ----------------------
 * Dos cosas, y las dos son de las que no se ven leyendo el código:
 *
 *   · DESBORDE HORIZONTAL. Si el documento es más ancho que la ventana, la
 *     página se arrastra de lado: se pierden columnas por la derecha y ningún
 *     botón queda donde uno cree. Es el fallo que hace una pantalla inservible
 *     en un móvil, y se mide comparando `scrollWidth` con el ancho real.
 *
 *   · CUÁNTO ANCHO QUEDA PARA EL CONTENIDO. La barra lateral mide 262px fijos.
 *     En un teléfono de 390 eso deja 128px para todo lo demás, que no es que
 *     se vea mal: es que no se ve.
 *
 * Se mide con Chrome de verdad y no con la sospecha de leer clases de Tailwind,
 * porque lo que importa es el resultado y no la intención.
 *
 *     npm run build && npm run start -- -p 3112
 *     node supabase/pruebas/movil-admin.mjs
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3112";
const ANCHO = Number(process.env.ANCHO ?? 390);
const ALTO = Number(process.env.ALTO ?? 780);

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

const { data: usuario } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

const secreto =
  env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
    ? env.SESION_SECRETO
    : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY)
        .update("sesion:diario")
        .digest("base64url");

const cuerpo = Buffer.from(
  JSON.stringify({
    id: usuario.id,
    nombre: usuario.nombre,
    rol: usuario.rol,
    vendedor_id: usuario.vendedor_id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const COOKIE = `${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;

const RUTAS = [
  "/tablero",
  "/tablero?tab=dia",
  "/punto-de-venta",
  "/resultados",
  "/liquidacion",
  "/vendedores",
  "/informe",
  "/reportes",
  "/control",
  "/digitalizacion",
  "/analisis",
  "/geo",
  "/simulador",
];

const perfil = mkdtempSync(join(tmpdir(), "movil-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9334",
    `--user-data-dir=${perfil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function objetivo() {
  for (let i = 0; i < 40; i++) {
    try {
      const ts = await (await fetch("http://127.0.0.1:9334/json/list")).json();
      const t = ts.find((x) => x.type === "page");
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch {
      /* aún no */
    }
    await esperar(250);
  }
  throw new Error("Chrome no abrió el puerto");
}

let ws;
const filas = [];
try {
  ws = new WebSocket(await objetivo());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let n = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend.has(msg.id)) {
      pend.get(msg.id)(msg);
      pend.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pend.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluar = async (e) =>
    (await cdp("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }))
      .result?.result?.value;

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: ANCHO,
    height: ALTO,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  for (const ruta of RUTAS) {
    await cdp("Page.navigate", { url: BASE + ruta });
    await esperar(2600);

    const m = await evaluar(`
      (() => {
        const d = document.documentElement;
        const main = document.querySelector('main');
        const ancho = d.clientWidth;

        /*
         * Qué se sale de la pantalla, y por culpa de quién.
         *
         * El desborde del documento no basta: un contenedor con scroll propio
         * lo absorbe y la página deja de arrastrarse, pero si ese contenedor
         * mide 900px el usuario sigue teniendo que desplazarlo de lado para
         * ver la mitad de las columnas. Eso es aceptable en una TABLA
         * —desplazar una tabla es un gesto normal— y no lo es en el resto.
         */
        const anchos = [...document.querySelectorAll('main *')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > ancho + 2 && r.height > 0;
          })
          .map((e) => ({
            etiqueta: e.tagName.toLowerCase(),
            ancho: Math.round(e.getBoundingClientRect().width),
            enScroll: !!e.closest('.overflow-x-auto, [style*="overflow-x"]'),
            clase: (e.className || '').toString().slice(0, 60),
            texto: (e.textContent || '').trim().slice(0, 30),
          }));

        const sueltos = anchos.filter((a) => !a.enScroll);

        // Toques por debajo de 36px: incómodos con el dedo.
        const chicos = [...document.querySelectorAll('main button, main a, main input, main select')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.height > 0 && r.height < 36;
          }).length;

        return {
          desborde: d.scrollWidth - d.clientWidth,
          util: main ? Math.round(main.getBoundingClientRect().width) : 0,
          anchos: sueltos.sort((a, b) => b.ancho - a.ancho).slice(0, 3),
          enTabla: anchos.length - sueltos.length,
          chicos,
        };
      })()
    `);
    filas.push({ ruta, ...m });
  }
  // --- El cajón del menú -----------------------------------------------------
  await cdp("Page.navigate", { url: BASE + "/tablero" });
  await esperar(2600);

  const cajon = await evaluar(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const aside = document.querySelector('aside');
      const fuera = () => aside.getBoundingClientRect().right <= 1;

      const cerradoAlInicio = fuera();

      // El botón de abrir vive en la cabecera móvil.
      const abrir = document.querySelector('header button[aria-label="Abrir el menú"]');
      if (!abrir) return { error: 'no hay botón de menú' };
      abrir.click();
      await esperar(450);
      const abierto = aside.getBoundingClientRect().left >= -1;

      // Y el velo lo cierra.
      const velo = document.querySelector('button[aria-label="Cerrar el menú"]');
      velo?.click();
      await esperar(450);

      return {
        cerradoAlInicio,
        abierto,
        cierraConElVelo: fuera(),
        // Cerrado no debe ser alcanzable con el teclado.
        inerte: aside.hasAttribute('inert'),
        enlaces: aside.querySelectorAll('a').length,
      };
    })()
  `);

  console.log("");
  console.log("El cajón del menú:");
  const c = cajon ?? {};
  const linea = (n, ok) => console.log(`  ${ok ? "ok   " : "FALLA"} ${n}`);
  linea("empieza cerrado", c.cerradoAlInicio === true);
  linea("se abre con el botón", c.abierto === true);
  linea("se cierra tocando fuera", c.cierraConElVelo === true);
  linea("cerrado no se alcanza con el teclado", c.inerte === true);
  linea(`lleva el menú completo (${c.enlaces} enlaces)`, (c.enlaces ?? 0) >= 9);
} finally {
  try {
    ws?.close();
  } catch {
    /* da igual */
  }
  chrome.kill();
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    /* da igual */
  }
}

console.log(`
A ${ANCHO}px de ancho:
`);
console.log("ruta                    desb  útil  toques  se sale de la pantalla");
console.log("-".repeat(78));
let malas = 0;
for (const f of filas) {
  const mal = f.desborde > 1 || f.anchos.length > 0;
  if (mal) malas++;
  const culpa = f.anchos.length
    ? f.anchos.map((a) => `${a.etiqueta} ${a.ancho}px [${a.clase}] "${a.texto}"`).join(" | ")
    : f.enTabla
      ? `(${f.enTabla} en tabla desplazable - ok)`
      : "-";
  console.log(
    `${f.ruta.padEnd(22)} ${String(f.desborde).padStart(4)} ${String(f.util).padStart(5)} ${String(f.chicos).padStart(6)}  ${culpa}`,
  );
}
console.log(`
${malas} de ${filas.length} con contenido que se sale.`);
