/**
 * Al vender, el disponible del número tiene que bajar.
 *
 * EL REPORTE QUE LO MOTIVA
 * ------------------------
 * Un vendedor avisó: «aparece un número con 400 disponibles cuando ya se han
 * vendido diferentes cantidades de ese mismo número. Hice la prueba: le puse
 * cinco, volví a entrar para verificar y nuevamente me sale que hay 400».
 *
 * LA CAUSA, QUE NO ESTABA EN LA BASE
 * ----------------------------------
 * La base siempre estuvo bien: la venta se registra, el cupo se descuenta y
 * `fn_vendido_por_vendedor` lo refleja en el acto. Se comprobó midiendo las
 * dos cosas contra las líneas reales, y no había un solo descuadre.
 *
 * El fallo estaba en la PANTALLA. `datos` llega de un componente de servidor y
 * no se actualiza solo. Mientras se arma la venta, lo que se va a vender se
 * descuenta de `carrito` y `tanda`, así que el número baja bien. Pero al
 * confirmar, esas dos listas se vacían —la venta ya está hecha— y como nadie
 * volvía a pedirle el cupo al servidor, el disponible saltaba de vuelta al
 * valor que tenía al abrir la pantalla. El vendedor veía 200, vendía 5, y
 * seguía viendo 200.
 *
 * La Server Action ya llamaba a `revalidatePath`. Eso invalida la caché del
 * servidor, pero por sí solo no vuelve a pintar nada en el navegador: hacía
 * falta un `router.refresh()` desde el cliente.
 *
 * POR QUÉ ESTA PRUEBA VA EN UN NAVEGADOR
 * --------------------------------------
 * Porque el defecto no se ve desde la base. Contra Postgres todo cuadraba; lo
 * que estaba mal era lo que el vendedor leía en la rejilla. Hay que vender por
 * la pantalla real y volver a leer el número ahí mismo.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/cupo-se-actualiza.mjs
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
const num = (x) => Number(x ?? 0);

/** El número con el que se prueba, y lo que se le vende. */
const NUMERO = 7;
const MONTO = 5;

// --- Un vendedor con acceso y un sorteo abierto ------------------------------
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

const { data: par } = await sb
  .from("parametro_vendedor")
  .select("tope_por_numero")
  .eq("vendedor_id", uVend.vendedor_id)
  .is("vigente_hasta", null)
  .maybeSingle();
const TOPE = num(par?.tope_por_numero);

/** Lo que la base dice que lleva vendido este vendedor en ese número. */
const vendidoEnBase = async () => {
  const { data } = await sb.rpc("fn_vendido_por_vendedor", { p_sorteo_id: abierto.id });
  const f = (data ?? []).find(
    (r) => r.r_vendedor_id === uVend.vendedor_id && Number(r.r_numero) === NUMERO,
  );
  return num(f?.r_vendido);
};

const yaVendido = await vendidoEnBase();
console.log(
  `${conCuenta.r_usuario} · sorteo ${abierto.hora} · número ${String(NUMERO).padStart(2, "0")}`,
);
console.log(`tope ${TOPE} · ya vendido ${yaVendido} · disponible esperado ${TOPE - yaVendido}\n`);

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

const perfil = mkdtempSync(join(tmpdir(), "cupo-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9382",
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
      const ts = await (await fetch("http://127.0.0.1:9382/json/list")).json();
      const t = ts.find((x) => x.type === "page");
      if (t?.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch {
      /* aún no */
    }
    await esperar(250);
  }
  throw new Error("Chrome no abrió el puerto");
}

/** El ticket que cree la prueba, para anularlo al final pase lo que pase. */
let creado = null;
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
  /*
   * ANCHO: por defecto el telefono, que es donde vende el vendedor que
   * reporto. Con ANCHO=1366 se corre la misma prueba sobre la vista de
   * laptop. Las dos rejillas son codigo distinto, asi que conviene poder
   * medir las dos.
   */
  const ANCHO = Number(process.env.ANCHO ?? 390);
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: ANCHO,
    height: ANCHO < 700 ? 844 : 900,
    deviceScaleFactor: 2,
    mobile: ANCHO < 700,
  });
  console.log(`(pantalla de ${ANCHO}px)
`);
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });
  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(13000);

  /*
   * El disponible se lee del `title` de la celda, que dice
   * «07 · Navaja · disponible L 200». Es el mismo texto que ve el vendedor al
   * posar el ratón, así que si esto miente, la pantalla miente.
   */
  const leerDisponible = `
    (() => {
      const caja = document.querySelector('div.grid.grid-cols-2');
      const btns = caja ? [...caja.querySelectorAll('button')] : [];
      const c = btns.find((b) => (b.getAttribute('title') || '')
        .startsWith(${JSON.stringify(String(NUMERO).padStart(2, "0") + " ")}));
      if (!c) return null;
      const m = (c.getAttribute('title') || '').match(/disponible[^0-9]*([0-9.,]+)/);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    })()
  `;

  // ---------- 1. Lo que se ve al abrir ----------
  console.log("--- Al abrir la pantalla ---");
  const antes = await ev(leerDisponible);
  check("se puede leer el disponible del número", antes !== null, `${antes}`);
  check(
    "y coincide con lo que dice la base",
    antes === TOPE - yaVendido,
    `pantalla ${antes} · base ${TOPE - yaVendido}`,
  );

  // ---------- 2. Vender por la pantalla real ----------
  console.log("\n--- Se vende por la pantalla ---");

  const vender = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const caja = document.querySelector('div.grid.grid-cols-2');
      const c = [...caja.querySelectorAll('button')]
        .find((b) => (b.getAttribute('title') || '')
          .startsWith(${JSON.stringify(String(NUMERO).padStart(2, "0") + " ")}));
      if (!c) return { error: 'no está la celda del número' };
      c.click();
      await esperar(1000);

      /*
       * El campo del monto. En el telefono es la hoja que sube, con la
       * etiqueta accesible «Monto para …»; en la laptop es una ventana
       * centrada cuyo campo se rotula con el texto «MONTO (L)» encima, sin
       * etiqueta accesible. Se aceptan los dos: la prueba corre a 1366px,
       * pero atarla a una sola pantalla la volveria fragil el dia que
       * cambie el ancho.
       */
      const campo = [...document.querySelectorAll('input')].find(
        (i) =>
          i.offsetParent !== null &&
          (/^Monto para/.test(i.getAttribute('aria-label') || '') ||
            (i.getAttribute('placeholder') === '0' && i.inputMode === 'numeric')),
      );

      if (campo) {
        // Laptop: el monto se escribe en un campo de texto.
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(campo, ${JSON.stringify(String(MONTO))});
        campo.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        /*
         * Telefono: no hay campo, hay TECLADO. La hoja que sube trae sus
         * propias teclas —del 1 al 9, el 0, C y el borrado— porque el teclado
         * del sistema taparia la mitad de la pantalla. Se pulsa digito a
         * digito, que es literalmente lo que hace el vendedor con el pulgar.
         */
        const hoja = document.querySelector('[role="dialog"][aria-label^="Monto para"]');
        if (!hoja) return { error: 'no se abrio la hoja del monto' };
        for (const d of ${JSON.stringify(String(MONTO))}.split('')) {
          const t = [...hoja.querySelectorAll('button')]
            .find((b) => (b.textContent || '').trim() === d);
          if (!t) return { error: 'no esta la tecla ' + d };
          t.click();
          await esperar(220);
        }
      }
      await esperar(500);

      const agregar = [...document.querySelectorAll('button')]
        .find((b) => b.offsetParent !== null && /Agregar/.test(b.textContent || ''));
      if (!agregar) return { error: 'no está el botón de agregar' };
      agregar.click();
      await esperar(1000);

      const conf = [...document.querySelectorAll('button')]
        .find((b) => b.offsetParent !== null && /Confirmar y registrar/.test(b.textContent || ''));
      if (!conf) return { error: 'no está el botón de confirmar' };
      conf.click();

      // Se espera al recibo, que es la señal de que la venta entró.
      for (let i = 0; i < 40; i++) {
        if (/Venta registrada|Ticket|folio/i.test(document.body.textContent || '')) break;
        await esperar(400);
      }
      await esperar(2500);

      /*
       * Se cierra el recibo. Tras vender, el comprobante tapa la rejilla y la
       * celda del numero no esta en el arbol: sin esto, leer el disponible
       * devuelve null y pareceria un fallo cuando solo esta oculto. «Nueva
       * venta» es el mismo boton que toca el vendedor para seguir atendiendo.
       */
      let nueva = null;
      for (let i = 0; i < 30; i++) {
        nueva = [...document.querySelectorAll('button')]
          .find((b) => b.offsetParent !== null && /Nueva venta/i.test(b.textContent || ''));
        if (nueva) break;
        await esperar(400);
      }
      if (!nueva) return { error: 'no apareció el recibo tras vender' };
      nueva.click();

      // Y se espera a que la rejilla vuelva al arbol antes de medir.
      for (let i = 0; i < 30; i++) {
        if (document.querySelector('div.grid.grid-cols-2')) break;
        await esperar(400);
      }
      await esperar(600);

      return { ok: true };
    })()
  `);

  check("la venta se pudo hacer desde la pantalla", !vender?.error, vender?.error ?? "");

  // Que haya entrado de verdad: contra la base, no contra el texto de la página.
  const vendidoDespues = await vendidoEnBase();
  check(
    "la venta llegó a la base",
    vendidoDespues === yaVendido + MONTO,
    `base: ${yaVendido} -> ${vendidoDespues}, esperado ${yaVendido + MONTO}`,
  );

  const { data: tk } = await sb
    .from("ticket")
    .select("id, folio")
    .eq("sorteo_id", abierto.id)
    .eq("vendedor_id", uVend.vendedor_id)
    .is("anulado_en", null)
    .order("creado_en", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vendidoDespues > yaVendido) creado = tk;

  // ---------- 3. LO QUE SE REPORTÓ: el número en pantalla ----------
  console.log("\n--- El disponible, sin recargar ---");

  /*
   * Se espera a que baje en vez de mirar una sola vez: `router.refresh()` va
   * al servidor y vuelve, y no es instantáneo. Mirar de golpe haría fallar la
   * prueba por lentitud y no por defecto.
   */
  const despues = await ev(`
    (async () => {
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      const leer = () => {
        const caja = document.querySelector('div.grid.grid-cols-2');
        const btns = caja ? [...caja.querySelectorAll('button')] : [];
        const c = btns.find((b) => (b.getAttribute('title') || '')
          .startsWith(${JSON.stringify(String(NUMERO).padStart(2, "0") + " ")}));
        if (!c) return null;
        const m = (c.getAttribute('title') || '').match(/disponible[^0-9]*([0-9.,]+)/);
        return m ? Number(m[1].replace(/,/g, '')) : null;
      };
      let v = leer();
      for (let i = 0; i < 30 && v === ${antes}; i++) {
        await esperar(500);
        v = leer();
      }
      return v;
    })()
  `);

  check(
    "EL DISPONIBLE BAJA: es lo que el vendedor reportó que no pasaba",
    despues === antes - MONTO,
    `${antes} -> ${despues}, esperado ${antes - MONTO}`,
  );
  check(
    "y coincide con lo que dice la base",
    despues === TOPE - vendidoDespues,
    `pantalla ${despues} · base ${TOPE - vendidoDespues}`,
  );
  check(
    "no vuelve al valor de antes de vender",
    despues !== antes,
    `se quedó en ${antes}`,
  );

  // ---------- 4. Y recargando también ----------
  console.log("\n--- Y al recargar ---");
  await cdp("Page.reload", { ignoreCache: true });
  await esperar(13000);
  const recargado = await ev(leerDisponible);
  check(
    "al recargar sigue mostrando lo vendido",
    recargado === TOPE - vendidoDespues,
    `${recargado} · esperado ${TOPE - vendidoDespues}`,
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

  // La venta de prueba no puede quedar jugando de verdad.
  if (creado?.id) {
    const { error } = await sb.rpc("fn_anular_ticket", {
      p_ticket_id: creado.id,
      p_motivo: "prueba cupo-se-actualiza",
      p_usuario_id: uVend.id,
      p_forzar: true,
    });
    console.log(`\n(limpieza: ${creado.folio} ${error ? "NO se anuló: " + error.message : "anulado"})`);
  }
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
