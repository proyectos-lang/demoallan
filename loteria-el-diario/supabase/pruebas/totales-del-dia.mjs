/**
 * Ver y corregir la venta capturada por totales, y el alias en todas partes.
 *
 * QUÉ HAY QUE DEMOSTRAR
 * ---------------------
 *   · Que `fn_ventas_totales_dia` trae los TRES sorteos del día en una sola
 *     consulta, con el rótulo del vendedor ya resuelto —el alias si lo tiene—
 *     y el saldo calculado en la base, no en la pantalla.
 *
 *   · Que corregir cambia la cifra EN SU SITIO: mismo identificador, mismo
 *     vendedor, mismo sorteo. Si cambiara alguno de esos tres no sería una
 *     corrección sino un traslado de dinero.
 *
 *   · Que la COMISIÓN CONGELADA no se mueve al corregir. Es la diferencia
 *     deliberada con `fn_editar_venta`: aquí el dato vive en la fila y no hay
 *     razón para perderlo.
 *
 *   · Que sobre un sorteo liquidado se rehace la liquidación del vendedor.
 *
 *   · Que una captura anulada NO se corrige, y que lo que no es un número se
 *     rechaza.
 *
 *   · Que `fn_desglose_dia` y `fn_resumen_semanal` —las dos que se quedaron
 *     fuera de la 0068— ya dicen el alias.
 *
 *     node supabase/pruebas/totales-del-dia.mjs
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

const FECHA = "2031-11-12";
const NOMBRE = "ZZZ Totales del dia";
const ALIAS = "ZZZ TOLDO ROJO";

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
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    const { data: liqs } = await sb.from("liquidacion").select("id").eq("sorteo_id", s.id);
    for (const l of liqs ?? []) await sb.from("corte_detalle").delete().eq("liquidacion_id", l.id);
    const { data: vts } = await sb.from("venta_total").select("id").eq("sorteo_id", s.id);
    for (const vt of vts ?? []) await sb.from("auditoria").delete().eq("entidad_id", vt.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
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
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
    for (const c of cs ?? []) {
      await sb.from("corte_detalle").delete().eq("corte_id", c.id);
      await sb.from("auditoria").delete().eq("entidad_id", c.id);
    }
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

async function main() {
  await limpiar();

  // Uno CON alias y otro SIN, para ver las dos ramas de fn_rotulo.
  const crear = async (sufijo, alias) => {
    const { data, error } = await sb.rpc("fn_crear_vendedor", {
      p_nombre: `${NOMBRE} ${sufijo}`,
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
      p_alias: alias,
    });
    if (error) throw new Error(`${sufijo}: ${error.message}`);
    return data[0].vendedor_id;
  };

  const conAlias = await crear("CON", ALIAS);
  const sinAlias = await crear("SIN", null);

  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora")
    .eq("fecha", FECHA)
    .order("hora");

  for (const s of sorteos) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }

  const capturar = async (sorteoId, vendedorId, venta, premios) => {
    const { data, error } = await sb.rpc("fn_registrar_venta_total", {
      p_sorteo_id: sorteoId,
      p_vendedor_id: vendedorId,
      p_venta: venta,
      p_premios: premios,
      p_nota: null,
      p_usuario_id: admin.id,
    });
    if (error) throw new Error(`capturar: ${error.message}`);
    return data[0].r_id;
  };

  // Una captura en cada sorteo, para que el día tenga los tres.
  const c11 = await capturar(sorteos[0].id, conAlias, 1000, 0);
  await capturar(sorteos[1].id, sinAlias, 500, 100);
  await capturar(sorteos[2].id, conAlias, 800, 0);

  // --- Ver el día entero -----------------------------------------------------
  const { data: dia, error: eDia } = await sb.rpc("fn_ventas_totales_dia", {
    p_fecha: FECHA,
    p_vendedor_id: null,
  });
  check("la consulta del día no da error", !eDia, eDia?.message ?? "");
  check("LOS TRES SORTEOS EN UNA SOLA CONSULTA", (dia ?? []).length === 3,
        `${(dia ?? []).length} filas`);

  const fila11 = (dia ?? []).find((f) => f.r_id === c11);
  check("EL RÓTULO ES EL ALIAS cuando lo tiene", fila11?.r_vendedor === ALIAS,
        String(fila11?.r_vendedor));

  const filaSin = (dia ?? []).find((f) => f.r_vendedor_id === sinAlias);
  check("y el nombre cuando no lo tiene",
        filaSin?.r_vendedor === `${NOMBRE} SIN`, String(filaSin?.r_vendedor));

  // 1000 al 10 % = 100 de comisión; saldo = 1000 − 100 − 0 = 900.
  check("la comisión la calcula la base", Number(fila11?.r_comision) === 100,
        String(fila11?.r_comision));
  check("y el saldo también", Number(fila11?.r_saldo) === 900, String(fila11?.r_saldo));

  // Filtrar por vendedor.
  const { data: soloUno } = await sb.rpc("fn_ventas_totales_dia", {
    p_fecha: FECHA,
    p_vendedor_id: sinAlias,
  });
  check("se puede filtrar por vendedor", (soloUno ?? []).length === 1,
        `${(soloUno ?? []).length} filas`);

  // --- Corregir --------------------------------------------------------------
  const { data: r1, error: e1 } = await sb.rpc("fn_editar_venta_total", {
    p_id: c11,
    p_venta: 4500,
    p_premios: 0,
    p_nota: "eran 4500, no 1000",
    p_usuario_id: admin.id,
  });
  check("la corrección no da error", !e1, e1?.message ?? "");
  check("devuelve la comisión rehecha", Number(r1?.[0]?.r_comision) === 450,
        String(r1?.[0]?.r_comision));
  check("y el saldo nuevo", Number(r1?.[0]?.r_saldo) === 4050, String(r1?.[0]?.r_saldo));

  const { data: tras } = await sb
    .from("venta_total")
    .select("id, sorteo_id, vendedor_id, venta, comision_congelada, nota")
    .eq("id", c11)
    .single();
  check("SE CORRIGE EN SU SITIO: mismo identificador", tras.id === c11);
  check("mismo vendedor", tras.vendedor_id === conAlias);
  check("mismo sorteo", tras.sorteo_id === sorteos[0].id);
  check("la venta es la corregida", Number(tras.venta) === 4500, String(tras.venta));
  check("LA COMISIÓN CONGELADA NO SE MUEVE", Number(tras.comision_congelada) === 0.1,
        String(tras.comision_congelada));
  check("la nota queda", tras.nota === "eran 4500, no 1000", String(tras.nota));

  const { data: aud } = await sb
    .from("auditoria")
    .select("campo, valor_anterior, valor_nuevo")
    .eq("entidad_id", c11)
    .eq("accion", "editar");
  const deVenta = (aud ?? []).find((a) => a.campo === "venta");
  check("la cifra anterior queda en auditoría",
        Number(deVenta?.valor_anterior) === 1000, String(deVenta?.valor_anterior));

  // --- Rechazos --------------------------------------------------------------
  const { error: eNeg } = await sb.rpc("fn_editar_venta_total", {
    p_id: c11,
    p_venta: -1,
    p_premios: 0,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("una venta negativa se rechaza", !!eNeg, eNeg ? "" : "no dio error");

  await sb.rpc("fn_anular_venta_total", { p_id: c11, p_usuario_id: admin.id });
  const { error: eAnul } = await sb.rpc("fn_editar_venta_total", {
    p_id: c11,
    p_venta: 999,
    p_premios: 0,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("una captura ANULADA no se corrige", !!eAnul, eAnul ? "" : "no dio error");

  const { data: diaConAnulada } = await sb.rpc("fn_ventas_totales_dia", {
    p_fecha: FECHA,
    p_vendedor_id: null,
  });
  const anulada = (diaConAnulada ?? []).find((f) => f.r_id === c11);
  check("la anulada sigue viéndose, marcada", anulada?.r_anulado === true,
        String(anulada?.r_anulado));

  // --- Sobre un sorteo liquidado ---------------------------------------------
  const s15 = sorteos[1];
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s15.id });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s15.id, p_numero_ganador: 55 });

  const liqAntes = await sb
    .from("liquidacion")
    .select("venta")
    .eq("sorteo_id", s15.id)
    .eq("vendedor_id", sinAlias)
    .single();
  check("la liquidación recoge la captura", Number(liqAntes.data.venta) === 500,
        String(liqAntes.data.venta));

  const { data: capturaS15 } = await sb
    .from("venta_total")
    .select("id")
    .eq("sorteo_id", s15.id)
    .eq("vendedor_id", sinAlias)
    .single();

  const { error: eLiq } = await sb.rpc("fn_editar_venta_total", {
    p_id: capturaS15.id,
    p_venta: 2000,
    p_premios: 100,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  check("se corrige sobre un sorteo liquidado", !eLiq, eLiq?.message ?? "");

  const liqDespues = await sb
    .from("liquidacion")
    .select("venta")
    .eq("sorteo_id", s15.id)
    .eq("vendedor_id", sinAlias)
    .single();
  check("LA LIQUIDACIÓN SE REHACE", Number(liqDespues.data.venta) === 2000,
        String(liqDespues.data.venta));

  // --- El alias en las dos funciones que faltaban -----------------------------
  const { data: desglose, error: eDes } = await sb.rpc("fn_desglose_dia", {
    p_fecha: FECHA,
  });
  check("fn_desglose_dia responde", !eDes, eDes?.message ?? "");
  const enDesglose = (desglose ?? []).find((d) => d.vendedor_id === conAlias);
  check("FN_DESGLOSE_DIA DICE EL ALIAS", enDesglose?.nombre === ALIAS,
        String(enDesglose?.nombre));

  const { data: semanal, error: eSem } = await sb.rpc("fn_resumen_semanal", {
    p_desde: FECHA,
    p_hasta: FECHA,
  });
  check("fn_resumen_semanal responde", !eSem, eSem?.message ?? "");
  const enSemanal = (semanal ?? []).find((f) => f.r_vendedor_id === conAlias);
  check("FN_RESUMEN_SEMANAL DICE EL ALIAS", enSemanal?.r_nombre === ALIAS,
        String(enSemanal?.r_nombre));
  const sinEnSemanal = (semanal ?? []).find((f) => f.r_vendedor_id === sinAlias);
  check("y el nombre a quien no tiene alias",
        sinEnSemanal?.r_nombre === `${NOMBRE} SIN`, String(sinEnSemanal?.r_nombre));

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
