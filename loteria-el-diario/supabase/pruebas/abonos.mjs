/**
 * Abonos a cuenta: pagar parte y seguir debiendo el resto.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que EL DINERO NO SE CUENTE DOS VECES. Es lo único que puede romperse en
 *     silencio: si al cerrar el corte los abonos siguieran vivos, el vendedor
 *     aparecería con saldo a favor de la nada, y nadie lo notaría hasta que
 *     alguien fuera a cobrarle lo que ya pagó.
 *
 *   · Que un abono NO CIERRE SORTEOS. Es la diferencia con saldar: el resto
 *     tiene que seguir apareciendo hasta que lo entregue.
 *
 *   · Que no se acepte más de lo que debe: un abono de más dejaría un
 *     pendiente negativo que ninguna pantalla sabe leer.
 *
 *   · Que quitar un abono mal tecleado devuelva la deuda a donde estaba, y que
 *     uno ya cerrado en un corte no se pueda quitar por separado.
 *
 *   · Que la cobranza liste sólo a quien debe, ya descontado lo abonado.
 *
 *     node supabase/pruebas/abonos.mjs
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

const FECHA = "2031-08-14";
const NOMBRE = "ZZZ Abonos";

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

async function limpiar() {
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
    for (const c of cs ?? []) {
      await sb.from("corte_detalle").delete().eq("corte_id", c.id);
      await sb.from("auditoria").delete().eq("entidad_id", c.id);
    }
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
  }

  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: liqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const l of liqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", l.id);
    const { data: tks } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of tks ?? []) {
      await sb.from("auditoria").delete().eq("entidad_id", t.id);
      await sb.from("linea").delete().eq("ticket_id", t.id);
    }
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("auditoria").delete().eq("entidad_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }

  for (const v of vs ?? []) {
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

const deudaDe = async (id) => {
  const { data, error } = await sb.rpc("fn_deuda_vendedor", { p_vendedor_id: id });
  if (error) throw new Error(`deuda: ${error.message}`);
  const f = data[0];
  return {
    sorteos: f.r_sorteos,
    deuda: Number(f.r_deuda),
    abonado: Number(f.r_abonado),
    pendiente: Number(f.r_pendiente),
  };
};

async function main() {
  await limpiar();

  const { data: alta, error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: `${NOMBRE} UNO`,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.1,
    p_factor_pago: 70,
    p_tope_por_numero: 500000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedor = alta[0].vendedor_id;

  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  // Tres sorteos vendidos y liquidados: 1000 de venta cada uno, 10 % de
  // comisión, sin premios. Debe 900 por sorteo = 2700.
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora")
    .eq("fecha", FECHA)
    .order("hora");

  for (const s of sorteos) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
    const { error } = await sb.rpc("fn_registrar_tanda", {
      p_sorteo_id: s.id,
      p_vendedor_id: vendedor,
      p_tickets: [[{ numero: 7, monto: 1000 }]],
      p_forzar: true,
    });
    if (error) throw new Error(`vender: ${error.message}`);
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: 55 });
  }

  // --- La deuda de partida ----------------------------------------------------
  console.log("--- La deuda ---");
  let d = await deudaDe(vendedor);
  check("tres sorteos sin cerrar", d.sorteos === 3, `${d.sorteos}`);
  check("debe 2700", d.deuda === 2700, `${d.deuda}`);
  check("sin nada abonado todavía", d.abonado === 0, `${d.abonado}`);

  // --- Un abono a cuenta ------------------------------------------------------
  console.log("\n--- Abonar 400 de los 2700 ---");
  const { data: a1, error: e1 } = await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 400,
    p_fecha_pago: null,
    p_nota: "trajo en la mañana",
    p_usuario_id: admin.id,
  });
  check("el abono no da error", !e1, e1?.message ?? "");
  check("devuelve lo que le queda", Number(a1?.[0]?.r_pendiente) === 2300,
        String(a1?.[0]?.r_pendiente));

  d = await deudaDe(vendedor);
  check("EL PENDIENTE BAJA a 2300", d.pendiente === 2300, `${d.pendiente}`);
  check("pero LA DEUDA SIGUE ENTERA: no se cerró ningún sorteo",
        d.deuda === 2700 && d.sorteos === 3, `${d.deuda} en ${d.sorteos} sorteos`);
  check("y se ve lo entregado", d.abonado === 400, `${d.abonado}`);

  // Ningún sorteo entró en un corte: eso es lo que distingue abonar de saldar.
  const { data: enCortes } = await sb
    .from("corte_detalle")
    .select("liquidacion_id", { count: "exact" });
  const { data: misLiqs } = await sb
    .from("liquidacion")
    .select("id")
    .eq("vendedor_id", vendedor);
  const cerrados = (enCortes ?? []).filter((c) =>
    (misLiqs ?? []).some((l) => l.id === c.liquidacion_id),
  );
  check("NINGÚN SORTEO SE CERRÓ al abonar", cerrados.length === 0, `${cerrados.length}`);

  // --- Un segundo abono -------------------------------------------------------
  console.log("\n--- Un segundo abono de 300 ---");
  await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 300,
    p_fecha_pago: null,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  d = await deudaDe(vendedor);
  check("los abonos se suman", d.abonado === 700, `${d.abonado}`);
  check("y el pendiente baja a 2000", d.pendiente === 2000, `${d.pendiente}`);

  const { data: lista } = await sb.rpc("fn_abonos_vendedor", {
    p_vendedor_id: vendedor,
    p_incluir_cerrados: false,
  });
  check("los dos abonos se pueden ver", (lista ?? []).length === 2,
        `${(lista ?? []).length}`);

  // --- Rechazos ---------------------------------------------------------------
  console.log("\n--- Lo que no se acepta ---");
  const { error: eCero } = await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 0,
    p_fecha_pago: null,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("un abono de cero se rechaza", !!eCero, eCero ? "" : "no dio error");

  const { error: ePasa } = await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 5000,
    p_fecha_pago: null,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("NO se acepta más de lo que debe", !!ePasa, ePasa ? "" : "no dio error");

  const { error: eFuturo } = await sb.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedor,
    p_monto: 100,
    p_fecha_pago: "2099-01-01",
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("una fecha de pago futura se rechaza", !!eFuturo, eFuturo ? "" : "no dio error");

  d = await deudaDe(vendedor);
  check("tras los rechazos la cuenta no se movió", d.abonado === 700, `${d.abonado}`);

  // --- Quitar un abono --------------------------------------------------------
  console.log("\n--- Quitar un abono mal tecleado ---");
  const { error: eQuitar } = await sb.rpc("fn_anular_abono", {
    p_abono_id: lista[0].r_abono_id,
    p_motivo: "se tecleó de más",
    p_usuario_id: admin.id,
  });
  check("se puede quitar", !eQuitar, eQuitar?.message ?? "");

  d = await deudaDe(vendedor);
  check("LA DEUDA VUELVE a lo que era", d.abonado === 400 && d.pendiente === 2300,
        `abonado ${d.abonado}, pendiente ${d.pendiente}`);

  // --- La cobranza ------------------------------------------------------------
  console.log("\n--- La lista de cobranza ---");
  const { data: cobranza, error: eCob } = await sb.rpc("fn_cobranza", {});
  check("la cobranza responde", !eCob, eCob?.message ?? "");
  const mio = (cobranza ?? []).find((c) => c.r_vendedor_id === vendedor);
  check("el vendedor aparece", !!mio, "no aparece");
  if (mio) {
    check("con lo que debe", Number(mio.r_deuda) === 2700, String(mio.r_deuda));
    check("descontado lo abonado", Number(mio.r_pendiente) === 2300, String(mio.r_pendiente));
  }

  // --- EL CIERRE: que el dinero no se cuente dos veces ------------------------
  console.log("\n--- Cerrar el corte con abonos vivos ---");

  // Termina de pagar y se cierra el corte de los tres sorteos.
  const { data: liqs } = await sb
    .from("liquidacion")
    .select("id")
    .eq("vendedor_id", vendedor);

  const { data: corte, error: eCorte } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedor,
    p_liquidacion_ids: (liqs ?? []).map((l) => l.id),
    p_desde: FECHA,
    p_hasta: FECHA,
    p_nota: "cierre con abonos",
    p_usuario_id: admin.id,
  });
  check("el corte no da error", !eCorte, eCorte?.message ?? "");
  check("el corte cobra el saldo entero", Number(corte?.[0]?.r_saldo) === 2700,
        String(corte?.[0]?.r_saldo));
  check("DICE CUÁNTO YA HABÍA ENTREGADO", Number(corte?.[0]?.r_abonado) === 400,
        String(corte?.[0]?.r_abonado));
  check("y cuánto recibe al cerrar", Number(corte?.[0]?.r_resta) === 2300,
        String(corte?.[0]?.r_resta));

  d = await deudaDe(vendedor);
  check("no queda deuda", d.deuda === 0 && d.sorteos === 0,
        `${d.deuda} en ${d.sorteos} sorteos`);
  check(
    "EL ABONO YA NO CUENTA APARTE: no hay saldo a favor de la nada",
    d.abonado === 0 && d.pendiente === 0,
    `abonado ${d.abonado}, pendiente ${d.pendiente}`,
  );

  const { data: trasCorte } = await sb.rpc("fn_abonos_vendedor", {
    p_vendedor_id: vendedor,
    p_incluir_cerrados: true,
  });
  check("el apunte se conserva, marcado como cerrado",
        (trasCorte ?? []).length === 1 && trasCorte[0].r_cerrado === true,
        JSON.stringify(trasCorte));

  const { error: eQuitarCerrado } = await sb.rpc("fn_anular_abono", {
    p_abono_id: trasCorte[0].r_abono_id,
    p_motivo: "no debería poder",
    p_usuario_id: admin.id,
  });
  check("un abono ya cerrado NO se puede quitar por separado",
        !!eQuitarCerrado, eQuitarCerrado ? "" : "no dio error");

  const { data: cobranzaFinal } = await sb.rpc("fn_cobranza", {});
  check("y desaparece de la cobranza",
        !(cobranzaFinal ?? []).some((c) => c.r_vendedor_id === vendedor));

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
