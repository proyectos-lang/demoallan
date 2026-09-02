/**
 * Histórico sintético del 1 de enero al 18 de agosto de 2026.
 *
 *     node supabase/demo/sembrar-historico.mjs            # siembra y liquida
 *     node supabase/demo/sembrar-historico.mjs resumen    # sólo informa
 *     node supabase/demo/sembrar-historico.mjs borrar     # lo retira entero
 *
 * CÓMO SE ELIGEN LOS NÚMEROS GANADORES
 * ------------------------------------
 * Las apuestas se generan primero y no se tocan. Después, para cada mes, se
 * sortean números ganadores al azar y se comprueba la utilidad resultante; si
 * cae fuera de la banda pedida se vuelve a sortear el mes entero.
 *
 * Es muestreo por rechazo a nivel de mes, y conviene ser explícito sobre lo que
 * significa: NO se amaña ningún sorteo suelto para que gane o pierda. Cada mes
 * es una secuencia de ganadores íntegramente aleatoria; lo único que se hace es
 * quedarse con una de las historias posibles cuyo resultado cae en el rango que
 * el cliente reconoce como suyo. Sin esto, con noventa sorteos al mes el
 * resultado se aplana cerca de la media y nunca se vería un mes en pérdida.
 *
 * El rango alcanzable, medido antes de generar, es de −6 a +5,3 millones por
 * mes; la banda pedida (−2 a +4) queda holgada dentro y el rechazo es bajo.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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

const DESDE = "2026-01-01";
const HASTA = "2026-08-18";
const INTENTOS = 20000;

/**
 * Meses que deben cerrar en pérdida.
 *
 * Sin esto ninguno lo hace: la distribución natural está centrada en +1,5 M y
 * el muestreo acepta el primer resultado dentro de banda, así que ocho meses
 * seguidos salen en verde. Un histórico donde la casa nunca pierde no muestra
 * el riesgo del negocio, que es precisamente lo que el sistema sirve para
 * controlar.
 *
 * Se eligen abril y junio porque ya eran los dos meses más flojos con ganadores
 * al azar (+778 mil y +762 mil): son los que tienen los números más cargados, y
 * por tanto aquellos donde una mala racha es más verosímil.
 */
const ROJO = new Set(["2026-04", "2026-06"]);

const banda = (mes) =>
  ROJO.has(mes)
    ? { min: -2_200_000, max: -600_000 }
    : { min: 300_000, max: 3_500_000 };

const L = (n) =>
  (n < 0 ? "−" : "") + "L " + Math.abs(Math.round(n)).toLocaleString("en-US");

const dias = () => {
  const out = [];
  for (let d = new Date(DESDE + "T12:00:00"); ; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    out.push(iso);
    if (iso === HASTA) break;
  }
  return out;
};

// --- Azar reproducible ------------------------------------------------------
// Con semilla fija, dos corridas producen el mismo histórico. Importa: si el
// gerente pregunta por una cifra concreta, tiene que seguir ahí mañana.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Órdenes ----------------------------------------------------------------

async function borrar() {
  const { data, error } = await sb.rpc("fn_borrar_demo");
  if (error) throw new Error(error.message);
  console.log(data);
}

async function resumen() {
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, fecha, hora, estado, numero_ganador")
    .gte("fecha", DESDE)
    .lte("fecha", HASTA)
    .order("fecha");

  const porMes = new Map();
  for (const s of sorteos ?? []) {
    const m = s.fecha.slice(0, 7);
    const e = porMes.get(m) ?? { total: 0, liquidados: 0 };
    e.total++;
    if (s.estado === "liquidado") e.liquidados++;
    porMes.set(m, e);
  }

  console.log("\nmes       sorteos  liquidados        venta        utilidad");
  let gv = 0,
    gu = 0;
  for (const [m, e] of [...porMes].sort()) {
    // El último día real del mes: `${m}-31` daría 2026-02-31, que no existe.
    // Y nunca más allá del final del histórico, para no mezclar con la
    // operación viva de hoy.
    const [a, me] = m.split("-").map(Number);
    const finMes = new Date(Date.UTC(a, me, 0)).toISOString().slice(0, 10);
    const { data } = await sb.rpc("fn_reporte_totales", {
      p_desde: `${m}-01`,
      p_hasta: finMes > HASTA ? HASTA : finMes,
      p_vendedor_id: null,
      p_hora: null,
    });
    const t = data?.[0] ?? {};
    const v = Number(t.venta ?? 0),
      u = Number(t.utilidad ?? 0);
    gv += v;
    gu += u;
    console.log(
      `${m}   ${String(e.total).padStart(7)}  ${String(e.liquidados).padStart(10)}` +
        `  ${L(v).padStart(14)}  ${L(u).padStart(14)}`,
    );
  }
  console.log(`\ntotal                        ${L(gv).padStart(14)}  ${L(gu).padStart(14)}`);
}

async function sembrar() {
  console.log("1. Padrón de demostración");
  const { data: nv, error: ev } = await sb.rpc("fn_sembrar_vendedores_demo", {
    p_cuantos: 25,
  });
  if (ev) throw new Error(ev.message);
  const { count } = await sb
    .from("vendedor")
    .select("*", { count: "exact", head: true })
    .eq("activo", true);
  console.log(`   ${nv} vendedores nuevos · ${count} activos en total\n`);

  console.log("2. Ventas, día a día");
  const listaDias = dias();
  let tk = 0,
    ln = 0,
    vt = 0;
  const t0 = Date.now();

  for (const [i, f] of listaDias.entries()) {
    const { data, error } = await sb.rpc("fn_sembrar_dia_demo", { p_fecha: f });
    if (error) throw new Error(`${f}: ${error.message}`);
    for (const r of data ?? []) {
      tk += r.tickets;
      ln += r.lineas;
      vt += Number(r.venta);
    }
    if ((i + 1) % 20 === 0 || i === listaDias.length - 1) {
      const seg = (Date.now() - t0) / 1000;
      const resto = (seg / (i + 1)) * (listaDias.length - i - 1);
      console.log(
        `   ${f}  ${String(i + 1).padStart(3)}/${listaDias.length}` +
          `  tickets ${tk.toLocaleString("en-US").padStart(9)}` +
          `  líneas ${ln.toLocaleString("en-US").padStart(9)}` +
          `  venta ${L(vt).padStart(14)}` +
          `  quedan ~${Math.round(resto)}s`,
      );
    }
  }
  console.log(`   generado en ${Math.round((Date.now() - t0) / 1000)}s\n`);

  await liquidar();
}

async function liquidar() {
  console.log("3. Números ganadores y liquidación");

  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, fecha, hora, estado")
    .gte("fecha", DESDE)
    .lte("fecha", HASTA)
    .order("fecha")
    .order("hora");

  if (!sorteos?.length) {
    console.log("   (no hay sorteos en el rango)\n");
    return;
  }

  // Los ya liquidados se deshacen: la primera corrida eligió los ganadores con
  // `fn_peor_escenario`, que devuelve UNA fila —el peor número—, no cien. El
  // guion llenó 99 casillas con cero y eligió a ciegas.
  const liquidados = sorteos.filter((s) => s.estado === "liquidado");
  if (liquidados.length) {
    console.log(`   deshaciendo ${liquidados.length} liquidaciones anteriores…`);
    for (const [i, s] of liquidados.entries()) {
      const { error } = await sb.rpc("fn_desliquidar_demo", { p_sorteo_id: s.id });
      if (error) throw new Error(`deshacer ${s.fecha} ${s.hora}: ${error.message}`);
      if ((i + 1) % 200 === 0) console.log(`     ${i + 1}/${liquidados.length}`);
    }
  }

  // Utilidad del sorteo para cada uno de los 100 números posibles. Es lo que
  // permite buscar una historia completa sin volver a tocar las apuestas.
  console.log(`   leyendo la exposición de ${sorteos.length} sorteos…`);
  const escenarios = new Map();
  for (const [i, s] of sorteos.entries()) {
    const { data, error } = await sb.rpc("fn_utilidad_por_numero", { p_sorteo_id: s.id });
    if (error) throw new Error(`${s.fecha} ${s.hora}: ${error.message}`);
    // Tienen que ser los cien. Si llegan menos, el vector queda con ceros y la
    // elección de ganadores se vuelve arbitraria sin avisar — que es
    // exactamente lo que pasó la primera vez.
    if ((data?.length ?? 0) !== 100) {
      throw new Error(
        `${s.fecha} ${s.hora}: se esperaban 100 números y llegaron ${data?.length ?? 0}`,
      );
    }
    const u = new Array(100).fill(0);
    for (const r of data) u[r.r_numero] = Number(r.r_utilidad);
    escenarios.set(s.id, u);
    if ((i + 1) % 100 === 0) console.log(`     ${i + 1}/${sorteos.length}`);
  }

  // Muestreo por rechazo, mes a mes.
  const meses = new Map();
  for (const s of sorteos) {
    const m = s.fecha.slice(0, 7);
    if (!meses.has(m)) meses.set(m, []);
    meses.get(m).push(s);
  }

  const rnd = prng(20260819);
  const elegidos = new Map();

  console.log("\n   mes       intentos   utilidad del mes");
  for (const [m, lista] of [...meses].sort()) {
    const b = banda(m);
    const centro = (b.min + b.max) / 2;
    let mejor = null;
    let intento = 0;
    for (; intento < INTENTOS; intento++) {
      const nums = lista.map(() => Math.floor(rnd() * 100));
      const u = lista.reduce((a, s, k) => a + escenarios.get(s.id)[nums[k]], 0);
      // Se guarda el más cercano al centro de la banda por si ninguno entra.
      if (mejor === null || Math.abs(u - centro) < Math.abs(mejor.u - centro)) {
        mejor = { u, nums };
      }
      if (u >= b.min && u <= b.max) {
        mejor = { u, nums };
        break;
      }
    }
    lista.forEach((s, k) => elegidos.set(s.id, mejor.nums[k]));
    const dentro = mejor.u >= b.min && mejor.u <= b.max;
    console.log(
      `   ${m}   ${String(intento + 1).padStart(8)}   ${L(mejor.u).padStart(14)}` +
        (ROJO.has(m) ? "   (objetivo: pérdida)" : "") +
        (dentro ? "" : "   ← fuera de banda, se tomó el más cercano"),
    );
  }

  console.log("\n   cerrando y liquidando…");
  const t0 = Date.now();
  let n = 0;
  for (const s of sorteos) {
    // El estado leído al principio puede haber quedado viejo: el ciclo de
    // pg_cron corre cada cinco minutos y cierra por su cuenta todo sorteo
    // `abierto` cuya hora de cierre ya pasó — que son todos los del histórico.
    // Encontrarlo ya cerrado no es un error, es el sistema trabajando.
    const { error: eCerrar } = await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    if (eCerrar && !/está en estado cerrado/.test(eCerrar.message)) {
      throw new Error(`cerrar ${s.fecha} ${s.hora}: ${eCerrar.message}`);
    }
    const { error } = await sb.rpc("fn_liquidar_sorteo", {
      p_sorteo_id: s.id,
      p_numero_ganador: elegidos.get(s.id),
    });
    if (error) throw new Error(`liquidar ${s.fecha} ${s.hora}: ${error.message}`);
    if (++n % 100 === 0) console.log(`     ${n}/${sorteos.length}`);
  }
  console.log(`   ${n} sorteos liquidados en ${Math.round((Date.now() - t0) / 1000)}s\n`);

  await resumen();
}

const orden = process.argv[2] ?? "sembrar";
if (orden === "borrar") await borrar();
else if (orden === "resumen") await resumen();
else if (orden === "liquidar") await liquidar();
else await sembrar();
