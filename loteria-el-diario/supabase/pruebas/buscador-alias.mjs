/**
 * Buscar un vendedor por su ALIAS en los filtros del panel.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 * Que en los cuatro sitios donde se elige vendedor se le encuentre escribiendo
 * el alias —que es como se le conoce— y no sólo el nombre registrado o el
 * código.
 *
 * Se hace en un navegador porque lo que hay que demostrar es de navegador: que
 * al teclear aparezca el vendedor. Leer el código sólo diría que el filtro
 * está escrito, no que funciona.
 *
 * Antes de correrlo:
 *     npm run build && npm run start -- -p 3123
 *     node supabase/pruebas/buscador-alias.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3123";

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

// Un vendedor real con alias: es con lo que se va a buscar.
const { data: conAlias } = await sb
  .from("vendedor")
  .select("id, codigo, nombre, alias")
  .not("alias", "is", null)
  .eq("activo", true)
  .limit(1)
  .maybeSingle();

if (!conAlias) {
  console.error("Ningún vendedor activo tiene alias; no se puede probar.");
  process.exit(1);
}

console.log(`Buscando «${conAlias.alias}» (${conAlias.codigo} · ${conAlias.nombre})\n`);

const { data: uAdmin } = await sb
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
    id: uAdmin.id,
    nombre: uAdmin.nombre,
    rol: uAdmin.rol,
    vendedor_id: uAdmin.vendedor_id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const COOKIE = `${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;

// --- Chrome ------------------------------------------------------------------
const perfil = mkdtempSync(join(tmpdir(), "alias-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9345",
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
      const ts = await (await fetch("http://127.0.0.1:9345/json/list")).json();
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
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  const ALIAS = conAlias.alias;
  const CODIGO = conAlias.codigo;

  /**
   * Teclea en un campo como lo haría una persona.
   *
   * Con el setter nativo porque React escucha el evento `input`, no el cambio
   * directo de `value`: asignarlo a secas no dispara nada y la lista se
   * quedaría igual, dando un falso negativo.
   */
  const tecleaEn = (selector, texto) => `
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const campo = document.querySelector(${JSON.stringify(selector)});
      if (!campo) return { error: 'no se encontró el campo' };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(campo, ${JSON.stringify(texto)});
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(400);
      return { ok: true };
    })()
  `;

  // ---------- 1. REPORTES: combobox nuevo ----------
  await cdp("Page.navigate", { url: `${BASE}/reportes` });
  await esperar(6000);
  console.log("--- Reportes ---");

  const r1 = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const boton = [...document.querySelectorAll('button')]
        .find((b) => /Todos/.test((b.textContent || '').trim()) &&
                     b.getAttribute('aria-haspopup') === 'listbox');
      if (!boton) return { error: 'no hay combobox de vendedor' };
      boton.click();
      await esperar(400);
      return { abrio: !!document.querySelector('[role="combobox"]') };
    })()
  `);
  check("hay un buscador de vendedor", !r1.error, r1.error ?? "");
  check("se abre al pulsarlo", r1.abrio === true);

  if (!r1.error) {
    await ev(tecleaEn('input[role="combobox"]', ALIAS));
    const res = await ev(`
      (() => {
        const ops = [...document.querySelectorAll('[role="option"]')];
        return {
          cuantas: ops.length,
          textos: ops.map((o) => (o.textContent || '').trim()).slice(0, 4),
        };
      })()
    `);
    check(
      `escribiendo el alias «${ALIAS}» aparece el vendedor`,
      res.textos.some((t) => t.includes(ALIAS)),
      `${res.cuantas} opciones: ${res.textos.join(" | ")}`,
    );
    check(
      "y la lista se recorta, no muestra el padrón entero",
      res.cuantas <= 3,
      `${res.cuantas} opciones`,
    );
    check(
      "la opción enseña también el código, para comprobar quién es",
      res.textos.some((t) => t.includes(CODIGO)),
      res.textos.join(" | "),
    );
  }

  // ---------- 2. CONTROL: buscador ya existente, ahora con alias ----------
  await cdp("Page.navigate", { url: `${BASE}/control` });
  await esperar(6000);
  console.log("\n--- Control de vendedores ---");

  const buscadorControl = await ev(`
    (() => {
      const c = [...document.querySelectorAll('input[type="text"], input:not([type])')]
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 0 && /buscar|vendedor/i.test(
            (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || ''));
        });
      return c.length > 0 ? c[0].placeholder || 'sin placeholder' : null;
    })()
  `);
  check("tiene buscador", buscadorControl !== null, "no se encontró");

  if (buscadorControl !== null) {
    await ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        const campo = [...document.querySelectorAll('input')]
          .find((i) => {
            const r = i.getBoundingClientRect();
            return r.width > 0 && /buscar|vendedor/i.test(
              (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || ''));
          });
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(campo, ${JSON.stringify(ALIAS)});
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        await esperar(400);
        return true;
      })()
    `);
    const enc = await ev(`
      (() => {
        const t = document.body.innerText;
        return {
          loMuestra: t.includes(${JSON.stringify(CODIGO)}),
          sinCoincidencias: /Ningún vendedor coincide/.test(t),
        };
      })()
    `);
    check(
      `buscando «${ALIAS}» encuentra al vendedor`,
      enc.loMuestra === true && enc.sinCoincidencias === false,
      enc.sinCoincidencias ? "dijo que no coincide ninguno" : "no apareció su código",
    );
  }

  // ---------- 3. INFORME: el riel de vendedores ----------
  await cdp("Page.navigate", { url: `${BASE}/informe?vista=vendedor` });
  await esperar(6000);
  console.log("\n--- Informe por vendedor ---");

  const rielHay = await ev(`
    (() => {
      const c = [...document.querySelectorAll('input')].filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && /buscar/i.test(
          (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || ''));
      });
      return c.length > 0;
    })()
  `);
  check("tiene buscador", rielHay === true, "no se encontró");

  if (rielHay) {
    await ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        const campo = [...document.querySelectorAll('input')].find((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 0 && /buscar/i.test(
            (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || ''));
        });
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(campo, ${JSON.stringify(ALIAS)});
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        await esperar(400);
        return true;
      })()
    `);
    const enc = await ev(
      `document.body.innerText.includes(${JSON.stringify(CODIGO)})`,
    );
    check(`buscando «${ALIAS}» encuentra al vendedor`, enc === true, "no apareció su código");
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
