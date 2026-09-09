/**
 * El punto de venta del VENDEDOR en una laptop.
 *
 * QUÉ HAY QUE DEMOSTRAR
 * ---------------------
 * Que en una pantalla ancha el vendedor ve EL MISMO flujo que en el teléfono,
 * y no la pantalla de administración:
 *
 *   · La rejilla de 5 en 5 con botón de decena — no la plana de 10×10.
 *   · La casilla «marcar varios números».
 *   · NINGUNA pestaña de modo: el vendedor no elige entre tres formas de
 *     capturar, tiene una.
 *   · Que al elegir números se abra la ventana del monto con el campo YA
 *     ENFOCADO, que es lo que permite teclear sin tocar el ratón.
 *   · Que Enter agregue al ticket.
 *   · Que nada se salga de la pantalla.
 *   · Que LOS CIEN NÚMEROS se vean SIN DESPLAZAR. Es lo que pidió el
 *     vendedor: el cliente dicta «el 02 y el 96» y subir y bajar por cada
 *     número de la lista cuesta segundos con la cola delante.
 *
 * Y que el ADMINISTRADOR conserve la suya: es la mitad que se rompe sin
 * querer al añadir una vista nueva.
 *
 * Antes de correrlo:
 *     npm run build && npm run start -- -p 3119
 *     node supabase/pruebas/pos-vendedor-laptop.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.BASE ?? "http://localhost:3119";

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

const secreto =
  env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
    ? env.SESION_SECRETO
    : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY)
        .update("sesion:diario")
        .digest("base64url");

const cookieDe = (u) => {
  const cuerpo = Buffer.from(
    JSON.stringify({
      id: u.id,
      nombre: u.nombre,
      rol: u.rol,
      vendedor_id: u.vendedor_id,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  return `${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;
};

// Un vendedor con acceso, y un administrador.
const { data: accesos } = await sb.rpc("fn_accesos_vendedor");
const conCuenta = (accesos ?? []).find((a) => a.r_usuario);
if (!conCuenta) {
  console.error("No hay ningún vendedor con acceso creado.");
  process.exit(1);
}
const { data: uVend } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("usuario", conCuenta.r_usuario)
  .single();
const { data: uAdmin } = await sb
  .from("usuario")
  .select("id, nombre, rol, vendedor_id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

// --- Chrome ------------------------------------------------------------------
const perfil = mkdtempSync(join(tmpdir(), "posv-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9340",
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
      const ts = await (await fetch("http://127.0.0.1:9340/json/list")).json();
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
    width: Number(process.env.ANCHO ?? 1366), // la laptop corriente
    height: Number(process.env.ALTO ?? 768),
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ---------- El vendedor ----------
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: cookieDe(uVend),
    domain: "localhost",
    path: "/",
  });
  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(6000);

  console.log("\n--- El vendedor, a 1366px ---");

  const v = await ev(`
    (() => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const botones = [...document.querySelectorAll('button')].filter(visible);
      const texto = (b) => (b.textContent || '').trim();
      // Dos dígitos, sin regex: las barras invertidas se pierden al pasar
      // esta plantilla al navegador y la comprobación buscaba una «d».
      const esNumero = (t) => t.length === 2 && t >= '00' && t <= '99';

      return {
        // El botón de decena: «00–09». Es la firma de la rejilla de 5 en 5.
        decenas: botones.filter((b) =>
          /^\\d{2}[–-]\\d{2}$/.test(texto(b))).length,
        marcarVarios: botones.some((b) => /Marcar varios/i.test(texto(b))),
        // Las pestañas de modo del administrador NO deben estar.
        modos: botones.filter((b) =>
          /^(Número y monto|Línea rápida|Rejilla 00–99)$/.test(texto(b))).length,
        // Los cien números.
        numeros: botones.filter((b) => /^\\d{2}$/.test(texto(b))).length,
        confirmar: botones.some((b) => /Confirmar y registrar/i.test(texto(b))),
        // Cuántos números caben en pantalla sin mover nada, y cuánto habría
        // que desplazar para alcanzar el último.
        numerosVisibles: (() => {
          const alto = document.documentElement.clientHeight;
          return botones.filter((b) => {
            if (!esNumero(texto(b))) return false;
            const r = b.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= alto;
          }).length;
        })(),
        celda: (() => {
          const n = botones.find((b) => esNumero(texto(b)));
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { ancho: Math.round(r.width), alto: Math.round(r.height) };
        })(),
        cerrarTicket: botones.some((b) => /Cerrar ticket/i.test(texto(b))),
        desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()
  `);

  check("la rejilla es de 5 en 5, con botón de decena", v.decenas === 10, `${v.decenas} decenas`);
  check("están los cien números", v.numeros === 100, `${v.numeros}`);
  check("tiene «marcar varios números»", v.marcarVarios === true);
  check("NO tiene las pestañas de modo", v.modos === 0, `${v.modos} pestañas`);
  check("tiene «cerrar ticket»", v.cerrarTicket === true);
  check("tiene «confirmar y registrar»", v.confirmar === true);
  check("nada se sale de la pantalla", v.desborde <= 0, `${v.desborde}px`);
  check(
    "LOS CIEN NÚMEROS SE VEN SIN DESPLAZAR",
    v.numerosVisibles === 100,
    `sólo ${v.numerosVisibles} de 100 caben en pantalla`,
  );
  check(
    "y las celdas siguen siendo cómodas de apuntar",
    v.celda !== null && v.celda.ancho >= 30 && v.celda.alto >= 28,
    v.celda ? `${v.celda.ancho}x${v.celda.alto}px` : "no se midió",
  );

  // El monto: ventana centrada, campo enfocado, Enter agrega.
  const flujo = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const dec = document.querySelector('button[aria-label^="Seleccionar del"]');
      if (!dec) return { error: 'no hay botón de decena' };
      if (dec.disabled) return { error: 'la decena no tiene cupo' };
      dec.click();
      await esperar(500);

      /*
       * EL DIÁLOGO VISIBLE, no el primero que aparezca.
       *
       * Las dos vistas se renderizan siempre y una se oculta por CSS, así
       * que hay DOS elementos con role de diálogo en el árbol: el de la
       * laptop y la hoja del móvil, ésta con altura cero. Coger el primero
       * medía la hoja oculta y daba un centrado falso.
       */
      const dlg = [...document.querySelectorAll('[role="dialog"]')]
        .find((d) => d.getBoundingClientRect().height > 0);
      if (!dlg) return { error: 'no se abrió la ventana' };

      const campo = dlg.querySelector('input');
      const enfocado = document.activeElement === campo;

      // Se mide AHORA, con la ventana abierta: más abajo Enter la cierra y su
      // rectángulo pasa a ser todo ceros.
      const caja = dlg.getBoundingClientRect();
      const centrada =
        Math.abs((caja.top + caja.bottom) / 2 - window.innerHeight / 2) < 90;

      // Se teclea el monto como lo haría una persona y se pulsa Enter.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(campo, '25');
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      await esperar(250);

      campo.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
      await esperar(600);

      return {
        enfocado,
        // Centrada, no pegada abajo como la hoja del móvil.
        centrada,
        cerroTrasEnter: ![...document.querySelectorAll('[role="dialog"]')]
          .some((d) => d.getBoundingClientRect().height > 0),
        // Si Enter agregó, el ticket en curso deja de estar en cero.
        ticket: (document.body.innerText.match(/Ticket en curso\\s*L?\\s*([\\d,.]+)/) || [])[1] || '',
      };
    })()
  `);

  check("al elegir se abre la ventana del monto", !flujo.error, flujo.error ?? "");
  if (!flujo.error) {
    check("el campo llega ENFOCADO (se teclea sin ratón)", flujo.enfocado === true);
    check("la ventana está centrada, no pegada abajo", flujo.centrada === true);
    check("Enter agrega y cierra", flujo.cerroTrasEnter === true);
    check(
      "el ticket recogió el monto",
      flujo.ticket !== "" && flujo.ticket !== "0" && flujo.ticket !== "0.00",
      `ticket: "${flujo.ticket}"`,
    );
  }

  // ---------- El administrador: no debe cambiar ----------
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: cookieDe(uAdmin),
    domain: "localhost",
    path: "/",
  });
  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta` });
  await esperar(6000);

  console.log("\n--- El administrador: NO debe cambiar ---");

  const a = await ev(`
    (() => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const botones = [...document.querySelectorAll('button')].filter(visible);
      const texto = (b) => (b.textContent || '').trim();
      // Dos dígitos, sin regex: las barras invertidas se pierden al pasar
      // esta plantilla al navegador y la comprobación buscaba una «d».
      const esNumero = (t) => t.length === 2 && t >= '00' && t <= '99';
      return {
        modos: botones.filter((b) =>
          /^(Número y monto|Línea rápida|Rejilla 00–99)$/.test(texto(b))).length,
        decenas: botones.filter((b) => /^\\d{2}[–-]\\d{2}$/.test(texto(b))).length,
        desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()
  `);

  check("conserva sus tres modos de captura", a.modos === 3, `${a.modos}`);
  check("y no le aparece la rejilla del vendedor", a.decenas === 0, `${a.decenas} decenas`);
  check("nada se sale de la pantalla", a.desborde <= 0, `${a.desborde}px`);
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
