/**
 * La venta de administración fuera de hora.
 *
 * Tres cosas que tienen que cumplirse a la vez:
 *
 *   · sin `p_forzar`, un sorteo cerrado rechaza la venta — el horario sigue
 *     siendo horario para todo el mundo;
 *   · con `p_forzar`, entra y queda MARCADA (`ticket.forzado`), porque una
 *     apuesta registrada después del cierre tiene que poder encontrarse;
 *   · sobre un sorteo ya liquidado, el ticket nuevo rehace la liquidación del
 *     vendedor. Si no, la fila de `allan.liquidacion` se quedaría con el total
 *     viejo y el sorteo dejaría de cuadrar en silencio.
 *
 *     node supabase/pruebas/venta-forzada.mjs
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

const FECHA = "2097-05-07";
const GANADOR = 42;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const limpiar = async () => {
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: lqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const lq of lqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", lq.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  // El abono de reconocimiento que crea la corrección: se borra por su nota,
  // porque su fecha_pago es HOY, no FECHA.
  await sb.from("abono_vendedor").delete().like("nota", "Reconocimiento por corrección%");
  await sb.from("corte_vendedor").delete().eq("desde", FECHA);
};

try {
  await limpiar();

  console.log("\n1. Montaje");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sorteoId = sorteos.find((s) => s.hora === "21:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: 50000 });

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");
  const v = vs[0];
  const p = Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor;

  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: GANADOR, monto: 100 }],
  });
  check("la venta normal entra con el sorteo abierto", true);

  // --- 2. Cerrado: sin forzar no entra ------------------------------------
  console.log("\n2. Sorteo cerrado");
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteoId });

  const { error: eNormal } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 7, monto: 50 }],
  });
  check("sin forzar, el sorteo cerrado rechaza", !!eNormal, "entró igual");

  const { data: forzado, error: eForzado } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 7, monto: 50 }],
    p_forzar: true,
  });
  check("con forzar, entra", !eForzado && !!forzado?.[0], eForzado?.message ?? "");

  const { data: filaForzada } = await sb
    .from("ticket")
    .select("forzado")
    .eq("id", forzado?.[0]?.ticket_id)
    .maybeSingle();
  check("el ticket queda marcado como forzado", filaForzada?.forzado === true);

  // --- 3. Liquidado: el ticket nuevo rehace las cuentas -------------------
  console.log("\n3. Sorteo liquidado");
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sorteoId, p_numero_ganador: GANADOR });

  const { data: antes } = await sb
    .from("liquidacion")
    .select("id, venta, comision, premios, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", v.id)
    .maybeSingle();

  check("la liquidación arrancó con 150 de venta", Number(antes.venta) === 150, `da ${antes.venta}`);

  const { error: eLiq } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: GANADOR, monto: 80 }],
    p_forzar: true,
  });
  check("se puede registrar sobre un sorteo liquidado", !eLiq, eLiq?.message ?? "");

  const { data: despues } = await sb
    .from("liquidacion")
    .select("venta, comision, premios, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", v.id)
    .maybeSingle();

  const ventaEsperada = 150 + 80;
  const premiosEsperados = (100 + 80) * Number(p.factor_pago);
  const comisionEsperada = ventaEsperada * Number(p.comision);

  check(
    "la venta liquidada se recalculó",
    Math.abs(Number(despues.venta) - ventaEsperada) < 0.01,
    `da ${despues.venta}, esperaba ${ventaEsperada}`,
  );
  check(
    "la línea nueva cuenta como ganadora",
    Math.abs(Number(despues.premios) - premiosEsperados) < 0.01,
    `da ${despues.premios}, esperaba ${premiosEsperados}`,
  );
  check(
    "la utilidad sigue siendo venta − comisión − premios",
    Math.abs(
      Number(despues.utilidad) - (ventaEsperada - comisionEsperada - premiosEsperados),
    ) < 0.01,
  );

  // --- 4a. Caso común: el vendedor DEBÍA el sorteo (viejo > 0) --------------
  //
  // El sorteo se paga en un corte y luego se corrige agregando venta. Como el
  // vendedor debía ese sorteo, lo ya pagado se le reconoce con un ABONO —lo
  // único que las pantallas de saldo restan del pendiente—, así que lo que
  // queda pendiente es exactamente la DIFERENCIA.
  console.log("\n4a. Sorteo que el vendedor debía: corregir deja la diferencia");
  const sorteo11 = sorteos.find((s) => s.hora === "11:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteo11, p_limite_por_numero: 50000 });
  // Sólo números perdedores respecto del ganador que se liquidará (5 ≠ GANADOR):
  // así la utilidad del sorteo es positiva (el vendedor debe).
  await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteo11,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 5, monto: 200 }],
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteo11 });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: sorteo11, p_numero_ganador: GANADOR });

  const { data: lq11 } = await sb
    .from("liquidacion")
    .select("id, utilidad")
    .eq("sorteo_id", sorteo11)
    .eq("vendedor_id", v.id)
    .maybeSingle();
  const viejo11 = Number(lq11.utilidad);
  check("la utilidad de ese sorteo es positiva (el vendedor debe)", viejo11 > 0, `da ${viejo11}`);

  await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: [lq11.id],
    p_desde: FECHA,
    p_hasta: FECHA,
  });

  const { data: deuda11Antes } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: v.id });
  const pend11Antes = Number(deuda11Antes?.[0]?.r_pendiente ?? 0);

  // Se corrige: se agrega otra línea perdedora. Sube la venta, no los premios.
  const { error: e11 } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteo11,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 6, monto: 100 }],
    p_forzar: true,
  });
  check("un sorteo ya pagado ACEPTA la corrección del administrador", !e11, e11?.message ?? "");

  const { data: lq11b } = await sb
    .from("liquidacion")
    .select("id, utilidad")
    .eq("sorteo_id", sorteo11)
    .eq("vendedor_id", v.id)
    .maybeSingle();
  const nuevo11 = Number(lq11b.utilidad);

  const { data: det11 } = await sb
    .from("corte_detalle")
    .select("liquidacion_id")
    .eq("liquidacion_id", lq11b.id);
  check("el sorteo corregido se desligó del corte", (det11 ?? []).length === 0);

  const { data: abono } = await sb
    .from("abono_vendedor")
    .select("monto, corte_id, nota")
    .eq("vendedor_id", v.id)
    .is("corte_id", null)
    .order("registrado_en", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(
    "se reconoció lo pagado con un abono vivo por 'viejo'",
    abono && Math.abs(Number(abono.monto) - viejo11) < 0.01,
    `abono ${abono?.monto}, viejo ${viejo11}`,
  );

  const { data: deuda11Despues } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: v.id });
  const pend11Despues = Number(deuda11Despues?.[0]?.r_pendiente ?? 0);
  check(
    "el pendiente creció exactamente en la diferencia (nuevo − viejo)",
    Math.abs((pend11Despues - pend11Antes) - (nuevo11 - viejo11)) < 0.01,
    `Δpendiente ${pend11Despues - pend11Antes}, diferencia ${nuevo11 - viejo11}`,
  );

  // --- 4b. Caso raro: el sorteo era a favor del vendedor (viejo < 0) --------
  //
  // Aquí la casa le había pagado a él. No hay abono negativo que lo reconozca,
  // así que se desliga igual, se traza en el corte y el cierre de esa parte se
  // hace a mano. Es el sorteo con el número ganador de arriba.
  console.log("\n4b. Sorteo a favor del vendedor: se desliga y se traza");
  const { data: lqGan } = await sb
    .from("liquidacion")
    .select("id, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", v.id)
    .maybeSingle();
  const viejoGan = Number(lqGan.utilidad);
  check("la utilidad de ese sorteo es negativa (la casa le pagó)", viejoGan < 0, `da ${viejoGan}`);

  await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: [lqGan.id],
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  const { data: corteGanAntes } = await sb
    .from("corte_vendedor")
    .select("id, saldo, entrega")
    .eq("id", (await sb.from("corte_detalle").select("corte_id").eq("liquidacion_id", lqGan.id).maybeSingle()).data?.corte_id)
    .maybeSingle();

  const { error: eGan } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 8, monto: 10 }],
    p_forzar: true,
  });
  check("acepta la corrección aunque el sorteo era a favor del vendedor", !eGan, eGan?.message ?? "");

  const { data: detGan } = await sb
    .from("corte_detalle")
    .select("liquidacion_id")
    .eq("liquidacion_id", lqGan.id);
  check("el sorteo a favor también se desligó del corte", (detGan ?? []).length === 0);

  const { data: corteGanDespues } = await sb
    .from("corte_vendedor")
    .select("saldo, entrega, motivo_ajuste")
    .eq("id", corteGanAntes.id)
    .maybeSingle();
  check(
    "el corte bajó su saldo en lo que había pagado por el sorteo",
    Math.abs(Number(corteGanDespues.saldo) - (Number(corteGanAntes.saldo) - viejoGan)) < 0.01,
    `saldo ${corteGanDespues.saldo}, esperaba ${Number(corteGanAntes.saldo) - viejoGan}`,
  );
  check(
    "la entrega del corte no se falseó",
    Math.abs(Number(corteGanDespues.entrega) - Number(corteGanAntes.entrega ?? corteGanAntes.saldo)) < 0.01,
    `entrega ${corteGanDespues.entrega}`,
  );
  check(
    "queda trazado para reconocer a mano",
    /a mano|reconocer/i.test(corteGanDespues.motivo_ajuste ?? ""),
    corteGanDespues.motivo_ajuste ?? "sin motivo",
  );
} finally {
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
