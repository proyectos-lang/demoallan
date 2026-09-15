/**
 * En el punto de venta se elige al vendedor escribiendo, no buscándolo.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ EN UN NAVEGADOR
 * -------------------------------------------
 * Los dos modos de registro del administrador —número a número y por
 * totales— tenían un `select` nativo con los ciento y pico vendedores dentro,
 * ordenados por código. Para elegir a MERKA EXPRESS había que recorrerlos con
 * la vista sabiendo de antemano su código, que es justo lo que nadie recuerda.
 *
 * Es el gesto que abre cada venta, así que el coste se paga entero cada vez.
 *
 * Que el combobox esté escrito no demuestra que funcione: hay que teclear y
 * ver aparecer al vendedor. Eso sólo se puede hacer en un navegador.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     node supabase/pruebas/pos-buscador-vendedor.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Un vendedor real CON alias: es por lo que se le va a buscar.
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

const { count: cuantos } = await sb
  .from("vendedor")
  .select("*", { count: "exact", head: true })
  .eq("activo", true);

const ALIAS = conAlias.alias;
const TROZO = ALIAS.slice(0, 5);
console.log(`Buscando «${TROZO}» de ${ALIAS} (${conAlias.codigo}) entre ${cuantos} activos\n`);

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

const perfil = mkdtempSync(join(tmpdir(), "pos-busca-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9361",
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
      const ts = await (await fetch("http://127.0.0.1:9361/json/list")).json();
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

  /** Abre el combobox, teclea y devuelve lo que ofrece la lista. */
  const buscar = (texto) => `
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const quedan = [...document.querySelectorAll('select')]
        .filter((s) => [...s.options].some((o) => /${conAlias.codigo}/.test(o.textContent || '')));
      const boton = [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-haspopup') === 'listbox');
      if (!boton) return { error: 'no hay combobox de vendedor', selects: quedan.length };
      boton.click();
      await esperar(400);
      const campo = document.querySelector('input[role="combobox"]');
      if (!campo) return { error: 'no se abrió el campo de búsqueda' };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(campo, ${JSON.stringify(texto)});
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(500);
      const ops = [...document.querySelectorAll('[role="option"]')];
      return {
        selectsDeVendedor: quedan.length,
        cuantas: ops.length,
        textos: ops.map((o) => (o.textContent || '').trim()).slice(0, 5),
      };
    })()
  `;

  // ---------- 1. Número a número ----------
  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta` });
  await esperar(11000);
  console.log("--- Número a número ---");

  const r1 = await ev(buscar(TROZO));
  check("hay un buscador de vendedor", !r1.error, r1.error ?? "");
  if (!r1.error) {
    check(
      "ya no queda ningún desplegable con el padrón dentro",
      r1.selectsDeVendedor === 0,
      `${r1.selectsDeVendedor} selects`,
    );
    check(
      `escribiendo «${TROZO}» aparece el vendedor`,
      r1.textos.some((t) => t.includes(TROZO)),
      `${r1.cuantas}: ${r1.textos.join(" | ")}`,
    );
    check(
      "la lista se recorta, no muestra el padrón entero",
      r1.cuantas > 0 && r1.cuantas < 10,
      `${r1.cuantas} de ${cuantos}`,
    );
    check(
      "y enseña el código, para comprobar quién es",
      r1.textos.some((t) => t.includes(conAlias.codigo)),
      r1.textos.join(" | "),
    );

    // Elegirlo tiene que dejarlo puesto.
    const elegido = await ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelectorAll('[role="option"]')[0]?.click();
        await esperar(600);
        const boton = [...document.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-haspopup') === 'listbox');
        return (boton?.textContent || '').trim();
      })()
    `);
    check(
      "al elegirlo queda puesto",
      elegido.includes(TROZO) || elegido.includes(conAlias.codigo),
      elegido,
    );
  }

  /* ---------- 2. Por totales: ya no hay combobox ----------
   *
   * Esa pantalla dejó de elegir un vendedor: ahora es una matriz con el padrón
   * entero, una fila por cabeza, y se busca escribiendo en un campo de texto
   * que recorta la tabla. Comprobar aquí un combobox sería exigir una pantalla
   * que ya no existe.
   *
   * Lo que sí tiene que seguir cumpliéndose es el propósito: encontrar a
   * alguien concreto escribiendo, sin recorrer cien filas con la vista.
   */
  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta?modo=totales` });
  await esperar(12000);
  console.log("\n--- Por totales: la matriz ---");

  const buscarEnMatriz = (texto) => `
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const campo = [...document.querySelectorAll('input')]
        .find((i) => /Alias o código/.test(i.placeholder || ''));
      if (!campo) return { error: 'no hay campo de búsqueda en la matriz' };
      const antes = document.querySelectorAll('tbody tr').length;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(campo, ${JSON.stringify("__TEXTO__")});
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(500);
      const filas = [...document.querySelectorAll('tbody tr')];
      return {
        antes,
        despues: filas.length,
        textos: filas.map((f) => (f.querySelector('td')?.textContent || '').trim()).slice(0, 5),
      };
    })()
  `.replace('"__TEXTO__"', JSON.stringify(texto));

  const m1 = await ev(buscarEnMatriz(TROZO));
  check("la matriz tiene buscador", !m1.error, m1.error ?? "");
  if (!m1.error) {
    check(
      "trae el padrón entero antes de buscar",
      m1.antes > 10,
      `${m1.antes} filas`,
    );
    check(
      `escribiendo «${TROZO}» se recorta a quien coincide`,
      m1.despues > 0 && m1.despues < m1.antes,
      `${m1.antes} -> ${m1.despues}`,
    );
    check(
      "y el vendedor buscado está entre ellos",
      m1.textos.some((t) => t.includes(TROZO)),
      m1.textos.join(" | "),
    );
  }

  // ---------- 3. También se encuentra por código ----------
  const m2 = await ev(buscarEnMatriz(conAlias.codigo));
  if (!m2.error) {
    check(
      `escribiendo «${conAlias.codigo}» aparece`,
      m2.textos.some((t) => t.includes(conAlias.codigo)),
      m2.textos.join(" | "),
    );
  } else {
    check("el buscador sigue disponible", false, m2.error);
  }
} finally {
  try {
    ws?.close();
  } catch {
    /* da igual */
  }
  chrome.kill();
  await esperar(600);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    /* Windows a veces retiene el perfil un instante */
  }
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
