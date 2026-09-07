/**
 * El aviso de «hay una nueva versión».
 *
 * Se comprueba con un NAVEGADOR DE VERDAD porque lo que hay que demostrar es
 * de navegador: que la barra aparece sola, sin recargar, en una pantalla que
 * lleva rato abierta. Pedir el HTML por HTTP no lo probaría — el aviso no está
 * en el HTML inicial, aparece cuando el temporizador descubre que el servidor
 * cambió de versión.
 *
 * CÓMO SE SIMULA UNA PUBLICACIÓN
 * ------------------------------
 * El paquete se compila con `NEXT_PUBLIC_VERSION=v-vieja`, así que el
 * navegador carga una pantalla que se cree «v-vieja». Entonces se intercepta
 * `/api/version` y se le hace responder «v-nueva»: para la pantalla es
 * exactamente lo que ocurre cuando alguien publica.
 *
 * Antes de correrlo:
 *     NEXT_PUBLIC_VERSION=v-vieja npm run build
 *     NEXT_PUBLIC_VERSION=v-vieja npm run start -- -p 3111
 *     node supabase/pruebas/aviso-version.mjs
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3111";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

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

// --- Una sesión de vendedor, firmada como lo hace el servidor ---------------
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

const { data: accesos } = await sb.rpc("fn_accesos_vendedor");
const conCuenta = (accesos ?? []).find((a) => a.r_usuario);
if (!conCuenta) {
  console.error("No hay ningún vendedor con acceso creado; no se puede probar.");
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
const firma = createHmac("sha256", secreto).update(cuerpo).digest("base64url");
const COOKIE = `${cuerpo}.${firma}`;

// --- El endpoint contesta sin sesión ----------------------------------------
const sinSesion = await fetch(`${BASE}/api/version`, { redirect: "manual" });
check("/api/version responde sin sesión (no rebota a /login)", sinSesion.status === 200,
      `status ${sinSesion.status}`);
check("y prohíbe la caché", /no-store/.test(sinSesion.headers.get("cache-control") ?? ""),
      sinSesion.headers.get("cache-control") ?? "sin cabecera");

const { version } = await sinSesion.json();
check("devuelve la versión del paquete", version === "v-vieja", String(version));

// --- El navegador -----------------------------------------------------------
/*
 * Chrome por CDP y no puppeteer: el proyecto no lleva esa dependencia, y todo
 * lo que hace falta aquí —cargar con una cookie, esperar a que aparezca un
 * elemento, leer el DOM— son cuatro mensajes del protocolo. Añadir doscientos
 * megas de dependencia para eso no se paga.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const perfil = mkdtempSync(join(tmpdir(), "aviso-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=9333",
    `--user-data-dir=${perfil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que Chrome levante el puerto de depuración. */
async function objetivo() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:9333/json/list");
      const ts = await r.json();
      const t = ts.find((x) => x.type === "page");
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch {
      /* todavía no está listo */
    }
    await esperar(250);
  }
  throw new Error("Chrome no abrió el puerto de depuración");
}

let ws;
try {
  const url = await objetivo();
  const { WebSocket } = await import("node:ws").catch(() => ({ WebSocket: globalThis.WebSocket }));
  ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let n = 0;
  const pendientes = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pendientes.has(msg.id)) {
      pendientes.get(msg.id)(msg);
      pendientes.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const id = ++n;
      pendientes.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluar = async (expr) => {
    const r = await cdp("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.result?.result?.value;
  };

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(4000);

  const hayAvisoAntes = await evaluar(`!!document.querySelector('[role="status"]')`);
  check("al cargar no hay aviso (las versiones coinciden)", hayAvisoAntes === false,
        "salió el aviso sin haber publicado nada");

  /*
   * Se «publica»: se sustituye `fetch` para que /api/version diga otra cosa.
   *
   * Es lo mismo que ve la pantalla cuando alguien despliega, y no toca el
   * servidor — así la prueba no depende de reconstruir el paquete a mitad.
   */
  await evaluar(`
    (() => {
      const original = window.fetch;
      window.fetch = (u, o) =>
        String(u).includes("/api/version")
          ? Promise.resolve(new Response(JSON.stringify({ version: "v-nueva" }),
              { headers: { "content-type": "application/json" } }))
          : original(u, o);
      document.dispatchEvent(new Event("visibilitychange"));
      return true;
    })()
  `);

  // El aviso llega en cuanto responde la petición interceptada.
  let texto = "";
  for (let i = 0; i < 20; i++) {
    texto = (await evaluar(
      `document.querySelector('[role="status"]')?.textContent ?? ""`,
    )) ?? "";
    if (texto) break;
    await esperar(300);
  }

  check("aparece el aviso sin recargar la página", /nueva versi/i.test(texto),
        texto || "no apareció");
  check("y trae el botón de actualizar", /Actualizar/.test(texto), texto || "");

  const marca = await evaluar(
    `document.documentElement.hasAttribute("data-aviso-version")`,
  );
  check("marca el documento para apartar el pie del punto de venta", marca === true,
        "no se puso data-aviso-version");

  // El pie del punto de venta tiene que seguir alcanzable: se comprueba que el
  // aviso no lo tape, midiendo dónde acaba el contenido y dónde empieza la barra.
  const noTapa = await evaluar(`
    (() => {
      const aviso = document.querySelector('[role="status"]');
      const main = document.querySelector('main');
      if (!aviso || !main) return null;
      const relleno = parseFloat(getComputedStyle(main).paddingBottom);
      return relleno >= aviso.getBoundingClientRect().height - 1;
    })()
  `);
  check("el contenido deja sitio para la barra (no tapa el pie)", noTapa === true,
        `relleno insuficiente (${noTapa})`);

  /*
   * Al pulsar, la página recarga DE VERDAD.
   *
   * No se puede sustituir `location.reload` —los navegadores modernos no dejan
   * reescribir esa propiedad—, así que se marca la ventana actual y se
   * comprueba que la marca desapareció: sólo desaparece si el documento se
   * cargó de nuevo, que es exactamente lo que hay que demostrar.
   */
  await evaluar(`(window.__testigo = "antes-de-recargar", true)`);
  await evaluar(`(document.querySelector('[role="status"] button').click(), true)`);
  await esperar(3000);

  const testigo = await evaluar(`window.__testigo ?? null`);
  check("el botón recarga la página de verdad", testigo === null,
        `la ventana no se recargó (testigo: ${testigo})`);

  // Y tras recargar, la barra ya no está: la marca del documento se limpió.
  const marcaDespues = await evaluar(
    `document.documentElement.hasAttribute("data-aviso-version")`,
  );
  check("tras recargar, el documento queda limpio", marcaDespues === false,
        "siguió marcado después de recargar");
} finally {
  try { ws?.close(); } catch { /* da igual */ }
  chrome.kill();
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* da igual */ }
}

console.log(`
=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
