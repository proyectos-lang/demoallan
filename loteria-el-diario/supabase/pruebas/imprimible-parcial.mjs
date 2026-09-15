/**
 * El papel de SÓLO LO MARCADO.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 * El botón de siempre imprime la semana entera —es el papel que el vendedor
 * firma— y ahora hay un segundo para dejar comprobante de un cierre suelto:
 * «le liquidé la mañana del lunes».
 *
 *   · Que lleve SÓLO los sorteos marcados y ninguno más. Es lo que puede
 *     romperse sin que se note: un papel que dice «lo marcado» y trae la
 *     semana entera se firma igual, y el descuadre aparece después.
 *
 *   · Que la CABECERA diga el rango real de lo impreso. Un comprobante de la
 *     mañana del lunes no puede decir que cubre siete días.
 *
 *   · Que el TOTAL cuadre con sus propias líneas. Si el papel suma la semana
 *     mientras enseña tres sorteos, el vendedor firma una cifra que no puede
 *     comprobar.
 *
 *   · Que quepa en una hoja, como el de la semana.
 *
 * Se genera con el MISMO código que usa la aplicación: una prueba que
 * reimplementara el imprimible comprobaría su propia reimplementación.
 *
 *     node supabase/pruebas/imprimible-parcial.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ts = (await import("typescript")).default;
const taller = mkdtempSync(join(tmpdir(), "liqp-"));
const urlDe = (f) => new URL(`file:///${f.split("\\").join("/")}`).href;

async function cargar(ruta, destino, sust = {}) {
  let fuente = readFileSync(ruta, "utf8");
  for (const [de, a] of Object.entries(sust)) fuente = fuente.replace(de, a);
  const js = ts.transpileModule(fuente, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const archivo = join(taller, destino);
  writeFileSync(archivo, js, "utf8");
  return import(urlDe(archivo));
}

await cargar("lib/format.ts", "formato.mjs");
const { documentoLiquidacion } = await cargar(
  "components/liquidacion/imprimible.ts",
  "imprimible.mjs",
  { '"@/lib/format"': '"./formato.mjs"' },
);

// Una semana entera, como la que se liquida de verdad.
const dias = [
  "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03",
  "2026-09-04", "2026-09-05", "2026-09-06",
];
const todas = dias.flatMap((fecha, d) =>
  ["11:00", "15:00", "21:00"].map((hora, i) => ({
    fecha,
    hora,
    ganador: (d * 7 + i * 13) % 100,
    venta: 1000 + d * 500 + i * 250,
    premiado: i === 0 ? 20 : 0,
    factor: 70,
    comision: (1000 + d * 500 + i * 250) * 0.15,
    premios: i === 0 ? 1400 : 0,
    saldo: (1000 + d * 500 + i * 250) * 0.85 - (i === 0 ? 1400 : 0),
    pagado: false,
  })),
);

/*
 * Lo marcado: la mañana del lunes y los dos sorteos del miércoles.
 *
 * Salteado a propósito —no tres seguidos— porque marcar es libre y el rango
 * del papel se calcula del mínimo y el máximo, no de la primera y la última.
 */
const marcadas = todas.filter(
  (f) =>
    (f.fecha === "2026-08-31" && f.hora === "11:00") ||
    (f.fecha === "2026-09-02" && f.hora !== "21:00"),
);

const esperado = {
  sorteos: marcadas.length,
  desde: "2026-08-31",
  hasta: "2026-09-02",
  saldo: marcadas.reduce((a, f) => a + f.saldo, 0),
};

const html = documentoLiquidacion({
  vendedor: "PHILLIP",
  comisionTasa: 0.15,
  // El rango REAL de lo impreso, no el de la semana.
  desde: esperado.desde,
  hasta: esperado.hasta,
  semana: 36,
  lineas: marcadas,
  abonos: [],
  arrastre: 0,
});

const archivo = join(taller, "parcial.html");
writeFileSync(archivo, html, "utf8");

const perfil = mkdtempSync(join(tmpdir(), "chrp-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--remote-debugging-port=9349", `--user-data-dir=${perfil}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let url;
for (let i = 0; i < 40; i++) {
  try {
    const t = (await (await fetch("http://127.0.0.1:9349/json/list")).json()).find(
      (x) => x.type === "page",
    );
    if (t?.webSocketDebuggerUrl) {
      url = t.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* aún no */
  }
  await esperar(250);
}

const ws = new WebSocket(url);
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
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 744, height: 1015, deviceScaleFactor: 1, mobile: false,
});
await cdp("Page.navigate", { url: urlDe(archivo) });
await esperar(1500);

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

const m = await ev(`
  (() => {
    // Las filas de sorteo: las del detalle que no son un gran total.
    const filas = [...document.querySelectorAll('table.detalle tbody tr')]
      .filter((t) => !t.classList.contains('grantotal'));
    const texto = document.body.innerText;
    const alto = Math.ceil(Math.max.apply(null,
      Array.from(document.body.children, (e) => e.getBoundingClientRect().bottom)));
    return {
      sorteos: filas.length,
      texto,
      alto,
      ancho: document.documentElement.scrollWidth,
      // Los días que aparecen en la celda de fecha.
      dias: [...new Set([...document.querySelectorAll('td.dia')]
        .map((t) => t.textContent.trim()))],
    };
  })()
`);

console.log(`Marcados ${esperado.sorteos} de ${todas.length} sorteos de la semana\n`);

console.log("--- Lleva sólo lo marcado ---");
check(
  "SÓLO LOS SORTEOS MARCADOS, ninguno más",
  m.sorteos === esperado.sorteos,
  `${m.sorteos} filas, esperadas ${esperado.sorteos}`,
);
check(
  "no se cuela el martes, que no se marcó",
  !/01\s*\/?\s*SEP|MARTES/i.test(m.texto),
  "aparece un día sin marcar",
);
check(
  "ni el resto de la semana",
  !/JUEVES|VIERNES|SÁBADO|DOMINGO/i.test(m.texto),
  m.dias.join(" | "),
);

console.log("\n--- La cabecera dice el rango real ---");
check(
  "aparece el primer día marcado",
  /31/.test(m.texto),
  "no se encuentra el 31",
);
check(
  "y el último",
  /\b2\b|02/.test(m.texto),
  "no se encuentra el 2",
);
check(
  "sin prometer días que no lleva",
  !/06|domingo/i.test(m.texto.split("TOTAL")[0] ?? m.texto),
  "la cabecera menciona el final de la semana",
);

console.log("\n--- El total cuadra con sus líneas ---");
const enPapel = await ev(`
  (() => {
    // La última cifra del cuadro de abajo es lo que se entrega.
    const celdas = [...document.querySelectorAll('.resumen td')].map((t) => t.textContent.trim());
    return celdas;
  })()
`);
/*
 * «L 1,662.50» -> 1662.5.
 *
 * La clase va escrita como `[^0-9.-]` y no con `\d`: esta prueba se escribió a
 * través de un heredoc, y ahí el escapado se pierde —quedaba `\\d`, que es una
 * barra literal—. Daba cero números teniendo el cuadro delante.
 */
const numeros = (enPapel ?? [])
  .map((t) => Number(String(t).replace(/[^0-9.-]/g, "")))
  .filter((x) => Number.isFinite(x) && x !== 0);
check(
  "el papel trae un cuadro de totales",
  numeros.length > 0,
  JSON.stringify(enPapel),
);
check(
  `alguna cifra del cuadro es el saldo de lo marcado (${esperado.saldo.toFixed(2)})`,
  numeros.some((x) => Math.abs(x - esperado.saldo) < 1),
  numeros.join(", "),
);

console.log("\n--- Y cabe en una hoja ---");
console.log(`        ${m.alto}px de alto sobre 1015 útiles`);
check("no desborda a lo ancho", m.ancho <= 744, `${m.ancho}px`);
check("CABE EN UNA HOJA", m.alto <= 1015, `${m.alto}px`);

ws.close();
chrome.kill();
await esperar(500);
try {
  rmSync(taller, { recursive: true, force: true });
  rmSync(perfil, { recursive: true, force: true });
} catch {
  /* Windows a veces retiene el perfil un instante */
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
