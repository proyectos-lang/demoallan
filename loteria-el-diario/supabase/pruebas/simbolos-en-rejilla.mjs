/**
 * La simbología en la rejilla, en un navegador de verdad.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ NO BASTA CON MIRAR EL CÓDIGO
 * --------------------------------------------------------
 * Lo que de verdad estaba en juego al poner emoji en las celdas era el ALTO.
 * La rejilla del vendedor se rehízo para que los cien números cupieran sin
 * desplazar: antes había que bajar 189px para llegar al 96, y el cliente dicta
 * «el 02 y el 96». Un emoji a tamaño de texto normal, apilado bajo la cifra,
 * empuja la celda de 34px a ~48 y devuelve el desplazamiento.
 *
 * Eso no se comprueba leyendo el JSX: hay que medir la caja renderizada. Por
 * eso esta prueba mueve un Chrome de verdad y lee `getBoundingClientRect`.
 *
 * También se comprueba lo que un grupo promete: que «Animales» marque tigre y
 * vaca y NO marque dinero. Un grupo en el que no se puede confiar es peor que
 * no tenerlo, porque el vendedor deja de revisar lo que cobra.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/simbolos-en-rejilla.mjs
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

// --- Chrome ------------------------------------------------------------------
const perfil = mkdtempSync(join(tmpdir(), "simb-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9372",
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
      const ts = await (await fetch("http://127.0.0.1:9372/json/list")).json();
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
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: cookieDe(uVend),
    domain: "localhost",
    path: "/",
  });

  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(12000);

  /** Mide la rejilla: alto de celda, alto total y si hay que desplazar. */
  const medir = `
    (() => {
      // SOLO las celdas de la rejilla. Los botones de grupo también llevan
      // emoji, y contarlos haría pasar la prueba con la rejilla en números.
      const caja = document.querySelector('div.grid.grid-cols-2');
      const dentro = caja ? [...caja.querySelectorAll('button')] : [];
      // El botón de decena («00–09») se descarta: es más alto a propósito.
      const esCelda = (b) =>
        b.offsetHeight > 0 && !/[0-9]{2}.[0-9]{2}/.test((b.textContent || '').trim());
      const celdas = dentro.filter(
        (b) => esCelda(b) && /^\\s*[0-9]{2}\\s*$/.test(b.textContent || ''),
      );
      const conEmoji = dentro.filter(
        (b) => esCelda(b) && /\\p{Extended_Pictographic}/u.test(b.textContent || ''),
      );
      const todas = dentro.filter(esCelda);
      const alto = todas.length ? Math.max(...todas.map((b) => b.getBoundingClientRect().height)) : 0;
      return {
        celdas: celdas.length,
        conEmoji: conEmoji.length,
        altoCelda: Math.round(alto * 10) / 10,
        altoRejilla: caja ? Math.round(caja.getBoundingClientRect().height) : 0,
        paginaAlta: Math.round(document.documentElement.scrollHeight),
        ventana: window.innerHeight,
      };
    })()
  `;

  // ---------- 1. De entrada, números ----------
  console.log("--- La rejilla arranca en números ---");
  const base = await ev(medir);
  check("se pintan los cien números", base.celdas === 100, `${base.celdas}`);
  check(
    "y ninguno trae emoji todavía",
    base.conEmoji === 0,
    `${base.conEmoji} con figura`,
  );
  const ALTO_BASE = base.altoCelda;
  const REJILLA_BASE = base.altoRejilla;
  console.log(`  (celda ${ALTO_BASE}px · rejilla ${REJILLA_BASE}px)`);

  /** Pulsa uno de los tres botones del mando. */
  const cambiarVista = (etiqueta) => `
    (async () => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').trim() === ${JSON.stringify(etiqueta)});
      if (!b) return { error: 'no existe el botón ' + ${JSON.stringify(etiqueta)} };
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true };
    })()
  `;

  check("existe el mando para cambiar la vista", !(await ev(cambiarVista("Símbolos")))?.error);

  // ---------- 2. Sólo símbolos ----------
  console.log("\n--- Sólo símbolos ---");
  const simb = await ev(medir);
  check(
    "las celdas pasan a mostrar figuras",
    simb.conEmoji >= 90,
    `${simb.conEmoji} con figura`,
  );
  check(
    "la celda NO crece",
    simb.altoCelda <= ALTO_BASE + 0.5,
    `${simb.altoCelda}px contra ${ALTO_BASE}px`,
  );
  check(
    "y la rejilla entera tampoco",
    simb.altoRejilla <= REJILLA_BASE + 2,
    `${simb.altoRejilla}px contra ${REJILLA_BASE}px`,
  );

  // ---------- 3. Número y símbolo a la vez ----------
  console.log("\n--- Número y símbolo ---");
  await ev(cambiarVista("Ambos"));
  const ambos = await ev(medir);
  check(
    "se ven los dos: la cifra y la figura",
    ambos.conEmoji >= 90,
    `${ambos.conEmoji} con figura`,
  );
  check(
    "la celda sigue sin crecer, que es lo que costaba la rejilla",
    ambos.altoCelda <= ALTO_BASE + 0.5,
    `${ambos.altoCelda}px contra ${ALTO_BASE}px`,
  );
  check(
    "la rejilla no empuja la página",
    ambos.altoRejilla <= REJILLA_BASE + 2,
    `${ambos.altoRejilla}px contra ${REJILLA_BASE}px`,
  );
  check(
    "el 96 sigue mostrando su número",
    await ev(`
      (() => {
        const b = [...document.querySelectorAll('button')]
          .find((x) => x.offsetHeight > 0 && x.offsetHeight < 60 &&
                       (x.textContent || '').includes('96'));
        return Boolean(b);
      })()
    `),
  );

  // ---------- 4. Vuelta a números ----------
  console.log("\n--- Vuelta atrás ---");
  await ev(cambiarVista("Números"));
  const vuelta = await ev(medir);
  check("vuelven los cien números", vuelta.celdas === 100, `${vuelta.celdas}`);
  check("y se van las figuras", vuelta.conEmoji === 0, `${vuelta.conEmoji}`);

  // ---------- 5. Los grupos ----------
  console.log("\n--- Las agrupaciones ---");

  const hayGrupos = await ev(`
    (() => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => /Animales|Personas|Dinero/.test(x.textContent || ''));
      return b.length;
    })()
  `);
  check("hay botones de agrupación", hayGrupos >= 3, `${hayGrupos}`);

  /*
   * Se enciende «marcar varios» ANTES de tocar el grupo: sin ese modo el grupo
   * abre la hoja del monto, que es correcto pero tapa la rejilla y no deja
   * contar lo marcado. Con el modo activo, el grupo acumula y las celdas se
   * quedan pintadas, que es justo lo que hay que medir.
   */
  const marcados = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const varios = [...document.querySelectorAll('button')]
        .find((b) => /Marcar varios/.test(b.textContent || ''));
      if (!varios) return { error: 'no está el interruptor de marcar varios' };
      varios.click();
      await esperar(400);

      const grupo = [...document.querySelectorAll('button')]
        .find((b) => /^\\s*\\S*\\s*Animales/.test((b.textContent || '').trim()));
      if (!grupo) return { error: 'no está el grupo Animales' };
      grupo.click();
      await esperar(700);

      // Las celdas marcadas llevan el fondo de acento.
      const marcadas = [...document.querySelectorAll('button')]
        .filter((b) => b.offsetHeight > 0 && b.offsetHeight < 60 &&
                       /^[0-9]{2}$/.test((b.textContent || '').trim()) &&
                       b.className.includes('bg-acento'))
        .map((b) => (b.textContent || '').trim());
      return { marcadas };
    })()
  `);

  if (marcados?.error) {
    check("se pudo probar el grupo", false, marcados.error);
  } else {
    const m = marcados.marcadas ?? [];
    check("al pulsar «Animales» se marcan números", m.length > 0, `${m.length} marcados`);
    check(
      "marca el tigre (04), el perro (11) y la vaca (67)",
      ["04", "11", "67"].every((x) => m.includes(x)),
      `marcados: ${m.slice(0, 30).join(",")}`,
    );
    check(
      "y NO marca dinero (96), casa (85) ni muerto (03)",
      !["96", "85", "03"].some((x) => m.includes(x)),
      `marcados: ${m.join(",")}`,
    );
    check(
      "no marca la rejilla entera",
      m.length < 40,
      `${m.length} de 100`,
    );
  }

  /*
   * Los pares, que es el grupo con la regla mas facil de comprobar y por eso
   * el que mejor delata un fallo: si marca un impar, lo dice el numero.
   *
   * Se limpia antes lo que quedo de «Animales», porque en modo «marcar varios»
   * los grupos ACUMULAN a proposito —marcar animales y anadir el 47 suelto es
   * un caso real— y sin limpiar se contarian los dos grupos juntos.
   */
  console.log("\n--- Los pares ---");

  const dePares = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const limpiar = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === 'Limpiar');
      if (limpiar) { limpiar.click(); await esperar(400); }

      const grupo = [...document.querySelectorAll('button')]
        .find((b) => /Pares/.test(b.textContent || ''));
      if (!grupo) return { error: 'no esta el grupo Pares' };
      grupo.click();
      await esperar(900);

      const caja = document.querySelector('div.grid.grid-cols-2');
      const dentro = caja ? [...caja.querySelectorAll('button')] : [];
      const marcadas = dentro
        .filter((b) => b.offsetHeight > 0 &&
                       /^[0-9]{2}$/.test((b.textContent || '').trim()) &&
                       b.className.includes('bg-acento'))
        .map((b) => (b.textContent || '').trim());
      return { marcadas };
    })()
  `);

  if (dePares?.error) {
    check("se pudo probar el grupo de pares", false, dePares.error);
  } else {
    const p = dePares.marcadas ?? [];
    // «Pares» son los DOBLES: las dos cifras iguales (00,11,…,99).
    const noDobles = p.filter((x) => x[0] !== x[1]);
    check("al pulsar «Pares» se marcan numeros", p.length > 0, `${p.length}`);
    check("son diez", p.length === 10, `${p.length}`);
    check("todos son dobles (dos cifras iguales)", noDobles.length === 0, `no-dobles: ${noDobles.join(",")}`);
    check(
      "estan el 00 y el 99, los extremos",
      p.includes("00") && p.includes("99"),
      `00:${p.includes("00")} 99:${p.includes("99")}`,
    );
    check(
      "y no esta el 98, que no es doble",
      !p.includes("98"),
      "",
    );
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
