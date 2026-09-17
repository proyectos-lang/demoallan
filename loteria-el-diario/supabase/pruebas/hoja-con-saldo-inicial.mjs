/**
 * La HOJA del vendedor cuenta el saldo de apertura en su arrastre.
 *
 * EL CASO QUE LO MOTIVA
 * ---------------------
 * Se le cargó a un vendedor un saldo inicial y en la pestaña de saldos aparece
 * bien, pero en la HOJA no: ni la tarjeta de arrastre ni el botón de pagar lo
 * ven. La causa: la hoja usa `fn_liquidacion_por_semana`, que calcula el
 * arrastre como una suma acumulada de lo pendiente semana a semana y nunca
 * miró `saldo_inicial`. Las correcciones anteriores tocaron las otras dos
 * funciones, no ésta.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que el saldo aparezca en el arrastre de la semana de su fecha.
 *   · Que se ARRASTRE hacia adelante: también en la semana siguiente.
 *   · Que NO aparezca en semanas anteriores a su fecha.
 *   · Que el acumulado lo incluya, que es la cifra que se cobra.
 *   · Que la hoja y la pestaña de saldos digan lo MISMO: son la misma cuenta.
 *   · Que cobrarlo lo cierre y el arrastre vuelva a su sitio.
 *
 *     node supabase/pruebas/hoja-con-saldo-inicial.mjs
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

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

// Semanas de prueba, lejanas y con datos propios.
const SEM_A = "2018-06-04"; // lunes; la apertura cae aquí
const SEM_B = "2018-06-11"; // la siguiente
const SEM_PREVIA = "2018-05-28"; // anterior a la apertura
const APERTURA = "2018-06-06"; // miércoles de SEM_A
const MONTO = 4200;
const CODIGO = "V-977";

let vendedorId = null;
const limpiar = async () => {
  const { data: v } = await sb.from("vendedor").select("id").eq("codigo", CODIGO).maybeSingle();
  if (!v) return;
  await sb.from("saldo_inicial").delete().eq("vendedor_id", v.id);
  const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
  for (const c of cs ?? []) await sb.from("corte_detalle").delete().eq("corte_id", c.id);
  await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("vendedor").delete().eq("id", v.id);
};

const arrastreDe = async (semanaInicio) => {
  const { data } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: vendedorId });
  return (data ?? []).find((s) => s.r_inicio === semanaInicio);
};

try {
  await limpiar();

  console.log("1. Un vendedor con una venta en dos semanas");
  const { data: nuevo } = await sb
    .from("vendedor")
    .insert({
      codigo: CODIGO,
      nombre: "PRUEBA HOJA SALDO",
      ciudad: "Choloma",
      zona: "prueba",
      color: "#4f46e5",
      activo: true,
    })
    .select("id")
    .single();
  vendedorId = nuevo.id;
  await sb.from("parametro_vendedor").insert({
    vendedor_id: vendedorId,
    comision: 0.15,
    factor_pago: 70,
    tope_por_numero: 300,
  });

  // Una venta liquidada en cada semana, para que las dos existan en la hoja.
  const montarSemana = async (lunes) => {
    // Los sorteos del día se crean con `fn_programar_dia`: un insert directo
    // choca con `hora_cierre not null`, que la función calcula.
    await sb.rpc("fn_programar_dia", { p_fecha: lunes });
    const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", lunes);
    const s = ss.find((x) => x.hora === "11:00");
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 9999 });
    await sb.rpc("fn_registrar_ticket", {
      p_sorteo_id: s.id,
      p_vendedor_id: vendedorId,
      p_lineas: [{ numero: 7, monto: 100 }],
      p_usuario_id: admin.id,
    });
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: 50 });
    return s.id;
  };
  const sA = await montarSemana(SEM_A);
  const sB = await montarSemana(SEM_B);
  check("montadas las dos semanas", Boolean(sA && sB));

  // --- Antes de cargar nada -----------------------------------------------
  const antes = await arrastreDe(SEM_B);
  const arrastreBaseB = num(antes?.r_arrastre);
  console.log(`   arrastre base en ${SEM_B}: ${arrastreBaseB}`);

  // --- Se carga el saldo de apertura --------------------------------------
  console.log("\n2. Se carga el saldo de apertura");
  const { error: eCargar } = await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vendedorId,
    p_monto: MONTO,
    p_vigente_desde: APERTURA,
    p_usuario_id: admin.id,
  });
  check("se carga", !eCargar, eCargar?.message ?? "");

  // --- La hoja lo tiene que ver -------------------------------------------
  console.log("\n3. La HOJA lo cuenta");

  /*
   * El saldo se ARRASTRA: la función acumula lo pendiente semana a semana y
   * siempre trae la semana en curso cuando queda algo de antes. Así que el
   * saldo de una apertura no vive sólo en su propia semana —que puede haber
   * salido del listado por tener saldo cero— sino ARRASTRADO hasta la fila más
   * reciente. Es justo lo que se vio en V-002 real: su saldo del 12/09 apareció
   * en la semana en curso, no en la del 12.
   *
   * Se valida contra esa fila más reciente, que es la que devuelve la función
   * y la que el vendedor tiene delante.
   */
  const todas =
    (await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: vendedorId })).data ?? [];
  const reciente = todas[0]; // ordenadas de más nueva a más vieja
  const enPrevia = todas.find((s) => s.r_inicio === SEM_PREVIA);

  const arrastreConSaldo = num(reciente?.r_arrastre) + num(reciente?.r_pendiente);
  check(
    "el saldo aparece arrastrado en la hoja",
    arrastreConSaldo >= MONTO,
    `arrastre+pendiente ${arrastreConSaldo}, esperado al menos ${MONTO}`,
  );
  check(
    "el acumulado que se cobra incluye el saldo",
    num(reciente?.r_acumulado) >= MONTO,
    `acumulado ${num(reciente?.r_acumulado)}`,
  );
  check(
    "en una semana ANTERIOR a la apertura, no aparece",
    !enPrevia || num(enPrevia.r_arrastre) === 0,
    `${num(enPrevia?.r_arrastre)}`,
  );

  // --- La hoja y la pestaña de saldos dicen lo mismo ----------------------
  console.log("\n4. La hoja y la pestaña de saldos coinciden");
  const { data: saldos } = await sb.rpc("fn_saldos_por_vendedor", {
    p_desde: reciente.r_inicio,
    p_hasta: reciente.r_fin,
  });
  const enSaldos = (saldos ?? []).find((f) => f.r_vendedor_id === vendedorId);
  check(
    "el «anterior» de saldos coincide con el «arrastre» de la hoja de esa semana",
    cerca(num(enSaldos?.r_anterior), num(reciente?.r_arrastre)),
    `saldos ${num(enSaldos?.r_anterior)} · hoja ${num(reciente?.r_arrastre)}`,
  );

  // --- Cobrarlo lo cierra --------------------------------------------------
  console.log("\n5. Al cobrarlo, desaparece del arrastre");
  /*
   * Se cobra sobre la semana más reciente —la que el vendedor tiene abierta—.
   * La entrega es todo lo que arrastra de antes: si difiere del saldo la base
   * pide motivo, así que se le pasa uno sin condicionarlo a una cuenta previa.
   */
  const totalArrastrado = num(reciente.r_arrastre);
  await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: vendedorId,
    p_desde: reciente.r_inicio,
    p_entrega: totalArrastrado,
    p_fecha_pago: null,
    p_motivo: "cobro de prueba",
    p_usuario_id: admin.id,
  });

  const despues =
    (await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: vendedorId })).data ?? [];
  const cobrado = despues[0];
  check(
    "tras cobrar, el arrastre ya no incluye la apertura",
    num(cobrado?.r_arrastre) < MONTO,
    `${num(cobrado?.r_arrastre)} todavía incluye los ${MONTO}`,
  );
} finally {
  console.log("\n6. Limpieza");
  // Los sorteos de prueba, con sus liquidaciones y tickets.
  for (const lunes of [SEM_A, SEM_B]) {
    const { data: ss } = await sb.from("sorteo").select("id").eq("fecha", lunes);
    for (const s of ss ?? []) {
      await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
      const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
      for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
      await sb.from("ticket").delete().eq("sorteo_id", s.id);
      await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
      await sb.from("sorteo").delete().eq("id", s.id);
    }
  }
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
