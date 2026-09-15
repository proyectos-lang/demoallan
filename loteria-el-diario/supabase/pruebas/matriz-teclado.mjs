/**
 * La matriz de captura por totales, en el navegador.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ AQUÍ
 * --------------------------------
 * Que el padrón entero se pinte y que se recorra con el teclado. Nada de esto
 * se demuestra leyendo el código: diría que está escrito, no que al pulsar la
 * flecha el foco baje a la fila siguiente.
 *
 *   · Que aparezcan LOS 102 vendedores, no sólo los que ya tienen captura.
 *   · Que la flecha ABAJO pase al vendedor siguiente, y ARRIBA vuelva.
 *   · Que la DERECHA pase de venta a premiado, y la IZQUIERDA vuelva —sólo
 *     desde el extremo del texto: dentro de una cifra a medio corregir tienen
 *     que seguir moviendo el cursor.
 *   · Que el pie cuente lo tecleado y el premio pagado salga del factor.
 *   · Que el filtro recorte de verdad.
 *
 * Se teclea con `Input.dispatchKeyEvent`, teclas de verdad, no eventos de
 * JavaScript.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     node supabase/pruebas/matriz-teclado.mjs
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

const HOY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });

const { count: activos } = await sb
  .from("vendedor")
  .select("*", { count: "exact", head: true })
  .eq("activo", true)
  .is("eliminado_en", null);

console.log(`Padrón: ${activos} vendedores activos\n`);

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

const perfil = mkdtempSync(join(tmpdir(), "matriz-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9373",
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
      const ts = await (await fetch("http://127.0.0.1:9373/json/list")).json();
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

  const tecla = async (key, code, keyCode) => {
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown", key, code,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
    await cdp("Input.dispatchKeyEvent", {
      type: "keyUp", key, code,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
    await esperar(160);
  };
  // Sólo `char` inserta texto: un keyDown con `text` lo metería dos veces.
  const escribir = async (texto) => {
    for (const c of texto) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: c });
      await cdp("Input.dispatchKeyEvent", { type: "char", text: c, key: c });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: c });
      await esperar(50);
    }
    await esperar(350);
  };
  const ABAJO = () => tecla("ArrowDown", "ArrowDown", 40);
  const ARRIBA = () => tecla("ArrowUp", "ArrowUp", 38);
  const DERECHA = () => tecla("ArrowRight", "ArrowRight", 39);
  const IZQUIERDA = () => tecla("ArrowLeft", "ArrowLeft", 37);

  /** Qué casilla tiene el foco: su vendedor y su columna. */
  const foco = () => ev(`
    (() => {
      const a = document.activeElement;
      if (!a || !a.dataset || !a.dataset.id) return { nada: true };
      const fila = a.closest('tr');
      return {
        id: a.dataset.id,
        campo: a.dataset.campo,
        vendedor: (fila?.querySelector('td')?.textContent || '').trim().slice(0, 30),
      };
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

  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta?modo=totales&fecha=${HOY}` });
  await esperar(12000);

  // ---------- 1. El padrón entero ----------
  console.log("--- La matriz carga ---");
  const cargada = await ev(`
    (() => ({
      filas: document.querySelectorAll('tbody tr').length,
      casillas: document.querySelectorAll('input[data-campo]').length,
      columnas: [...document.querySelectorAll('thead th')].map((t) => t.textContent.trim()),
      texto: (document.body.innerText || '').slice(0, 160),
    }))()
  `);
  check(
    `aparecen los ${activos} vendedores`,
    cargada.filas === activos,
    `${cargada.filas} filas · ${cargada.texto}`,
  );
  check(
    "dos casillas por fila",
    cargada.casillas === activos * 2,
    `${cargada.casillas} casillas`,
  );
  check(
    "las columnas son las pedidas",
    JSON.stringify(cargada.columnas) ===
      JSON.stringify(["VENDEDOR", "VENTA TOTAL", "VALOR PREMIADO", "PREMIO PAGADO"]),
    cargada.columnas.join(" | "),
  );
  check(
    "ya no está la columna «suyo»",
    !cargada.columnas.includes("SUYO"),
    cargada.columnas.join(" | "),
  );

  // ---------- 2. Las flechas recorren la matriz ----------
  console.log("\n--- El teclado ---");
  await ev(`document.querySelector('input[data-campo="venta"]').focus()`);
  const f1 = await foco();
  check("el foco entra en la primera casilla", f1.campo === "venta", JSON.stringify(f1));

  await ABAJO();
  const f2 = await foco();
  check(
    "la flecha ABAJO pasa al vendedor siguiente",
    f2.id !== f1.id && f2.campo === "venta",
    `${f1.vendedor} -> ${f2.vendedor}`,
  );

  await ARRIBA();
  const f3 = await foco();
  check("y ARRIBA vuelve al anterior", f3.id === f1.id, JSON.stringify(f3));

  await escribir("1500");
  const escrito = await ev(`document.activeElement.value`);
  check("se teclea la venta", escrito === "1500", escrito);

  await DERECHA();
  const f4 = await foco();
  check(
    "la DERECHA pasa a «valor premiado», misma fila",
    f4.campo === "premiado" && f4.id === f1.id,
    JSON.stringify(f4),
  );

  await escribir("20");
  // Recién escrito el cursor está al final: la izquierda mueve dentro.
  await IZQUIERDA();
  const f5 = await foco();
  check(
    "dentro de la cifra, la IZQUIERDA no salta de casilla",
    f5.campo === "premiado",
    JSON.stringify(f5),
  );
  await IZQUIERDA();
  await IZQUIERDA();
  const f6 = await foco();
  check(
    "desde el principio sí vuelve a «venta total»",
    f6.campo === "venta" && f6.id === f1.id,
    JSON.stringify(f6),
  );

  // ---------- 3. El pie cuenta lo tecleado ----------
  console.log("\n--- El pie ---");
  const pie = await ev(`
    (() => {
      const t = document.body.innerText;
      const fila = [...document.querySelectorAll('tbody tr')]
        .find((r) => r.querySelector('input[data-campo="venta"]')?.value === '1500');
      return {
        texto: t,
        // La última celda de esa fila es el premio pagado que calcula la pantalla.
        premioPagado: (fila?.querySelectorAll('td')[3]?.textContent || '').trim(),
        botonGuardar: [...document.querySelectorAll('button')]
          .map((b) => b.textContent.trim()).find((x) => /Guardar/.test(x)),
      };
    })()
  `);
  check(
    "el pie dice cuántas filas llevan cifra",
    /1 de \d+/.test(pie.texto),
    (pie.texto.match(/CON CIFRA[\s\S]{0,24}/) || [""])[0],
  );
  check(
    "el premio pagado sale del factor del vendedor",
    /^[\d,]+/.test(pie.premioPagado) && pie.premioPagado !== "—",
    `«${pie.premioPagado}»`,
  );
  check(
    "el botón dice cuántas filas va a guardar",
    /Guardar 1 fila/.test(pie.botonGuardar ?? ""),
    String(pie.botonGuardar),
  );

  // ---------- 4. El filtro recorta ----------
  console.log("\n--- El filtro ---");
  const filtrado = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const antes = document.querySelectorAll('tbody tr').length;
      const casilla = document.querySelector('input[type="checkbox"]');
      casilla.click();
      await esperar(500);
      const despues = document.querySelectorAll('tbody tr').length;
      casilla.click();
      await esperar(300);
      return { antes, despues };
    })()
  `);
  check(
    "ocultar a los que ya vendieron recorta la tabla",
    filtrado.despues < filtrado.antes,
    `${filtrado.antes} -> ${filtrado.despues}`,
  );
  console.log(`        ${filtrado.antes} vendedores · ${filtrado.despues} sin venta por el portal`);
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
