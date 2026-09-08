/**
 * La hoja de cobro de saldos por vendedor, en papel.
 *
 * QUÉ SE COMPRUEBA Y POR QUÉ ASÍ
 * ------------------------------
 * Un imprimible no se puede revisar leyendo su HTML: lo que importa es cuántas
 * hojas salen y si se lee lo que tiene que leerse. Se renderiza en Chrome a la
 * medida real de un A4 y se mide.
 *
 *   · CUÁNTAS PÁGINAS. Con 68 vendedores —el padrón de la hoja que se usa hoy—
 *     el vertical debería caber en dos y el apaisado en una, gracias a sus dos
 *     columnas.
 *   · QUE EL ROJO SE IMPRIMA. Es la única señal de qué vendedor cobra en vez
 *     de pagar, y el navegador lo convierte en gris salvo que se le diga que
 *     no. Se comprueba el color calculado, no la clase CSS.
 *   · QUE NO HAYA COLORES DE FONDO por vendedor: se pidieron fuera.
 *   · QUE EL SALDO ANTERIOR EN CERO QUEDE EN BLANCO, que es lo que deja sitio
 *     para anotar a mano.
 *   · QUE SÓLO HAYA CUATRO COLUMNAS.
 *   · QUE NO HAYA NADA MÁS QUE LA TABLA: ni encabezado, ni totales, ni
 *     firmas. Se pidieron fuera, y es lo que gana filas por hoja.
 *
 *     node supabase/pruebas/imprimible-saldos.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// --- El documento, generado con el mismo código que usa la aplicación --------
/*
 * Se transpila el módulo con el TypeScript del proyecto y se carga.
 *
 * Importa que sea EL MISMO código y no una copia: una prueba que reimplementara
 * el imprimible comprobaría su propia reimplementación, y podría pasar mientras
 * lo que sale por la impresora está roto.
 *
 * Sólo hace falta una dependencia —`fechaLargaSinDia` y `pad2` de `lib/format`—
 * y las dos son puras, así que se transpilan igual y se resuelven a mano: el
 * alias `@/` vive en tsconfig y aquí no hay quien lo lea.
 */
const ts = (await import("typescript")).default;

// Una sola carpeta para todo lo transpilado: los módulos se importan entre
// ellos, así que tienen que ser vecinos.
const taller = mkdtempSync(join(tmpdir(), "impr-"));
const urlDe = (f) => new URL(`file:///${f.split("\\").join("/")}`).href;

async function cargar(ruta, destino, sustituciones = {}) {
  let fuente = readFileSync(ruta, "utf8");
  for (const [de, a] of Object.entries(sustituciones)) fuente = fuente.replace(de, a);
  const js = ts.transpileModule(fuente, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const archivo = join(taller, destino);
  writeFileSync(archivo, js, "utf8");
  return import(urlDe(archivo));
}

await cargar("lib/format.ts", "formato.mjs");

const { documentoSaldos } = await cargar(
  "components/liquidacion/imprimible-saldos.ts",
  "imprimible.mjs",
  { '"@/lib/format"': '"./formato.mjs"' },
);

// 68 vendedores, como la hoja real. Unos pocos con arrastre y dos en negativo.
const filas = Array.from({ length: 68 }, (_, i) => ({
  codigo: `V-${String(i + 1).padStart(3, "0")}`,
  nombre: `VENDEDOR ${i + 1}`,
  anterior: i % 7 === 0 ? 11296.25 : 0,
  semana: 1000,
  liquidado: 0,
  actual: i === 20 ? -2015.8 : i === 60 ? -1840.25 : 9650 + i * 137,
}));

const hoja = (orientacion) => ({
  semana: 36,
  desde: "2026-08-31",
  hasta: "2026-09-06",
  filas,
  orientacion,
});

// --- Chrome ------------------------------------------------------------------
const perfil = mkdtempSync(join(tmpdir(), "chr-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9339",
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
      const ts = await (await fetch("http://127.0.0.1:9339/json/list")).json();
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
  await cdp("Emulation.setEmulatedMedia", { media: "print" });

  for (const orientacion of ["vertical", "horizontal"]) {
    const html = documentoSaldos(hoja(orientacion));
    const archivo = join(perfil, `${orientacion}.html`);
    writeFileSync(archivo, html, "utf8");

    // El área útil de un A4 con márgenes de 10mm, en píxeles CSS a 96ppp.
    const [ancho, alto] =
      orientacion === "vertical" ? [755, 1046] : [1103, 698];
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: ancho,
      height: alto,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp("Page.navigate", { url: `file:///${archivo.replace(/\\/g, "/")}` });
    await esperar(1200);

    console.log(`\n--- ${orientacion} ---`);

    const m = await ev(`
      (() => {
        const d = document.documentElement;
        const cabeceras = [...document.querySelectorAll('thead th')]
          .map(t => t.textContent.trim());
        const primera = document.querySelector('tbody tr');
        const celdas = [...primera.children].map(c => c.textContent.trim());

        // El rojo, tal como lo va a pintar la impresora.
        const rojos = [...document.querySelectorAll('td.rojo')]
          .map(t => getComputedStyle(t).color);

        // Fondos de color por vendedor: no debe haber ninguno.
        const conFondo = [...document.querySelectorAll('tbody td')].filter(t => {
          const f = getComputedStyle(t).backgroundColor;
          return f !== 'rgba(0, 0, 0, 0)' && f !== 'transparent';
        }).length;

        // Cuántas filas tienen el saldo anterior vacío.
        const anterioresVacios = [...document.querySelectorAll('tbody tr')]
          .filter(r => r.children[2].textContent.trim() === '').length;

        return {
          // El fondo REAL del contenido, y no 'scrollHeight': ése nunca baja
          // del alto de la ventana, así que una hoja holgada y otra que cabe
          // por los pelos daban el mismo número — y con él no se puede saber
          // si queda margen para un nombre más largo.
          alto: Math.ceil(Math.max.apply(null,
            Array.from(document.body.children, function (e) {
              return e.getBoundingClientRect().bottom;
            }))),
          altoUtil: window.innerHeight,
          paginas: Math.ceil(d.scrollHeight / window.innerHeight),
          columnas: cabeceras.length / (document.querySelectorAll('table').length),
          cabeceras: [...new Set(cabeceras)],
          primeraFila: celdas,
          rojos: [...new Set(rojos)],
          nRojos: rojos.length,
          conFondo,
          anterioresVacios,
          filas: document.querySelectorAll('tbody tr').length,
          tablas: document.querySelectorAll('table').length,
          // Nada fuera de la tabla: ni titular, ni firmas, ni totales. Se
          // mide lo que hay en el cuerpo, no la ausencia de una clase.
          fueraDeTabla: Array.from(document.body.children)
            .filter(function (e) {
              return e.tagName !== 'TABLE' && !e.querySelector('table');
            }).length,
          titulares: document.querySelectorAll('h1, h2, h3').length,
          // Palabras que sólo aparecían en el encabezado y el pie: si alguna
          // sobrevive, es que quedó algo fuera de la tabla.
          textoSuelto: (document.body.innerText.match(
            /Total a cuadrar|Elaborado|Recibido|Emitido|Semana #|Sistema de Control/g) || []
          ).length,
        };
      })()
    `);

    check(`${orientacion}: hay las 68 filas`, m.filas === 68, `${m.filas}`);
    check(
      `${orientacion}: sólo cuatro columnas`,
      m.columnas === 4,
      `${m.columnas}: ${m.cabeceras.join(", ")}`,
    );
    check(
      `${orientacion}: las columnas son las pedidas`,
      JSON.stringify(m.cabeceras) ===
        JSON.stringify(["#", "Vendedor", "Saldo anterior", "Saldo actual"]),
      m.cabeceras.join(" | "),
    );
    check(`${orientacion}: la numeración empieza en 1`, m.primeraFila[0] === "1", m.primeraFila[0]);
    check(
      `${orientacion}: el saldo actual lleva la L`,
      m.primeraFila[3].startsWith("L"),
      m.primeraFila[3],
    );
    check(
      `${orientacion}: EL ROJO SE IMPRIME (no gris)`,
      m.nRojos > 0 && m.rojos.every((c) => /rgb\(204, 0, 0\)/.test(c)),
      `${m.nRojos} celdas: ${m.rojos.join(", ")}`,
    );
    check(`${orientacion}: sin colores de fondo por vendedor`, m.conFondo === 0, `${m.conFondo}`);
    check(
      `${orientacion}: el saldo anterior en cero queda en blanco`,
      m.anterioresVacios > 50,
      `sólo ${m.anterioresVacios} vacíos de 68`,
    );
    check(
      `${orientacion}: NADA fuera de la tabla`,
      m.fueraDeTabla === 0,
      `${m.fueraDeTabla} bloque(s) sueltos`,
    );
    check(`${orientacion}: sin titulares`, m.titulares === 0, `${m.titulares}`);
    check(
      `${orientacion}: sin totales ni firmas ni fecha`,
      m.textoSuelto === 0,
      `${m.textoSuelto} línea(s) de más`,
    );

    // Lo que de verdad decide si la hoja sirve.
    console.log(`        ${m.alto}px de alto sobre ${m.altoUtil} útiles → ${m.paginas} página(s)`);
    if (orientacion === "horizontal") {
      check("horizontal: parte en dos columnas de vendedores", m.tablas === 2, `${m.tablas} tabla(s)`);
      check("horizontal: cabe en una hoja", m.paginas === 1, `${m.paginas} páginas`);
    } else {
      check("vertical: cabe en dos hojas o menos", m.paginas <= 2, `${m.paginas} páginas`);
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
