/**
 * Simulador de escenarios.
 *
 * Lo que se pone a prueba:
 *   1. Que con los parámetros REALES el escenario dé exactamente lo real. Si
 *      no, cualquier diferencia que muestre después es ruido del cálculo y no
 *      consecuencia de lo que el usuario movió.
 *   2. Que el premio simulado sea exacto —los mismos aciertos por el factor
 *      alterno— y no una regla de tres sobre un factor promedio.
 *   3. Que los parámetros reales del rango se ponderen POR VENTA: un vendedor
 *      que vende poco no puede pesar igual que uno que vende mucho.
 *
 *     PW=<clave-admin> node supabase/pruebas/simulador.mjs
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
  db: { schema: "allan" },
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});

const FECHAS = ["2092-02-10", "2092-03-10"];
const DESDE = "2092-01-01";
const HASTA = "2092-12-31";
const GANADOR = 55;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
const cerca = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

const limpiar = async () => {
  for (const f of FECHAS) {
    const { data: ss } = await sb.from("sorteo").select("id").eq("fecha", f);
    for (const s of ss ?? []) {
      await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
      const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
      for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
      await sb.from("ticket").delete().eq("sorteo_id", s.id);
      await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
      await sb.from("sorteo").delete().eq("id", s.id);
    }
  }
};

try {
  await limpiar();

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");
  const par = (v) => (Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor);
  const [v1, v2] = vs;
  const p1 = par(v1), p2 = par(v2);

  console.log("\n1. Montaje: dos vendedores con volúmenes MUY distintos");
  console.log(`   ${v1.codigo}: comisión ${(p1.comision * 100).toFixed(2)}% · factor ${p1.factor_pago}`);
  console.log(`   ${v2.codigo}: comisión ${(p2.comision * 100).toFixed(2)}% · factor ${p2.factor_pago}`);

  // v1 vende 10 veces más que v2: así el promedio ponderado y el simple no
  // pueden coincidir, y se puede comprobar cuál usa la función.
  const VENTA_V1 = 1000, VENTA_V2 = 100;
  const GANA_V1 = 100, GANA_V2 = 10;

  let ventaTotal = 0, comisionReal = 0, premiosReal = 0, ganadorTotal = 0;

  for (const fecha of FECHAS) {
    await sb.rpc("fn_programar_dia", { p_fecha: fecha });
    const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", fecha);
    const id = ss.find((s) => s.hora === "20:00").id;
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: id, p_limite_por_numero: 900000 });

    for (const [v, p, venta, gana] of [
      [v1, p1, VENTA_V1, GANA_V1],
      [v2, p2, VENTA_V2, GANA_V2],
    ]) {
      const e = (await sb.rpc("fn_registrar_ticket", {
        p_sorteo_id: id, p_vendedor_id: v.id,
        p_lineas: [{ numero: GANADOR, monto: gana }, { numero: 7, monto: venta - gana }],
      })).error;
      if (e) throw new Error(`venta ${v.codigo}: ${e.message}`);

      ventaTotal += venta;
      comisionReal += venta * Number(p.comision);
      premiosReal += gana * Number(p.factor_pago);
      ganadorTotal += gana;
    }

    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: id });
    const e = (await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: id, p_numero_ganador: GANADOR })).error;
    if (e) throw new Error(`liquidar ${fecha}: ${e.message}`);
  }

  const utilidadReal = ventaTotal - comisionReal - premiosReal;
  console.log(`   venta ${ventaTotal} · comisión ${comisionReal.toFixed(2)} · premios ${premiosReal}`);

  await admin.auth.signInWithPassword({ email: "admin@eldiario.hn", password: process.env.PW });

  console.log("\n2. Parámetros reales del rango, ponderados por venta");
  const { data: pond, error: ePond } = await admin.rpc("fn_parametros_ponderados", {
    p_desde: DESDE, p_hasta: HASTA,
  });
  if (ePond) throw new Error(ePond.message);

  const comisionPond = comisionReal / ventaTotal;
  const factorPond = premiosReal / ganadorTotal;
  const promedioSimple = (Number(p1.comision) + Number(p2.comision)) / 2;

  check("comisión ponderada", cerca(pond[0].comision_ponderada, comisionPond, 0.0001),
    `${pond[0].comision_ponderada} vs ${comisionPond}`);
  check("factor ponderado", cerca(pond[0].factor_ponderado, factorPond, 0.0001),
    `${pond[0].factor_ponderado} vs ${factorPond}`);
  check(
    "pondera por venta, NO promedio simple de vendedores",
    !cerca(pond[0].comision_ponderada, promedioSimple, 0.0001),
    `ponderada ${Number(pond[0].comision_ponderada).toFixed(5)} · promedio simple ${promedioSimple.toFixed(5)}`,
  );

  console.log("\n3. Con los parámetros reales, el escenario NO debe mover nada");
  const { data: neutro, error: eNeutro } = await admin.rpc("fn_simular", {
    p_desde: DESDE, p_hasta: HASTA,
    p_comision: comisionPond, p_factor: factorPond,
  });
  if (eNeutro) throw new Error(eNeutro.message);

  const sumaNeutro = neutro.reduce(
    (a, m) => ({
      real: a.real + Number(m.utilidad_real),
      sim: a.sim + Number(m.utilidad_sim),
      comR: a.comR + Number(m.comision_real),
      comS: a.comS + Number(m.comision_sim),
      preR: a.preR + Number(m.premios_real),
      preS: a.preS + Number(m.premios_sim),
    }),
    { real: 0, sim: 0, comR: 0, comS: 0, preR: 0, preS: 0 },
  );

  check("utilidad simulada = utilidad real", cerca(sumaNeutro.sim, sumaNeutro.real),
    `${sumaNeutro.sim} vs ${sumaNeutro.real}`);
  check("comisión simulada = comisión real", cerca(sumaNeutro.comS, sumaNeutro.comR));
  check("premios simulados = premios reales", cerca(sumaNeutro.preS, sumaNeutro.preR));
  check("y la utilidad real coincide con la cuenta a mano", cerca(sumaNeutro.real, utilidadReal),
    `${sumaNeutro.real} vs ${utilidadReal}`);

  console.log("\n4. Escenario alterno: comisión 20 % y factor 50");
  const COM_ALT = 0.20, FACTOR_ALT = 50;
  const { data: alt, error: eAlt } = await admin.rpc("fn_simular", {
    p_desde: DESDE, p_hasta: HASTA, p_comision: COM_ALT, p_factor: FACTOR_ALT,
  });
  if (eAlt) throw new Error(eAlt.message);

  const sumaAlt = alt.reduce(
    (a, m) => ({
      venta: a.venta + Number(m.venta),
      comS: a.comS + Number(m.comision_sim),
      preS: a.preS + Number(m.premios_sim),
      utiS: a.utiS + Number(m.utilidad_sim),
    }),
    { venta: 0, comS: 0, preS: 0, utiS: 0 },
  );

  // Cuentas a mano: la comisión sobre la misma venta, y el premio con los
  // mismos aciertos multiplicados por el factor alterno.
  const comisionEsperada = ventaTotal * COM_ALT;
  const premiosEsperados = ganadorTotal * FACTOR_ALT;

  check("la venta no cambia (es el supuesto del simulador)", cerca(sumaAlt.venta, ventaTotal));
  check("comisión simulada = venta × comisión alterna", cerca(sumaAlt.comS, comisionEsperada),
    `${sumaAlt.comS} vs ${comisionEsperada}`);
  check(
    "premio simulado = montos ganadores × factor alterno (exacto, sin promedios)",
    cerca(sumaAlt.preS, premiosEsperados),
    `${sumaAlt.preS} vs ${premiosEsperados}`,
  );
  check("utilidad simulada cuadra", cerca(sumaAlt.utiS, ventaTotal - comisionEsperada - premiosEsperados));

  console.log("\n5. Mes por mes");
  check("dos meses", alt.length === 2, `${alt.length}`);
  check("meses en base 0", Number(alt[0].mes) === 1 && Number(alt[1].mes) === 2,
    `${alt[0].mes}, ${alt[1].mes}`);
  check("los meses suman el total", cerca(alt.reduce((a, m) => a + Number(m.venta), 0), ventaTotal));

  console.log("\n6. Sólo entra lo liquidado");
  const fechaAbierta = "2092-04-10";
  await sb.rpc("fn_programar_dia", { p_fecha: fechaAbierta });
  const { data: sa } = await sb.from("sorteo").select("id, hora").eq("fecha", fechaAbierta);
  const idAbierto = sa.find((s) => s.hora === "20:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: idAbierto, p_limite_por_numero: 900000 });
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: idAbierto, p_vendedor_id: v1.id, p_lineas: [{ numero: GANADOR, monto: 5000 }],
  });

  const { data: conAbierto } = await admin.rpc("fn_simular", {
    p_desde: DESDE, p_hasta: HASTA, p_comision: COM_ALT, p_factor: FACTOR_ALT,
  });
  check(
    "un sorteo sin liquidar no entra en el escenario",
    cerca(conAbierto.reduce((a, m) => a + Number(m.venta), 0), ventaTotal),
    `${conAbierto.reduce((a, m) => a + Number(m.venta), 0)} vs ${ventaTotal}`,
  );

  FECHAS.push(fechaAbierta);
} finally {
  console.log("\n7. Limpieza");
  await limpiar();
  await sb.from("auditoria").delete().gt("id", 0);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
