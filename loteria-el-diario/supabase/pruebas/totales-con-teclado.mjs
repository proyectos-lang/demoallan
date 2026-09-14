/**
 * Capturar por totales sin soltar el teclado.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 * Quien captura tiene una pila de hojas delante y repite el mismo gesto
 * decenas de veces. El recorrido tiene que cerrarse entero con el teclado:
 *
 *   1. Se elige el vendedor y el foco SALTA SOLO a «venta total».
 *   2. Flecha derecha → «valor premiado». Flecha izquierda → vuelve.
 *   3. Enter registra desde cualquiera de los dos.
 *   4. Tras registrar, el foco VUELVE al vendedor para la siguiente hoja.
 *
 * Y una regla que es fácil romper al hacer lo anterior: dentro de una cifra a
 * medio corregir las flechas tienen que seguir moviendo el CURSOR, no saltar
 * de campo. Sólo saltan desde el extremo del texto.
 *
 * Se pulsan teclas de verdad por CDP —`Input.dispatchKeyEvent`— y no eventos
 * de JavaScript: lo que hay que demostrar es que el navegador hace lo que se
 * espera, no que el manejador esté escrito.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     node supabase/pruebas/totales-con-teclado.mjs
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

const { data: unVendedor } = await sb
  .from("vendedor")
  .select("id, codigo, nombre, alias")
  .not("alias", "is", null)
  .eq("activo", true)
  .limit(1)
  .maybeSingle();

if (!unVendedor) {
  console.error("Ningún vendedor activo tiene alias; no se puede probar.");
  process.exit(1);
}
const TROZO = (unVendedor.alias ?? unVendedor.nombre).slice(0, 4);

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

const perfil = mkdtempSync(join(tmpdir(), "teclado-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9363",
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
      const ts = await (await fetch("http://127.0.0.1:9363/json/list")).json();
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

  /** Una tecla de verdad, como la pulsaría una persona. */
  const tecla = async (key, code, keyCode) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await esperar(160);
  };
  /*
   * Escribir carácter a carácter.
   *
   * Sólo `char` inserta texto: mandar además un `keyDown` con `text` lo mete
   * dos veces —«Cely» salía «CCeellyy»—. El keyDown va sin texto, para que el
   * navegador vea la secuencia completa sin duplicar.
   */
  const escribir = async (texto) => {
    for (const c of texto) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: c });
      await cdp("Input.dispatchKeyEvent", { type: "char", text: c, key: c });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: c });
      await esperar(60);
    }
    await esperar(400);
  };
  const DERECHA = () => tecla("ArrowRight", "ArrowRight", 39);
  const IZQUIERDA = () => tecla("ArrowLeft", "ArrowLeft", 37);
  const ENTER = () => tecla("Enter", "Enter", 13);

  /** Qué campo tiene el foco, por su etiqueta. */
  const foco = () => ev(`
    (() => {
      const a = document.activeElement;
      if (!a) return 'nada';
      if (a.getAttribute('role') === 'combobox') return 'vendedor';
      const label = a.closest('label');
      const t = (label?.textContent || '').trim();
      if (/Venta total/.test(t)) return 'venta';
      if (/Valor premiado/.test(t)) return 'premiado';
      if (/Nota/.test(t)) return 'nota';
      return a.tagName.toLowerCase();
    })()
  `);

  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion", value: COOKIE, domain: "localhost", path: "/",
  });

  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta?modo=totales` });
  await esperar(11000);

  // ---------- 1. Elegir vendedor lleva a «venta total» ----------
  console.log("--- Del vendedor al primer campo ---");
  await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-haspopup') === 'listbox')?.click();
      await esperar(400);
    })()
  `);
  check("el buscador se abre con el foco dentro", (await foco()) === "vendedor");

  await escribir(TROZO);
  const hayOpciones = await ev(`document.querySelectorAll('[role="option"]').length`);
  check(`escribiendo «${TROZO}» hay a quién elegir`, hayOpciones > 0, `${hayOpciones}`);

  await ENTER();
  await esperar(500);
  check("EL FOCO SALTA SOLO a «venta total»", (await foco()) === "venta", await foco());

  // ---------- 2. Las flechas mueven entre los dos campos ----------
  console.log("\n--- Las flechas ---");
  await escribir("1500");
  const v1 = await ev(`document.activeElement.value`);
  check("se teclea la venta", v1 === "1500", v1);

  await DERECHA();
  check("la flecha DERECHA pasa a «valor premiado»", (await foco()) === "premiado", await foco());

  await escribir("20");
  /*
   * Para volver hay que estar AL PRINCIPIO del campo.
   *
   * Recién escrito «20» el cursor queda al final, y ahí la izquierda tiene que
   * mover el cursor dentro de la cifra —es lo que espera cualquiera—, no
   * saltar de campo. Se pulsa dos veces: la primera recorre el «0», la segunda
   * llega al principio y salta.
   */
  await IZQUIERDA();
  check(
    "la primera izquierda sólo mueve el cursor dentro de la cifra",
    (await foco()) === "premiado",
    await foco(),
  );
  await IZQUIERDA();
  await IZQUIERDA();
  check("desde el principio, la IZQUIERDA vuelve a «venta total»",
        (await foco()) === "venta", await foco());

  // ---------- 3. Dentro del texto la flecha NO salta ----------
  console.log("\n--- Pero dentro de una cifra, las flechas mueven el cursor ---");
  // Tras volver, el campo queda seleccionado entero: se pone el cursor al
  // principio para probar que la derecha NO salta de campo.
  await ev(`
    (() => {
      const c = document.activeElement;
      c.setSelectionRange(0, 0);
    })()
  `);
  await DERECHA();
  const trasDerecha = await foco();
  check(
    "con el cursor dentro, la derecha NO salta de campo",
    trasDerecha === "venta",
    trasDerecha,
  );
  const pos = await ev(`document.activeElement.selectionStart`);
  check("el cursor avanzó una posición", pos === 1, `${pos}`);

  // ---------- 4. Enter registra ----------
  console.log("\n--- Enter registra ---");
  const antes = await ev(`document.querySelectorAll('tbody tr').length`);
  await ENTER();
  await esperar(4000);

  const despues = await ev(`
    (() => ({
      filas: document.querySelectorAll('tbody tr').length,
      aviso: (document.body.innerText.match(/Registrado[^\\n]*/) || [''])[0],
      venta: [...document.querySelectorAll('input')]
        .find((i) => /Venta total/.test((i.closest('label')?.textContent) || ''))?.value,
    }))()
  `);
  check("se registró la captura", despues.filas > antes || !!despues.aviso,
        `filas ${antes} -> ${despues.filas} · ${despues.aviso}`);
  check("y el formulario se vació", despues.venta === "", `«${despues.venta}»`);
  check(
    "EL FOCO VUELVE al vendedor, listo para la siguiente hoja",
    (await foco()) === "vendedor",
    await foco(),
  );

  // ---------- 5. Se limpia lo registrado ----------
  const { data: cap } = await sb
    .from("venta_total")
    .select("id, venta, premios")
    .eq("vendedor_id", unVendedor.id)
    .is("anulado_en", null)
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cap && Number(cap.venta) === 1500) {
    console.log(`\n        (limpiando la captura de prueba: venta ${cap.venta}, premio ${cap.premios})`);
    const { error } = await sb.rpc("fn_anular_venta_total", {
      p_id: cap.id,
      p_usuario_id: uAdmin.id,
    });
    check("la captura de prueba queda anulada", !error, error?.message ?? "");
  } else {
    console.log("\n        (no se encontró la captura de prueba; nada que limpiar)");
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
