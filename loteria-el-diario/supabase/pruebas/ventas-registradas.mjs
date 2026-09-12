/**
 * La pestaña «Ventas registradas»: buscar por alias y una tabla que no crece.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ EN UN NAVEGADOR
 * -------------------------------------------
 *   · Que el filtro de vendedor sea un BUSCADOR y no un muro de botones. Con
 *     ochenta vendedores el muro ocupaba más que la tabla que se venía a
 *     mirar, y estaba ordenado por código —lo que nadie recuerda—.
 *
 *   · Que escribiendo el ALIAS aparezca el vendedor.
 *
 *   · Que LA TABLA NO CREZCA SIN FIN: un día de seiscientas ventas estiraba la
 *     tarjeta hasta dejar el resumen de arriba a media pantalla de distancia.
 *     Se mide de verdad, contra el alto de la ventana.
 *
 *   · Que la cabecera de columnas se quede pegada arriba al recorrerla: sin
 *     eso, a la fila doscientas ya no se sabe qué columna es cuál.
 *
 * Nada de esto se puede demostrar leyendo el código: diría que está escrito,
 * no que funciona.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     node supabase/pruebas/ventas-registradas.mjs
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
 * Un día con MUCHAS ventas, que es el que hace visible el problema.
 *
 * Se busca el día real con más tickets en vez de fijar una fecha: los datos de
 * demostración cambian, y una fecha escrita a mano acabaría apuntando a un día
 * vacío que no demuestra nada.
 */
const { data: dias } = await sb
  .from("ticket")
  .select("sorteo_id, sorteo!inner(fecha)")
  .is("anulado_en", null)
  .limit(4000);

const cuenta = new Map();
for (const t of dias ?? []) {
  const f = t.sorteo?.fecha;
  if (f) cuenta.set(f, (cuenta.get(f) ?? 0) + 1);
}
const [DIA, CUANTAS] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];

if (!DIA) {
  console.error("No hay ninguna venta registrada; no se puede probar.");
  process.exit(1);
}

// El alias de alguien que vendió ESE día: si no vendió, no sale en el filtro.
const { data: delDia } = await sb.rpc("fn_detalle_venta", {
  p_desde: DIA,
  p_hasta: DIA,
  p_vendedores: null,
  p_hora: null,
  p_incluir_anulados: false,
  p_limite: 2000,
});

const unVendedor = (delDia ?? [])[0];
if (!unVendedor) {
  console.error(`El día ${DIA} no tiene ventas; no se puede probar.`);
  process.exit(1);
}

console.log(`Día ${DIA} · ${CUANTAS} tickets · buscando «${unVendedor.r_vendedor}»\n`);

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

const perfil = mkdtempSync(join(tmpdir(), "ventas-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9357",
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
      const ts = await (await fetch("http://127.0.0.1:9357/json/list")).json();
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

  const ALTO = 900;
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: ALTO,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta?modo=ventas&dia=${DIA}` });
  await esperar(11000);

  // ---------- 1. La pestaña carga ----------
  console.log("--- La pestaña ---");
  const cargó = await ev(`
    (() => ({
      pestaña: [...document.querySelectorAll('button')]
        .some((b) => /Ventas registradas/.test(b.textContent || '')),
      filas: document.querySelectorAll('tbody tr').length,
      texto: (document.body.innerText || '').slice(0, 200),
    }))()
  `);
  check("la pestaña «Ventas registradas» está", cargó.pestaña === true, cargó.texto);
  check("y trae ventas", cargó.filas > 0, `${cargó.filas} filas`);

  // ---------- 2. El filtro es un buscador ----------
  console.log("\n--- El filtro de vendedor ---");
  const hayBuscador = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const boton = [...document.querySelectorAll('button')]
        .find((b) => b.getAttribute('aria-haspopup') === 'listbox');
      if (!boton) return { error: 'no hay combobox de vendedor' };
      boton.click();
      await esperar(400);
      return { abrio: !!document.querySelector('input[role="combobox"]') };
    })()
  `);
  check("el filtro es un buscador, no un muro de botones", !hayBuscador.error,
        hayBuscador.error ?? "");
  check("se abre al pulsarlo", hayBuscador.abrio === true);

  if (!hayBuscador.error) {
    // Se escribe el rótulo tal como lo muestra la base: si el vendedor tiene
    // alias, eso ES el alias.
    const ROTULO = unVendedor.r_vendedor;
    await ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        const campo = document.querySelector('input[role="combobox"]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(campo, ${JSON.stringify(ROTULO.slice(0, 6))});
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        await esperar(500);
      })()
    `);

    const res = await ev(`
      (() => {
        const ops = [...document.querySelectorAll('[role="option"]')];
        return {
          cuantas: ops.length,
          textos: ops.map((o) => (o.textContent || '').trim()).slice(0, 5),
        };
      })()
    `);
    check(
      `escribiendo «${ROTULO.slice(0, 6)}» aparece el vendedor`,
      res.textos.some((t) => t.includes(ROTULO.slice(0, 6))),
      `${res.cuantas}: ${res.textos.join(" | ")}`,
    );
    check("la opción enseña el código, para saber quién es",
          res.textos.some((t) => t.includes(unVendedor.r_codigo)),
          res.textos.join(" | "));
    check("y dice cuántos tickets tiene ese día",
          res.textos.some((t) => /ticket/.test(t)),
          res.textos.join(" | "));

    // Elegirlo lo convierte en ficha y filtra la tabla.
    await ev(`
      (async () => {
        const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelectorAll('[role="option"]')[0]?.click();
        await esperar(2500);
      })()
    `);
    const trasElegir = await ev(`
      (() => ({
        url: location.search,
        ficha: [...document.querySelectorAll('button')]
          .some((b) => /Quitar a /.test(b.getAttribute('aria-label') || '')),
        filas: document.querySelectorAll('tbody tr').length,
      }))()
    `);
    check("al elegirlo baja a una ficha que se puede quitar", trasElegir.ficha === true);
    check("y queda en la dirección, para poder compartirla",
          /vs=/.test(trasElegir.url), trasElegir.url);
    check("la tabla se recorta al vendedor elegido",
          trasElegir.filas > 0 && trasElegir.filas < cargó.filas,
          `${trasElegir.filas} de ${cargó.filas}`);
  }

  // ---------- 3. La tabla no crece sin fin ----------
  console.log("\n--- El alto de la tabla ---");
  await cdp("Page.navigate", { url: `${BASE}/punto-de-venta?modo=ventas&dia=${DIA}` });
  await esperar(11000);

  const alto = await ev(`
    (() => {
      const tabla = document.querySelector('tbody');
      if (!tabla) return { error: 'no hay tabla' };
      // El contenedor que recorta: el que tiene overflow y contiene la tabla.
      let caja = tabla.parentElement;
      while (caja && getComputedStyle(caja).overflowY === 'visible') caja = caja.parentElement;
      const r = caja ? caja.getBoundingClientRect() : null;
      return {
        filas: tabla.querySelectorAll('tr').length,
        altoCaja: r ? Math.round(r.height) : null,
        seRecorre: caja ? caja.scrollHeight > caja.clientHeight + 4 : false,
        altoPagina: Math.round(document.documentElement.scrollHeight),
        ventana: window.innerHeight,
      };
    })()
  `);

  check("se encuentra la tabla", !alto.error, alto.error ?? "");
  if (!alto.error) {
    console.log(
      `        ${alto.filas} filas · caja de ${alto.altoCaja}px en una ventana de ${alto.ventana}px`,
    );
    check(
      "LA TABLA SE QUEDA DENTRO DE LA PANTALLA",
      alto.altoCaja !== null && alto.altoCaja <= alto.ventana,
      `${alto.altoCaja}px > ${alto.ventana}px`,
    );
    check(
      "y se recorre por dentro en vez de estirar la página",
      alto.seRecorre === true,
      `filas: ${alto.filas}`,
    );
  }

  // ---------- 4. La cabecera se queda pegada ----------
  console.log("\n--- La cabecera al recorrer ---");
  const pegada = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const th = document.querySelector('thead th');
      if (!th) return { error: 'no hay cabecera' };
      const antes = Math.round(th.getBoundingClientRect().top);
      let caja = document.querySelector('tbody').parentElement;
      while (caja && getComputedStyle(caja).overflowY === 'visible') caja = caja.parentElement;
      caja.scrollTop = 600;
      await esperar(400);
      const despues = Math.round(th.getBoundingClientRect().top);
      return { antes, despues, sePega: getComputedStyle(document.querySelector('thead')).position };
    })()
  `);
  if (!pegada.error) {
    console.log(`        cabecera en ${pegada.antes}px, tras recorrer en ${pegada.despues}px`);
    check(
      "LA CABECERA SE QUEDA A LA VISTA al recorrer",
      Math.abs(pegada.despues - pegada.antes) <= 4,
      `se movió ${Math.abs(pegada.despues - pegada.antes)}px`,
    );
  } else {
    check("se encuentra la cabecera", false, pegada.error);
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
