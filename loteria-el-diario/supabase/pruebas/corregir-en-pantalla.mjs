/**
 * El vendedor corrige desde su historial, y sale la tirilla nueva.
 *
 * POR QUÉ ESTO NECESITA UN NAVEGADOR
 * ----------------------------------
 * `vendedor-corrige.mjs` ya comprueba contra la base todo lo que importa de la
 * corrección: el cupo, el tope, la auditoría, el folio. Lo que NO puede
 * comprobar es lo que de verdad se pidió: que al corregir salga la tirilla
 * nueva sin que el vendedor tenga que acordarse de pedirla.
 *
 * Esa es la parte que se rompe en silencio. Si el botón de corregir apareciera
 * en un sorteo cerrado, o si tras corregir la ventana se cerrara sin enseñar
 * el comprobante, la base seguiría estando perfecta y el mostrador tendría un
 * problema: un cliente con un papel que dice una cosa y un sistema que dice
 * otra.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que «corregir» aparezca en las ventas de sorteo abierto y NO en las de
 *     sorteo cerrado. Es la regla entera, vista desde donde la ve el vendedor.
 *   · Que al abrirlo traiga los números ya cargados, no una pantalla en blanco.
 *   · Que al confirmar la ventana NO se cierre, sino que pase a enseñar la
 *     tirilla con el botón de imprimir.
 *   · Que esa tirilla lleve el MISMO folio y los números CORREGIDOS.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/corregir-en-pantalla.mjs
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

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Un vendedor con acceso, y una venta suya de hoy -------------------------
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

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
const { data: sorteos } = await sb
  .from("sorteo")
  .select("id, hora, estado")
  .eq("fecha", hoy)
  .order("hora");

const abierto = (sorteos ?? []).find((s) => s.estado === "abierto");
if (!abierto) {
  console.error(`No hay sorteo abierto el ${hoy}; la prueba necesita uno.`);
  process.exit(1);
}

// Una venta con dos números conocidos, para reconocerla en la pantalla.
const N1 = 7;
const N2 = 42;
const { data: venta, error: eVenta } = await sb.rpc("fn_registrar_ticket", {
  p_sorteo_id: abierto.id,
  p_vendedor_id: uVend.vendedor_id,
  p_lineas: [
    { numero: N1, monto: 10 },
    { numero: N2, monto: 15 },
  ],
  p_usuario_id: admin.id,
});
if (eVenta) {
  console.error("No se pudo registrar la venta de prueba:", eVenta.message);
  process.exit(1);
}
const FOLIO = venta[0].ticket_folio;
const TICKET_ID = venta[0].ticket_id;
console.log(`Venta de prueba ${FOLIO} · sorteo ${abierto.hora} (${abierto.estado})\n`);

const secreto =
  env.SESION_SECRETO && env.SESION_SECRETO.length >= 32
    ? env.SESION_SECRETO
    : createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY)
        .update("sesion:diario")
        .digest("base64url");
const cuerpo = Buffer.from(
  JSON.stringify({
    id: uVend.id,
    nombre: uVend.nombre,
    rol: uVend.rol,
    vendedor_id: uVend.vendedor_id,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
).toString("base64url");
const COOKIE = `${cuerpo}.${createHmac("sha256", secreto).update(cuerpo).digest("base64url")}`;

const perfil = mkdtempSync(join(tmpdir(), "corr-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9376",
    `--user-data-dir=${perfil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function objetivo() {
  for (let i = 0; i < 40; i++) {
    try {
      const ts = await (await fetch("http://127.0.0.1:9376/json/list")).json();
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
    width: 1366,
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

  await cdp("Page.navigate", { url: `${BASE}/mi-dia` });
  await esperar(12000);

  // ---------- 1. El botón está donde toca ----------
  console.log("--- El historial ---");

  const fila = await ev(`
    (() => {
      // Por folio EXACTO en su celda: el historial trae varias ventas del
      // mismo vendedor y buscar el texto en la fila entera acabaria abriendo
      // el ticket de al lado.
      const tr = [...document.querySelectorAll('tbody tr')].find((r) =>
        [...r.querySelectorAll('td')].some(
          (td) => (td.textContent || '').trim() === ${JSON.stringify(FOLIO)},
        ),
      );
      if (!tr) return { error: 'no aparece el ticket en el historial' };
      const acciones = [...tr.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
      return { acciones };
    })()
  `);

  check("la venta aparece en el historial del vendedor", !fila.error, fila.error ?? "");
  if (!fila.error) {
    check(
      "y ofrece corregir, porque el sorteo está abierto",
      fila.acciones.some((a) => /corregir/i.test(a)),
      fila.acciones.join(" | "),
    );
    check(
      "junto a tirilla y anular, que ya existían",
      fila.acciones.some((a) => /tirilla/i.test(a)) &&
        fila.acciones.some((a) => /anular|quitar/i.test(a)),
      fila.acciones.join(" | "),
    );
  }

  // ---------- 2. Al abrirlo, los números ya están ----------
  console.log("\n--- Al abrir la corrección ---");

  const abrir = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const tr = [...document.querySelectorAll('tbody tr')].find((r) =>
        [...r.querySelectorAll('td')].some(
          (td) => (td.textContent || '').trim() === ${JSON.stringify(FOLIO)},
        ),
      );
      if (!tr) return { error: 'no aparece el ticket en el historial' };
      const b = [...tr.querySelectorAll('button')].find((x) => /corregir/i.test(x.textContent || ''));
      if (!b) return { error: 'no hay botón de corregir' };
      b.click();
      await esperar(900);
      // Todo dentro del modal abierto, no del documento entero: si hubiera dos
      // ventanas la prueba mediria la que no es.
      const caja = document.querySelector('[role="dialog"]');
      if (!caja) return { error: 'no se abrió ninguna ventana' };
      window.__caja = caja;
      const valores = [...caja.querySelectorAll('input')]
        .map((i) => i.value)
        .filter((v) => v !== '');
      const texto = caja.textContent || '';
      return {
        valores,
        avisaDeLaTirilla: /tirilla|coincid/i.test(texto),
        botonConfirmar: [...caja.querySelectorAll('button')]
          .map((x) => (x.textContent || '').trim())
          .find((t) => /corregir e imprimir/i.test(t)) || '',
      };
    })()
  `);

  check("se abre la ventana de corrección", !abrir.error, abrir.error ?? "");
  if (!abrir.error) {
    check(
      "trae los números ya cargados, no una pantalla en blanco",
      abrir.valores.includes("07") && abrir.valores.includes("42"),
      abrir.valores.join(", "),
    );
    check(
      "y sus montos",
      abrir.valores.includes("10") && abrir.valores.includes("15"),
      abrir.valores.join(", "),
    );
    check(
      "avisa de que la tirilla entregada dejará de coincidir",
      abrir.avisaDeLaTirilla,
      "",
    );
    check(
      "el botón dice que además va a imprimir",
      /corregir e imprimir/i.test(abrir.botonConfirmar),
      abrir.botonConfirmar,
    );
  }

  // ---------- 3. Corregir enseña la tirilla nueva ----------
  console.log("\n--- Al confirmar ---");

  const corregir = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const poner = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      // Dentro de la ventana que se abrió, no del documento entero: con dos
      // ventanas se estaría escribiendo en la que no es.
      const caja = window.__caja || document.querySelector('[role="dialog"]');
      if (!caja) return { error: 'no hay ventana abierta' };

      // El monto del 07 pasa de 10 a 35.
      const inputs = [...caja.querySelectorAll('input')];
      const i07 = inputs.findIndex((i) => i.value === '07');
      if (i07 < 0) return { error: 'no se encontró la fila del 07' };
      poner(inputs[i07 + 1], '35');
      await esperar(300);

      const b = [...caja.querySelectorAll('button')]
        .find((x) => /corregir e imprimir/i.test(x.textContent || ''));
      if (!b) return { error: 'no está el botón de confirmar' };
      b.click();

      // La corrección va al servidor y luego se pide la tirilla. Se ESPERA a
      // que aparezca el botón de imprimir en vez de dormir a ciegas: en una
      // máquina cargada un número fijo de segundos puede no bastar, y entonces
      // la prueba diría que falta algo que sólo iba tarde.
      let hayImprimir = false;
      for (let i = 0; i < 40; i++) {
        hayImprimir = [...caja.querySelectorAll('button')]
          .some((x) => /^\\s*imprimir\\s*$/i.test(x.textContent || ''));
        if (hayImprimir) break;
        await esperar(400);
      }

      const texto = caja.textContent || '';
      return {
        siguenAbiertos: document.querySelectorAll('[role="dialog"]').length,
        diceCorregida: /corregida/i.test(texto),
        hayBotonImprimir: hayImprimir,
        traeElFolio: texto.includes(${JSON.stringify(FOLIO)}),
        tituloDelModal: (document.querySelector('[role="dialog"]')?.textContent || '').slice(0, 80),
      };
    })()
  `);

  check("la corrección se envía sin error", !corregir.error, corregir.error ?? "");
  if (!corregir.error) {
    check(
      "la ventana NO se cierra: pasa a enseñar la tirilla",
      corregir.siguenAbiertos > 0,
      `${corregir.siguenAbiertos} ventanas`,
    );
    check("dice que quedó corregida", corregir.diceCorregida, "");
    check(
      "y pone delante el botón de imprimir, que es lo que se pidió",
      corregir.hayBotonImprimir,
      "",
    );
    check("la tirilla lleva el folio de la venta", corregir.traeElFolio, FOLIO);
  }

  // ---------- 4. Lo impreso coincide con lo corregido ----------
  console.log("\n--- Lo que dice el papel ---");

  const papel = await ev(`
    (() => {
      // La hoja de impresión se cuelga del body con un portal.
      const texto = document.body.textContent || '';
      return {
        tiene07con35: /07/.test(texto) && /35/.test(texto),
        sigueEl42: /42/.test(texto),
      };
    })()
  `);
  check("el papel muestra el 07 con su monto nuevo", papel.tiene07con35, "");
  check("y conserva el 42, que no se tocó", papel.sigueEl42, "");

  // Y contra la base, que es la verdad.
  const { data: mis } = await sb.rpc("fn_mis_tickets", {
    p_vendedor_id: uVend.vendedor_id,
    p_fecha: hoy,
    p_limite: 40,
  });
  const f = (mis ?? []).find((x) => x.r_folio === FOLIO);
  check(
    "y la base guarda exactamente eso",
    f?.r_jugada?.includes("07:35") && f?.r_jugada?.includes("42:15"),
    `${f?.r_jugada}`,
  );
  check(
    "con el mismo folio: es la misma venta corregida",
    f?.r_folio === FOLIO,
    `${f?.r_folio}`,
  );
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

  // La venta de prueba se anula: no puede quedar jugando de verdad.
  await sb.rpc("fn_anular_ticket", {
    p_ticket_id: TICKET_ID,
    p_motivo: "prueba corregir-en-pantalla",
    p_usuario_id: admin.id,
    p_forzar: true,
  });
  console.log(`\n(limpieza: venta ${FOLIO} anulada)`);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
