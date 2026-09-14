/**
 * El filtro de «Ventas registradas» ofrece y filtra también las capturas.
 *
 * LO QUE PASABA
 * -------------
 * Dos síntomas del mismo origen, los dos reportados:
 *
 *   · La lista de vendedores del filtro salía incompleta. Se armaba sólo con
 *     quien tenía TICKETS CON NÚMEROS ese día, así que el vendedor que
 *     únicamente entregó su hoja de papel —captura por totales— no aparecía.
 *     Un día real llegó a tener 67 vendedores con captura y sólo 4 ofrecidos.
 *
 *   · Al elegir un vendedor, la tabla de arriba se recortaba pero la de
 *     capturas seguía mostrándolas todas: se pedían con `p_vendedor_id: null`
 *     y nunca se filtraban.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que un vendedor que SÓLO tiene captura aparezca en el filtro.
 *   · Que al elegirlo se recorten LAS DOS tablas.
 *   · Que elegir a otro deje su captura fuera: si no, «filtrar» no filtra.
 *   · Que sin filtro se vean todas, que es lo que se espera al abrir.
 *
 * POR QUÉ EN UN NAVEGADOR
 * -----------------------
 * La tabla de capturas la pinta un componente de cliente, así que el HTML que
 * devuelve el servidor no la trae: pedir la página con `fetch` da cero filas y
 * no demuestra nada. Hay que dejar que el navegador la pinte y leer el DOM.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     node supabase/pruebas/filtro-con-totales.mjs
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

/*
 * El día con más capturas vivas: es donde el problema se ve.
 *
 * Se busca en vez de fijarlo porque los datos cambian, y una fecha escrita a
 * mano acabaría apuntando a un día sin capturas que no demuestra nada.
 */
const { data: capturas } = await sb
  .from("venta_total")
  .select("vendedor_id, sorteo!inner(fecha)")
  .is("anulado_en", null);

const porDia = new Map();
for (const c of capturas ?? []) {
  const f = c.sorteo?.fecha;
  if (!f) continue;
  if (!porDia.has(f)) porDia.set(f, new Set());
  porDia.get(f).add(c.vendedor_id);
}
const [DIA] = [...porDia.entries()].sort((a, b) => b[1].size - a[1].size)[0] ?? [];

if (!DIA) {
  console.error("No hay ninguna captura por totales viva; no se puede probar.");
  process.exit(1);
}

const { data: totales } = await sb.rpc("fn_ventas_totales_dia", {
  p_fecha: DIA,
  p_vendedor_id: null,
});
const { data: conNumeros } = await sb.rpc("fn_detalle_venta", {
  p_desde: DIA,
  p_hasta: DIA,
  p_vendedores: null,
  p_hora: null,
  p_incluir_anulados: false,
  p_limite: 2000,
});

const conTickets = new Set((conNumeros ?? []).map((x) => x.r_vendedor_id));
const vivas = (totales ?? []).filter((x) => !x.r_anulado);

// Quien SÓLO tiene captura: es el que desaparecía del filtro.
const soloCaptura = vivas.find((x) => !conTickets.has(x.r_vendedor_id));
// Y otro cualquiera con captura, para comprobar que al filtrar se va.
const otro = vivas.find((x) => x.r_vendedor_id !== soloCaptura?.r_vendedor_id);

if (!soloCaptura || !otro) {
  console.error(`El día ${DIA} no tiene el escenario necesario; no se puede probar.`);
  process.exit(1);
}

console.log(
  `Día ${DIA} · ${vivas.length} capturas de ${porDia.get(DIA).size} vendedores\n` +
    `Sólo captura: ${soloCaptura.r_codigo} ${soloCaptura.r_vendedor}\n`,
);

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

const perfil = mkdtempSync(join(tmpdir(), "filtro-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9367",
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
      const ts = await (await fetch("http://127.0.0.1:9367/json/list")).json();
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

  /*
   * Los códigos que se PINTAN en la tabla de capturas.
   *
   * Se mira sólo dentro de esa tarjeta: el buscador lleva la lista completa de
   * vendedores —tiene que ofrecerlos— y buscar un código en toda la página lo
   * encontraría siempre, acusando de un fallo que no existe.
   */
  const capturasDe = async (busca = "") => {
    await cdp("Page.navigate", {
      url: `${BASE}/punto-de-venta?modo=ventas&dia=${DIA}${busca}`,
    });
    await esperar(12000);
    return ev(`
      (() => {
        const titulo = [...document.querySelectorAll('h2')]
          .find((h) => /Capturado por totales/.test(h.textContent || ''));
        if (!titulo) return { error: 'no está el bloque de capturas' };
        const zona = titulo.parentElement;
        const filas = [...zona.querySelectorAll('tbody tr')];
        const codigos = [];
        for (const f of filas) {
          const m = (f.textContent || '').match(/V-[0-9]{3}/);
          if (m && !codigos.includes(m[0])) codigos.push(m[0]);
        }
        return {
          filas: filas.length,
          codigos,
          coletilla: /por totales/.test(document.body.innerText),
        };
      })()
    `);
  };

  // --- Sin filtro: están todas ----------------------------------------------
  console.log("--- Sin filtro ---");
  const todo = await capturasDe();
  check("el bloque de capturas está", !todo.error, todo.error ?? "");
  check(
    "EL VENDEDOR CON SÓLO CAPTURA APARECE",
    todo.codigos?.includes(soloCaptura.r_codigo),
    `${todo.filas} filas · ${(todo.codigos ?? []).slice(0, 6).join(", ")}`,
  );
  check("el otro vendedor también está", todo.codigos?.includes(otro.r_codigo));

  // --- Con filtro: se recorta -----------------------------------------------
  console.log("\n--- Filtrando por el que sólo tiene captura ---");
  const filtrado = await capturasDe(`&vs=${soloCaptura.r_vendedor_id}`);
  check(
    "su captura se sigue viendo",
    filtrado.codigos?.includes(soloCaptura.r_codigo),
    `${(filtrado.codigos ?? []).join(", ")}`,
  );
  check(
    "LA CAPTURA DEL OTRO VENDEDOR YA NO SE VE",
    !filtrado.codigos?.includes(otro.r_codigo),
    `${(filtrado.codigos ?? []).join(", ")}`,
  );
  check(
    "y la tabla se recortó de verdad",
    filtrado.filas < todo.filas,
    `${filtrado.filas} de ${todo.filas}`,
  );

  // --- Y al revés, para descartar una casualidad ----------------------------
  console.log("\n--- Filtrando por el otro ---");
  const alReves = await capturasDe(`&vs=${otro.r_vendedor_id}`);
  check("se ve la suya", alReves.codigos?.includes(otro.r_codigo),
        `${(alReves.codigos ?? []).join(", ")}`);
  check(
    "y no la del primero",
    !alReves.codigos?.includes(soloCaptura.r_codigo),
    `${(alReves.codigos ?? []).join(", ")}`,
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
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
