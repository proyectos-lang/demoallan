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
  db: { schema: "allan" },
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
  await sb.from("corte_vendedor").delete().eq("desde", FECHA);
};

try {
  await limpiar();

  console.log("\n1. Montaje");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);
  const sorteoId = sorteos.find((s) => s.hora === "20:00").id;
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

  // --- 4. Ya pagado: no admite más venta ----------------------------------
  console.log("\n4. Sorteo ya pagado en un corte");
  const { data: lqActual } = await sb
    .from("liquidacion")
    .select("id")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", v.id)
    .maybeSingle();

  await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: v.id,
    p_liquidacion_ids: [lqActual.id],
    p_desde: FECHA,
    p_hasta: FECHA,
  });

  const { error: ePagado } = await sb.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_lineas: [{ numero: 3, monto: 10 }],
    p_forzar: true,
  });

  check(
    "un sorteo ya pagado rechaza la venta forzada",
    !!ePagado && /ya se le pag/i.test(ePagado.message),
    ePagado?.message ?? "entró igual",
  );
} finally {
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
