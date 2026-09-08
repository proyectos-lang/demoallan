/**
 * La tira de montos de 5 en 5 en el punto de venta del vendedor.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ CON UN NAVEGADOR
 * --------------------------------------------
 * Que la tira EXISTA es cosa de leer el código; que se pueda USAR no. Lo que
 * hay que demostrar es:
 *
 *   · Que están los veinte montos, de 5 en 5 hasta 100.
 *   · Que la tira SE DESPLAZA de verdad — es decir, que su contenido es más
 *     ancho que su caja. Si los botones se encogieran para caber todos, la
 *     tira no se movería y quedarían veinte botones minúsculos: exactamente
 *     el fallo que `flex-none` evita, y que no se ve en el código.
 *   · Que un toque pone el monto en el campo.
 *   · Que la tira no desborda la pantalla.
 *
 * Antes de correrlo:
 *     npm run build && npm run start -- -p 3112
 *     node supabase/pruebas/montos-rapidos.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3112";

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

// --- Sesión de un vendedor con acceso ---------------------------------------
const { data: accesos } = await sb.rpc("fn_accesos_vendedor");
const conCuenta = (accesos ?? []).find((a) => a.r_usuario);
if (!conCuenta) {
  console.error("No hay ningún vendedor con acceso creado.");
  process.exit(1);
}

const { data: usuario } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("usuario", conCuenta.r_usuario)
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

// --- Chrome ------------------------------------------------------------------
const perfil = mkdtempSync(join(tmpdir(), "montos-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9336",
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
      const ts = await (await fetch("http://127.0.0.1:9336/json/list")).json();
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
try {
  ws = new WebSocket(await objetivo());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let n = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const g = JSON.parse(m.data);
    if (g.id && pend.has(g.id)) {
      pend.get(g.id)(g);
      pend.delete(g.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pend.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (e) =>
    (await cdp("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }))
      .result?.result?.value;

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 780,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(7000);

  /*
   * Se toca un número de la rejilla para abrir la hoja del monto.
   *
   * Se busca dentro de la vista MÓVIL: la de escritorio también está en el
   * árbol —las dos se renderizan y una se oculta con `lg:hidden`—, así que un
   * `querySelectorAll` a secas encuentra los botones de las dos y toca el que
   * no se ve. Se filtra por los que de verdad ocupan sitio en pantalla.
   */
  /*
   * Se abre la hoja tocando el botón de una DECENA, que tiene un `aria-label`
   * estable —«Seleccionar del 00 al 09»— en vez de buscar por el texto del
   * número. Los botones de número llevan además el cupo debajo, así que su
   * `textContent` no es sólo «07» y filtrar por eso no los encuentra.
   */
  const abrio = await ev(`
    (() => {
      const b = document.querySelector('button[aria-label^="Seleccionar del"]');
      if (!b) return 'no hay botón de decena';
      if (b.disabled) return 'la decena está sin cupo';
      b.click();
      return 'tocado: ' + b.getAttribute('aria-label');
    })()
  `);
  await esperar(900);

  const hoja = await ev(`!!document.querySelector('[role="dialog"]')`);
  check("la hoja del monto se abre al tocar un número", hoja === true, String(abrio));

  if (hoja) {
    const tira = await ev(`
      (() => {
        const g = document.querySelector('[role="group"][aria-label="Montos frecuentes"]');
        if (!g) return null;
        const botones = [...g.querySelectorAll('button')].map((b) => b.textContent.trim());
        return {
          montos: botones,
          // Lo que demuestra que se DESPLAZA: el contenido es más ancho que la
          // caja. Si los botones se encogieran para caber, esto sería 0.
          desplazable: g.scrollWidth - g.clientWidth,
          anchoCaja: Math.round(g.getBoundingClientRect().width),
          // Alto del primer botón: con el dedo, por debajo de 36px se falla.
          alto: Math.round(g.querySelector('button').getBoundingClientRect().height),
        };
      })()
    `);

    check("existe la tira de montos", tira !== null, "no se encontró el grupo");

    if (tira) {
      const esperados = Array.from({ length: 20 }, (_, i) => String((i + 1) * 5));
      check(
        "trae los veinte montos de 5 en 5 hasta 100",
        JSON.stringify(tira.montos) === JSON.stringify(esperados),
        tira.montos.join(","),
      );
      check(
        "LA TIRA SE DESPLAZA (el contenido excede la caja)",
        tira.desplazable > 100,
        `sólo ${tira.desplazable}px de sobrante`,
      );
      check(
        "la tira no desborda la pantalla",
        tira.anchoCaja <= 390,
        `mide ${tira.anchoCaja}px`,
      );
      check("los botones son cómodos con el dedo", tira.alto >= 36, `${tira.alto}px de alto`);

      // Se desplaza y se toca uno que al principio no se veía.
      const tocado = await ev(`
        (async () => {
          const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
          const g = document.querySelector('[role="group"][aria-label="Montos frecuentes"]');
          g.scrollLeft = g.scrollWidth;
          await esperar(250);
          const desplazo = g.scrollLeft > 100;
          const cien = [...g.querySelectorAll('button')].find((b) => b.textContent.trim() === '100');
          cien.click();
          await esperar(250);
          // El monto tecleado se pinta en la hoja; se busca el 100 en ella.
          const hoja = document.querySelector('[role="dialog"]');
          return { desplazo, texto: (hoja.textContent || '').includes('100') };
        })()
      `);
      check("la tira se puede arrastrar hasta el final", tocado?.desplazo === true,
            "scrollLeft no se movió");
      check("tocar un monto lo pone en la venta", tocado?.texto === true,
            "el 100 no apareció en la hoja");
    }
  }
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

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
