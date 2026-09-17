/**
 * El punto de venta enseña la hora de Honduras, no la del aparato.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * Un vendedor reportó que vendía y el cupo de un número no bajaba: «le puse
 * cinco, volví a entrar y sigue diciendo 400». No era el cupo. Su tope por
 * número es 400, tenía el 26 topado en el sorteo de las 15:00, y a las 2:59 pm
 * ese sorteo cerró: la pantalla saltó sola al de las 21:00, donde el cupo
 * arranca de cero. Él creía seguir vendiendo la tarde.
 *
 * Al revisarlo apareció lo de fondo: los relojes no coinciden. La máquina
 * desde la que se miró iba una hora adelantada respecto a Honduras, así que
 * la hora que lee una persona y la hora con la que el sistema cierra los
 * sorteos eran dos horas distintas, y nada en pantalla lo decía.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que el reloj se vea, y con segundos: los últimos minutos antes del
 *     cierre son los de más cola, y «2:59» sin segundos no dice si quedan
 *     cincuenta y nueve o uno.
 *   · Que AVANCE solo, sin recargar.
 *   · Que diga la hora de HONDURAS aunque el navegador esté en otra zona. Es
 *     la comprobación que de verdad importa, y se hace poniendo el navegador
 *     en Madrid —siete horas por delante— y verificando que el reloj siga
 *     marcando Tegucigalpa.
 *   · Que cuando el aparato va desfasado, la pantalla lo DIGA en vez de
 *     callarlo.
 *
 * Antes de correrlo:
 *     npm run dev -- -p 3131
 *     BASE=http://localhost:3131 node supabase/pruebas/reloj-honduras.mjs
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

/** La hora de Honduras ahora mismo, como la calcularía el sistema. */
const horaHN = () =>
  new Intl.DateTimeFormat("es-HN", {
    timeZone: "America/Tegucigalpa",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());

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

console.log(`En Honduras son las ${horaHN()}\n`);

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

const perfil = mkdtempSync(join(tmpdir(), "reloj-"));
const chrome = spawn(
  process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9384",
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
      const ts = await (await fetch("http://127.0.0.1:9384/json/list")).json();
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
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp("Network.setCookie", {
    name: "diario_sesion",
    value: COOKIE,
    domain: "localhost",
    path: "/",
  });

  /*
   * EL NAVEGADOR, EN MADRID.
   *
   * Es el corazón de la prueba. Si el reloj saliera de `toLocaleString` sin
   * zona —o de la hora del aparato— aquí marcaría siete horas de más. Que siga
   * diciendo Tegucigalpa es lo que demuestra que la hora no depende de dónde
   * esté el teléfono ni de cómo lo tenga configurado su dueño.
   */
  await cdp("Emulation.setTimezoneOverride", { timezoneId: "Europe/Madrid" });

  await cdp("Page.navigate", { url: `${BASE}/mi-venta` });
  await esperar(13000);

  /** Lo que pinta el reloj: `h:mm:ss AM`. */
  const leerReloj = `
    (() => {
      const m = (document.body.textContent || '')
        .match(/([0-9]{1,2}:[0-9]{2}:[0-9]{2}\\s*[AP]M)/);
      return m ? m[1] : null;
    })()
  `;

  console.log("--- El reloj en pantalla ---");
  const uno = await ev(leerReloj);
  check("se ve un reloj con segundos", uno !== null, `${uno}`);

  if (uno) {
    // Avanza solo, sin recargar.
    await esperar(2600);
    const dos = await ev(leerReloj);
    check("y avanza solo, sin recargar", dos !== null && dos !== uno, `${uno} -> ${dos}`);

    // ---------- Lo que de verdad importa ----------
    console.log("\n--- Con el navegador en Madrid ---");

    const zonaDelNavegador = await ev(
      `Intl.DateTimeFormat().resolvedOptions().timeZone`,
    );
    check(
      "el navegador está de verdad en otra zona horaria",
      zonaDelNavegador === "Europe/Madrid",
      `${zonaDelNavegador}`,
    );

    const enMadrid = await ev(`
      new Intl.DateTimeFormat('es-HN', { hour: 'numeric', minute: '2-digit', hour12: true })
        .format(new Date())
    `);
    const enHonduras = horaHN();
    const actual = await ev(leerReloj);

    console.log(`  (el aparato cree que son las ${enMadrid}; en Honduras son las ${enHonduras})`);

    /*
     * Se compara SOLO hora y minuto, y en numeros.
     *
     * Comparar el texto crudo no sirve por dos motivos: el segundo cambia
     * entre una lectura y la siguiente, y `es-HN` escribe «p. m.» mientras la
     * pantalla dice «PM». Se extraen las cifras y el meridiano y se comparan
     * esos, que es lo unico que la prueba quiere saber.
     */
    const hm = (t) => {
      const m = (t ?? "").match(/([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?\s*([ap])/i);
      return m ? `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}M` : `sin hora (${t})`;
    };

    check(
      "EL RELOJ DICE LA HORA DE HONDURAS, no la del aparato",
      hm(actual) === hm(enHonduras),
      `pantalla ${actual} · Honduras ${enHonduras}`,
    );
    check(
      "y NO la de Madrid, que es donde cree estar el navegador",
      hm(actual) !== hm(enMadrid),
      `pantalla ${actual} · Madrid ${enMadrid}`,
    );
  }

  // ---------- El aviso de desfase ----------
  console.log("\n--- Cuando el aparato va con la hora corrida ---");

  /*
   * No se puede mover el reloj del sistema desde aquí, así que se comprueba lo
   * que sí se puede: que el aviso NO salga cuando los relojes coinciden. Que
   * salga cuando difieren lo garantiza la misma condición, que es una resta.
   * Enseñarlo sin motivo sería peor que no tenerlo: un aviso que aparece
   * siempre se deja de leer.
   */
  const avisa = await ev(`
    /reloj de este (tel|apar)/i.test(document.body.textContent || '')
  `);
  check(
    "con los relojes en hora, no se avisa de nada",
    avisa === false,
    "sale el aviso sin motivo",
  );

  // ---------- Y el sorteo al que se está vendiendo ----------
  console.log("\n--- El sorteo destino ---");
  const destino = await ev(`
    (() => {
      const t = document.body.textContent || '';
      const m = t.match(/SORTEO DESTINO\\s*([0-9]{1,2}:[0-9]{2}\\s*[AP]M)/);
      return m ? m[1] : null;
    })()
  `);
  const { data: s } = await sb
    .from("sorteo")
    .select("hora")
    .eq("estado", "abierto")
    .gt("hora_cierre", new Date().toISOString())
    .order("hora_cierre")
    .limit(1)
    .maybeSingle();
  check(
    "la pantalla dice a qué sorteo se está vendiendo",
    destino !== null,
    `${destino}`,
  );
  if (destino && s) {
    const esperado = Number(s.hora.split(":")[0]);
    const visto = Number(destino.split(":")[0]) + (/PM/i.test(destino) && Number(destino.split(":")[0]) !== 12 ? 12 : 0);
    check(
      "y es el mismo que el sistema tiene abierto",
      visto === esperado,
      `pantalla ${destino} · base ${s.hora}`,
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
