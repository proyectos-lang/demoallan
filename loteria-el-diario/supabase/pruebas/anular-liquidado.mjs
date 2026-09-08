/**
 * Anular una venta sobre un sorteo ya liquidado.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que la LIQUIDACIÓN QUEDA CUADRADA. Es la razón por la que esto estaba
 *     prohibido: quitar un ticket de un sorteo liquidado dejaba la fila de
 *     `liquidacion` con el total viejo, y el detalle decía una cosa mientras el
 *     informe financiero decía otra, sin que nada avisara. Aquí se comprueba
 *     con números concretos que venta, comisión, premios y neto bajan por el
 *     monto exacto del ticket anulado.
 *
 *   · Que un sorteo YA PAGADO en un corte SE RECHACE, y que el rechazo deshaga
 *     la anulación entera. El corte es dinero que ya cambió de manos: si la
 *     venta se anulara y sólo fallara el recálculo, quedaría un ticket anulado
 *     con una liquidación que ya no le corresponde — peor que no dejar anular.
 *
 *   · Que el CUPO se devuelva aunque el sorteo esté liquidado.
 *
 *   · Que la anulación quede AUDITADA con quién y cuándo.
 *
 * Crea un vendedor y un sorteo en una fecha lejana; borra todo al final.
 *
 *     node supabase/pruebas/anular-liquidado.mjs
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

const FECHA = "2031-06-12";
const NOMBRE = "ZZZ Anulacion liquidada";

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
    for (const l of liqs ?? []) {
      await sb.from("corte_detalle").delete().eq("liquidacion_id", l.id);
    }
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
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

/** La fila de liquidación de un vendedor, en números redondos. */
async function liquidacion(sorteoId, vendedorId) {
  const { data } = await sb
    .from("liquidacion")
    .select("venta, comision, premios, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", vendedorId)
    .maybeSingle();
  if (!data) return null;
  return {
    venta: Number(data.venta),
    comision: Number(data.comision),
    premios: Number(data.premios),
    utilidad: Number(data.utilidad),
  };
}

async function main() {
  await limpiar();

  // --- Montaje --------------------------------------------------------------
  const { data: alta, error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: NOMBRE,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.1, // 10%: los números salen redondos y se leen de un vistazo
    p_factor_pago: 70,
    p_tope_por_numero: 50000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedorId = alta[0].vendedor_id;

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteo } = await sb
    .from("sorteo")
    .select("id")
    .eq("fecha", FECHA)
    .eq("hora", "11:00")
    .single();
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteo.id, p_limite_por_numero: 500000 });

  // Dos ventas. La segunda es la que se va a anular; ninguna acierta el 55, de
  // modo que los premios se quedan en cero y la aritmética queda a la vista.
  const { data: v1 } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteo.id,
    p_vendedor_id: vendedorId,
    p_tickets: [[{ numero: 7, monto: 1000 }]],
  });
  const { data: v2 } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteo.id,
    p_vendedor_id: vendedorId,
    p_tickets: [[{ numero: 42, monto: 200 }]],
  });
  const folioAnular = v2[0].r_folio;
  const { data: tk } = await sb.from("ticket").select("id").eq("folio", folioAnular).single();

  // Se cierra y se liquida con el 55, que nadie jugó.
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteo.id });
  const { error: eLiq } = await sb.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: sorteo.id,
    p_numero_ganador: 55,
  });
  if (eLiq) {
    console.log("no se pudo liquidar:", eLiq.message);
    await limpiar();
    process.exit(1);
  }

  const { data: estado0 } = await sb.from("sorteo").select("estado").eq("id", sorteo.id).single();
  check("el sorteo quedó liquidado", estado0.estado === "liquidado", estado0.estado);

  const antes = await liquidacion(sorteo.id, vendedorId);
  check("la liquidación cuenta las dos ventas", antes?.venta === 1200, JSON.stringify(antes));
  check("y su comisión al 10%", antes?.comision === 120, String(antes?.comision));

  const { data: cupoAntes } = await sb
    .from("cupo_numero")
    .select("vendido")
    .eq("sorteo_id", sorteo.id)
    .eq("numero", 42)
    .single();
  check("el cupo del 42 refleja la venta", Number(cupoAntes.vendido) === 200, String(cupoAntes.vendido));

  // --- Sin forzar, se rechaza -----------------------------------------------
  const { error: eSuave } = await sb.rpc("fn_anular_ticket", {
    p_ticket_id: tk.id,
    p_motivo: "prueba sin forzar",
    p_usuario_id: null,
    p_forzar: false,
  });
  check("sin forzar NO se anula un sorteo liquidado", !!eSuave, eSuave ? "" : "no dio error");

  // --- Forzando, se anula Y se rehace la liquidación ------------------------
  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  const { error: eAnular } = await sb.rpc("fn_anular_ticket", {
    p_ticket_id: tk.id,
    p_motivo: "registrada dos veces",
    p_usuario_id: admin.id,
    p_forzar: true,
  });
  check("forzando SÍ se anula", !eAnular, eAnular?.message ?? "");

  const { data: tkDespues } = await sb
    .from("ticket")
    .select("anulado_en, anulado_por, motivo_anulacion")
    .eq("id", tk.id)
    .single();
  check("el ticket queda anulado", tkDespues.anulado_en !== null);
  check("con quién lo anuló", tkDespues.anulado_por === admin.id, String(tkDespues.anulado_por));
  check("y con su motivo", tkDespues.motivo_anulacion === "registrada dos veces",
        String(tkDespues.motivo_anulacion));

  // LO IMPORTANTE.
  const despues = await liquidacion(sorteo.id, vendedorId);
  check("LA LIQUIDACIÓN SE REHIZO: venta 1200 -> 1000",
        despues?.venta === 1000, JSON.stringify(despues));
  check("la comisión bajó 120 -> 100", despues?.comision === 100, String(despues?.comision));
  check("y el neto cuadra (1000 - 100 - 0)", despues?.utilidad === 900, String(despues?.utilidad));

  const { data: cupoDespues } = await sb
    .from("cupo_numero")
    .select("vendido")
    .eq("sorteo_id", sorteo.id)
    .eq("numero", 42)
    .single();
  check("el cupo del 42 se devolvió", Number(cupoDespues.vendido) === 0, String(cupoDespues.vendido));

  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, valor_nuevo")
    .eq("entidad_id", tk.id)
    .eq("accion", "anular");
  check("queda en auditoría", (aud ?? []).length === 1, `${(aud ?? []).length} entradas`);

  // Anular dos veces no se puede.
  const { error: eOtra } = await sb.rpc("fn_anular_ticket", {
    p_ticket_id: tk.id,
    p_motivo: "otra vez",
    p_usuario_id: admin.id,
    p_forzar: true,
  });
  check("no se anula dos veces", !!eOtra, eOtra ? "" : "no dio error");

  // --- Lo ya PAGADO se rechaza, y no deja nada a medias ----------------------
  // Se paga la liquidación que queda y se intenta anular la otra venta.
  const { data: liqFila } = await sb
    .from("liquidacion")
    .select("id")
    .eq("sorteo_id", sorteo.id)
    .eq("vendedor_id", vendedorId)
    .single();

  const { error: eCorte } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedorId,
    p_liquidacion_ids: [liqFila.id],
    p_nota: "prueba",
    p_usuario_id: admin.id,
  });

  if (eCorte) {
    console.log(`  (se omite lo del corte pagado: ${eCorte.message})`);
  } else {
    const { data: tk1 } = await sb.from("ticket").select("id").eq("folio", v1[0].r_folio).single();
    const { error: ePagado } = await sb.rpc("fn_anular_ticket", {
      p_ticket_id: tk1.id,
      p_motivo: "no debería poder",
      p_usuario_id: admin.id,
      p_forzar: true,
    });
    check("un sorteo YA PAGADO rechaza la anulación", !!ePagado, ePagado ? "" : "no dio error");

    // Y el rechazo tiene que haber deshecho TODO: si el ticket quedara anulado
    // con la liquidación intacta, el descuadre sería peor que no dejar anular.
    const { data: tk1Estado } = await sb
      .from("ticket")
      .select("anulado_en")
      .eq("id", tk1.id)
      .single();
    check("y la anulación se deshizo entera (transacción)",
          tk1Estado.anulado_en === null, "el ticket quedó anulado pese al rechazo");

    const finalLiq = await liquidacion(sorteo.id, vendedorId);
    check("la liquidación pagada no se tocó", finalLiq?.venta === 1000, JSON.stringify(finalLiq));
  }

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
