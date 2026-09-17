/**
 * La pestaña de saldos y la hoja del vendedor dicen lo mismo del arrastre.
 *
 * EL CASO DE V-047
 * ----------------
 * Debía 30.255,25 de apertura; esa semana la casa le quedó debiendo 9.177.
 * Tras el cierre, la impresión rebajaba —21.078— pero la pestaña de saldos
 * seguía mostrando «anterior 30.255», sin restar el negativo de la semana.
 *
 * Las dos pantallas colocaban el saldo de apertura en semanas distintas: la
 * hoja lo trata como pendiente de su semana y lo compensa; saldos lo metía
 * entero en «anterior», con el negativo en otra columna, sin restarlo.
 *
 * Y había un fallo más hondo: un saldo de apertura de una semana SIN ventas no
 * salía en la hoja ni se arrastraba, porque esa semana no existía como fila.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que un saldo de apertura de una semana sin ventas salga en la hoja y se
 *     arrastre a la semana en curso (0101).
 *   · Que «anterior» de saldos == «arrastre» de la hoja, y «actual» ==
 *     «acumulado» (0102). Es lo que pidió el usuario.
 *   · Que la apertura de la semana EN CURSO baje a «de la semana», no a
 *     «anterior»: es la pieza que hacía discrepar las cifras.
 *   · Que el caso simple —sin apertura— siga coincidiendo.
 *
 *     node supabase/pruebas/saldos-cuadra-hoja.mjs
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
const num = (x) => Number(x ?? 0);
const cerca = (a, b, t = 0.02) => Math.abs(a - b) <= t;
const iso = (d) => d.toLocaleDateString("en-CA");

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

// La semana en curso del sistema, y la anterior, calculadas desde la hoja.
const { data: semG } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: null });
const SEM_ACT = semG[0].r_inicio;
const FIN_ACT = semG[0].r_fin;
const lunes = new Date(`${SEM_ACT}T12:00:00`);
// Apertura en la semana ANTERIOR: el jueves de esa semana.
const APERTURA_ANTES = iso(new Date(lunes.getTime() - 4 * 86400000));
const SEM_ANT = iso(new Date(lunes.getTime() - 7 * 86400000));
// Y una apertura DE la semana en curso, para el segundo caso.
const APERTURA_ESTA = iso(new Date(lunes.getTime() + 2 * 86400000));
const MONTO = 30000;
const COD = "V-975";

let vid = null;
const limpiar = async () => {
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", COD).maybeSingle();
  if (!v) return;
  await sb.from("saldo_inicial").delete().eq("vendedor_id", v.id);
  await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("vendedor").delete().eq("id", v.id);
};

const hojaDe = async (semanaInicio) => {
  const { data } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: vid });
  return (data ?? []).find((s) => s.r_inicio === semanaInicio);
};
const saldosDe = async (desde, hasta) => {
  const { data } = await sb.rpc("fn_saldos_por_vendedor", { p_desde: desde, p_hasta: hasta });
  return (data ?? []).find((f) => f.r_vendedor_id === vid);
};

try {
  await limpiar();

  console.log(`1. Vendedor con apertura de la semana anterior (${APERTURA_ANTES})`);
  const { data: nv } = await sb
    .from("vendedor")
    .insert({ codigo: COD, nombre: "REPRO SALDO", ciudad: "Choloma", zona: "p", color: "#4f46e5", activo: true })
    .select("id")
    .single();
  vid = nv.id;
  await sb
    .from("parametro_vendedor")
    .insert({ vendedor_id: vid, comision: 0.15, factor_pago: 70, tope_por_numero: 99999 });

  await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vid,
    p_monto: MONTO,
    p_vigente_desde: APERTURA_ANTES,
    p_usuario_id: admin.id,
  });

  // --- La apertura de una semana sin ventas sale y se arrastra (0101) -----
  console.log("\n2. La apertura de una semana sin ventas sale y se arrastra");
  const enAnt = await hojaDe(SEM_ANT);
  check("la semana de sólo apertura aparece en la hoja", Boolean(enAnt), "no salió fila");
  if (enAnt)
    check("su acumulado es el saldo cargado", cerca(num(enAnt.r_acumulado), MONTO), `${num(enAnt.r_acumulado)}`);

  const hoja = await hojaDe(SEM_ACT);
  const saldos = await saldosDe(SEM_ACT, FIN_ACT);
  check(
    "se arrastra hasta la semana en curso",
    cerca(num(hoja?.r_arrastre), MONTO),
    `arrastre ${num(hoja?.r_arrastre)}`,
  );

  // --- LO QUE PIDIÓ EL USUARIO: las dos pantallas cuadran (0102) ----------
  console.log("\n3. Saldos cuadra con la hoja");
  check(
    "«anterior» de saldos == «arrastre» de la hoja",
    cerca(num(saldos?.r_anterior), num(hoja?.r_arrastre)),
    `anterior ${num(saldos?.r_anterior)} vs arrastre ${num(hoja?.r_arrastre)}`,
  );
  check(
    "«actual» de saldos == «acumulado» de la hoja",
    cerca(num(saldos?.r_actual), num(hoja?.r_acumulado)),
    `actual ${num(saldos?.r_actual)} vs acumulado ${num(hoja?.r_acumulado)}`,
  );

  // --- La apertura de ESTA semana va a «de la semana», no a «anterior» ----
  console.log("\n4. La apertura de la semana en curso no se cuenta como anterior");
  await sb.from("saldo_inicial").delete().eq("vendedor_id", vid);
  await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vid,
    p_monto: MONTO,
    p_vigente_desde: APERTURA_ESTA,
    p_usuario_id: admin.id,
  });
  const s2 = await saldosDe(SEM_ACT, FIN_ACT);
  const h2 = await hojaDe(SEM_ACT);
  check(
    "en «anterior» no aparece: es de esta semana, no de antes",
    cerca(num(s2?.r_anterior), 0),
    `anterior ${num(s2?.r_anterior)}`,
  );
  check(
    "baja a «de la semana»",
    cerca(num(s2?.r_semana), MONTO),
    `semana ${num(s2?.r_semana)}`,
  );
  check(
    "y el «actual» sigue coincidiendo con el «acumulado» de la hoja",
    cerca(num(s2?.r_actual), num(h2?.r_acumulado)),
    `actual ${num(s2?.r_actual)} vs acumulado ${num(h2?.r_acumulado)}`,
  );

  // --- El caso simple no se rompe -----------------------------------------
  console.log("\n5. Sin apertura, siguen coincidiendo");
  const { data: aperturas } = await sb
    .from("saldo_inicial")
    .select("vendedor_id")
    .is("anulado_en", null)
    .is("saldado_en", null);
  const conAp = new Set((aperturas ?? []).map((a) => a.vendedor_id));
  const { data: todos } = await sb.rpc("fn_saldos_por_vendedor", { p_desde: SEM_ACT, p_hasta: FIN_ACT });
  let comparados = 0;
  let discrepan = 0;
  for (const f of todos ?? []) {
    if (conAp.has(f.r_vendedor_id)) continue;
    const { data: h } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: f.r_vendedor_id });
    const fila = (h ?? []).find((x) => x.r_inicio === SEM_ACT);
    if (!fila) continue;
    comparados++;
    if (!cerca(num(f.r_anterior), num(fila.r_arrastre))) discrepan++;
    if (comparados >= 15) break;
  }
  check(`en ${comparados} vendedores sin apertura, anterior == arrastre`, discrepan === 0, `${discrepan} discrepan`);
} finally {
  console.log("\n6. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
