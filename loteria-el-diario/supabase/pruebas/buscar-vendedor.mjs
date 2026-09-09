/**
 * El buscador de la pantalla de vendedores.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que filtre por CÓDIGO, por NOMBRE y por ALIAS — los tres, sin tener que
 *     elegir antes en cuál buscar.
 *   · Que no distinga mayúsculas: nadie teclea «EMPEÑOS» para buscarlo, y que
 *     el filtro distinga hace creer que un vendedor no existe.
 *   · Que al no encontrar nada lo DIGA, en vez de dejar una tabla vacía que se
 *     lee como «no hay vendedores».
 *   · Que limpiar devuelva la lista entera.
 *   · Que un cambio sin guardar que el filtro esconde se ANUNCIE: «Guardar»
 *     lo guarda igual, y descubrirlo después es la clase de sorpresa que hace
 *     desconfiar de una pantalla.
 *
 * Antes de correrlo:
 *     npm run build && npm run start -- -p 3120
 *     node supabase/pruebas/buscar-vendedor.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3120";

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

// Con qué buscar: un vendedor real del padrón, y otro que tenga alias.
const { data: vs } = await sb
  .from("vendedor")
  .select("codigo, nombre, alias")
  .eq("activo", true)
  .order("codigo");

const total = (vs ?? []).length;
const uno = (vs ?? [])[0];
const conAlias = (vs ?? []).find((v) => v.alias);
if (!uno) {
  console.error("No hay vendedores activos con los que probar.");
  process.exit(1);
}

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
const perfil = mkdtempSync(join(tmpdir(), "busc-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9342",
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
      const ts = await (await fetch("http://127.0.0.1:9342/json/list")).json();
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

  await cdp("Page.navigate", { url: `${BASE}/vendedores` });
  await esperar(6000);

  /**
   * Teclea en el buscador como lo haría una persona y devuelve qué se ve.
   *
   * Se usa el setter nativo porque React escucha el evento `input` y no el
   * cambio directo de `value`: asignarlo a secas no dispara nada y la lista
   * se quedaría igual, dando un falso negativo.
   */
  const buscar = (texto) =>
    ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        const campo = document.querySelector(
          'input[aria-label^="Buscar vendedor"]');
        if (!campo) return { error: 'no hay buscador' };

        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(campo, ${JSON.stringify(texto)});
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        await esperar(350);

        const filas = [...document.querySelectorAll('tbody tr')];
        return {
          filas: filas.length,
          codigos: filas.map((f) =>
            (f.textContent.match(/V-\\d{3}/) || [''])[0]).filter(Boolean),
          sinResultados: /Ningún vendedor coincide/.test(document.body.innerText),
          avisoOculto: /cambios sin\\s+guardar que la búsqueda/.test(
            document.body.innerText.replace(/\\s+/g, ' ')),
        };
      })()
    `);

  const inicial = await buscar("");
  check("existe el buscador", !inicial.error, inicial.error ?? "");
  check(
    "sin filtro se ven todos los vendedores",
    inicial.filas === total,
    `${inicial.filas} de ${total}`,
  );

  // --- Por código ------------------------------------------------------------
  const porCodigo = await buscar(uno.codigo);
  check(
    `filtra por CÓDIGO (${uno.codigo})`,
    porCodigo.filas === 1 && porCodigo.codigos[0] === uno.codigo,
    `${porCodigo.filas} filas: ${porCodigo.codigos.join(",")}`,
  );

  // --- Por nombre, y en minúsculas -------------------------------------------
  const trozo = uno.nombre.split(" ")[0];
  const porNombre = await buscar(trozo.toLowerCase());
  check(
    `filtra por NOMBRE en minúsculas («${trozo.toLowerCase()}»)`,
    porNombre.filas >= 1 && porNombre.codigos.includes(uno.codigo),
    `${porNombre.filas} filas: ${porNombre.codigos.join(",")}`,
  );
  check(
    "y no devuelve el padrón entero",
    porNombre.filas < total,
    `devolvió ${porNombre.filas} de ${total}`,
  );

  // --- Por alias --------------------------------------------------------------
  if (conAlias) {
    const porAlias = await buscar(conAlias.alias);
    check(
      `filtra por ALIAS («${conAlias.alias}»)`,
      porAlias.codigos.includes(conAlias.codigo),
      `${porAlias.filas} filas: ${porAlias.codigos.join(",")}`,
    );
  } else {
    console.log("  (se omite el alias: ningún vendedor tiene)");
  }

  // --- Sin resultados ---------------------------------------------------------
  const vacio = await buscar("zzzzz-no-existe");
  check("sin coincidencias, no queda ninguna fila", vacio.filas === 0, `${vacio.filas}`);
  check("y LO DICE en vez de dejar la tabla muda", vacio.sinResultados === true);

  // --- Limpiar devuelve todo --------------------------------------------------
  const limpio = await buscar("");
  check("limpiar devuelve la lista entera", limpio.filas === total, `${limpio.filas} de ${total}`);

  // --- Un cambio escondido por el filtro se anuncia ---------------------------
  const escondido = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;

      // Se toca la comisión de la PRIMERA fila.
      const fila = document.querySelector('tbody tr');
      const campo = [...fila.querySelectorAll('input')][1];
      if (!campo) return { error: 'no hay campo editable' };
      setter.call(campo, '13.5');
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(300);

      // Y se busca algo que NO la incluya.
      const buscador = document.querySelector('input[aria-label^="Buscar vendedor"]');
      setter.call(buscador, 'zzzzz-no-existe');
      buscador.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(400);

      return {
        aviso: /cambios sin\\s+guardar que la búsqueda/.test(
          document.body.innerText.replace(/\\s+/g, ' ')),
      };
    })()
  `);

  check(
    "avisa de los cambios que el filtro esconde",
    escondido.aviso === true,
    escondido.error ?? "no salió el aviso",
  );
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
