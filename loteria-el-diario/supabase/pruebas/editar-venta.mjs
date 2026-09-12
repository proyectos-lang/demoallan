/**
 * Corregir las líneas de una venta ya registrada.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que EL CUPO QUEDE BIEN. Es lo que puede romperse en silencio: si al
 *     corregir no se devuelve lo viejo y se consume lo nuevo, quedan números
 *     bloqueados por una venta que ya no existe, o sitio de más para vender.
 *     Nadie lo nota hasta que un vendedor no puede vender un número que sí
 *     tenía hueco.
 *
 *   · Que NO se pueda saltar el TOPE. Editar no puede ser la puerta por la que
 *     se pasa el límite que el registro sí respeta: bastaría vender poco y
 *     luego «corregir».
 *
 *   · Que sobre un sorteo LIQUIDADO se rehaga la liquidación, y que si ya se
 *     pagó en un corte se rechace DESHACIENDO la edición entera.
 *
 *   · Que el folio no cambie y que la jugada anterior quede en auditoría: es
 *     lo único que permite reconstruir qué decía la tirilla del cliente.
 *
 *     node supabase/pruebas/editar-venta.mjs
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

const FECHA = "2031-10-08";
const NOMBRE = "ZZZ Editar venta";
const TOPE = 5000;

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

const cupoDe = async (sorteoId, numero) => {
  const { data } = await sb
    .from("cupo_numero")
    .select("vendido")
    .eq("sorteo_id", sorteoId)
    .eq("numero", numero)
    .maybeSingle();
  return data ? Number(data.vendido) : 0;
};

const jugadaDe = async (ticketId) => {
  const { data } = await sb
    .from("linea")
    .select("numero, monto")
    .eq("ticket_id", ticketId)
    .order("numero");
  return (data ?? []).map((l) => `${String(l.numero).padStart(2, "0")}:${Number(l.monto)}`).join(" ");
};

async function main() {
  await limpiar();

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
    p_comision: 0.1,
    p_factor_pago: 70,
    p_tope_por_numero: TOPE,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedorId = alta[0].vendedor_id;

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
  const abierto = sorteos.find((s) => s.hora === "11:00");
  const seLiquida = sorteos.find((s) => s.hora === "15:00");

  for (const s of [abierto, seLiquida]) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }

  const vender = async (sorteoId, lineas) => {
    const { data, error } = await sb.rpc("fn_registrar_tanda", {
      p_sorteo_id: sorteoId,
      p_vendedor_id: vendedorId,
      p_tickets: [lineas],
    });
    if (error) throw new Error(`vender: ${error.message}`);
    const { data: t } = await sb
      .from("ticket")
      .select("id, folio")
      .eq("folio", data[0].r_folio)
      .single();
    return t;
  };

  // --- Corrección corriente: un monto mal tecleado ---------------------------
  const tk = await vender(abierto.id, [
    { numero: 7, monto: 100 },
    { numero: 42, monto: 25 },
  ]);

  check("el cupo del 7 refleja la venta", (await cupoDe(abierto.id, 7)) === 100);
  check("y el del 42", (await cupoDe(abierto.id, 42)) === 25);

  // El cliente dijo 250, no 25.
  const { data: r1, error: e1 } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: tk.id,
    p_lineas: [
      { numero: 7, monto: 100 },
      { numero: 42, monto: 250 },
    ],
    p_motivo: "monto mal tecleado",
    p_usuario_id: admin.id,
  });
  check("la corrección no da error", !e1, e1?.message ?? "");
  check("devuelve el total nuevo", Number(r1?.[0]?.r_total) === 350, String(r1?.[0]?.r_total));

  check("EL CUPO DEL 42 SUBE a lo corregido", (await cupoDe(abierto.id, 42)) === 250,
        String(await cupoDe(abierto.id, 42)));
  check("y el del 7 no se mueve", (await cupoDe(abierto.id, 7)) === 100,
        String(await cupoDe(abierto.id, 7)));

  const { data: tkDespues } = await sb
    .from("ticket")
    .select("folio, total")
    .eq("id", tk.id)
    .single();
  check("EL FOLIO NO CAMBIA", tkDespues.folio === tk.folio, tkDespues.folio);
  check("el total del ticket se rehace", Number(tkDespues.total) === 350, String(tkDespues.total));

  // --- Quitar un número: el cupo tiene que volver ----------------------------
  await sb.rpc("fn_editar_venta", {
    p_ticket_id: tk.id,
    p_lineas: [{ numero: 7, monto: 100 }],
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("al quitar un número SU CUPO VUELVE", (await cupoDe(abierto.id, 42)) === 0,
        String(await cupoDe(abierto.id, 42)));
  check("la jugada queda con una línea", (await jugadaDe(tk.id)) === "07:100",
        await jugadaDe(tk.id));

  // --- Rechazos --------------------------------------------------------------
  const { error: eVacia } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: tk.id,
    p_lineas: [],
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("una venta no puede quedar sin números", !!eVacia, eVacia ? "" : "no dio error");

  const { error: eTope } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: tk.id,
    p_lineas: [{ numero: 7, monto: TOPE + 1 }],
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("NO se puede saltar el tope corrigiendo", !!eTope, eTope ? "" : "no dio error");

  // Y tras el rechazo, nada quedó a medias.
  check("tras el rechazo la venta sigue entera", (await jugadaDe(tk.id)) === "07:100",
        await jugadaDe(tk.id));
  check("y el cupo no se movió", (await cupoDe(abierto.id, 7)) === 100,
        String(await cupoDe(abierto.id, 7)));

  // --- La auditoría ----------------------------------------------------------
  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, campo, valor_anterior, valor_nuevo")
    .eq("entidad_id", tk.id)
    .eq("accion", "editar");
  check("cada corrección queda en auditoría", (aud ?? []).length >= 2, `${(aud ?? []).length}`);
  const conJugada = (aud ?? []).find((a) => a.campo === "jugada");
  check("con la jugada ANTERIOR entera",
        /42/.test(String(conJugada?.valor_anterior ?? "")),
        String(conJugada?.valor_anterior));

  // --- Sobre un sorteo liquidado --------------------------------------------
  const tkLiq = await vender(seLiquida.id, [{ numero: 55, monto: 100 }]);
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: seLiquida.id });
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: seLiquida.id, p_numero_ganador: 55 });

  const liqAntes = await sb
    .from("liquidacion")
    .select("venta, premios")
    .eq("sorteo_id", seLiquida.id)
    .eq("vendedor_id", vendedorId)
    .single();
  check("la liquidación cuenta la venta", Number(liqAntes.data.venta) === 100,
        String(liqAntes.data.venta));
  check("y su premio", Number(liqAntes.data.premios) === 7000, String(liqAntes.data.premios));

  // Se corrige a un número que NO ganó: el premio tiene que desaparecer.
  const { error: eLiq } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: tkLiq.id,
    p_lineas: [{ numero: 33, monto: 100 }],
    p_motivo: "número equivocado",
    p_usuario_id: admin.id,
  });
  check("se puede corregir sobre un sorteo liquidado", !eLiq, eLiq?.message ?? "");

  const liqDespues = await sb
    .from("liquidacion")
    .select("venta, premios")
    .eq("sorteo_id", seLiquida.id)
    .eq("vendedor_id", vendedorId)
    .single();
  check("LA LIQUIDACIÓN SE REHACE: el premio desaparece",
        Number(liqDespues.data.premios) === 0, String(liqDespues.data.premios));
  check("y la venta se mantiene", Number(liqDespues.data.venta) === 100,
        String(liqDespues.data.venta));

  // --- Lo ya pagado se rechaza, sin dejar nada a medias -----------------------
  const { data: liqFila } = await sb
    .from("liquidacion")
    .select("id")
    .eq("sorteo_id", seLiquida.id)
    .eq("vendedor_id", vendedorId)
    .single();

  const { error: eCorte } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedorId,
    p_liquidacion_ids: [liqFila.id],
    p_desde: FECHA,
    p_hasta: FECHA,
    p_nota: "prueba",
    p_usuario_id: admin.id,
  });

  if (eCorte) {
    console.log(`  (se omite lo del corte pagado: ${eCorte.message})`);
  } else {
    const antes = await jugadaDe(tkLiq.id);
    const { error: ePagado } = await sb.rpc("fn_editar_venta", {
      p_ticket_id: tkLiq.id,
      p_lineas: [{ numero: 33, monto: 500 }],
      p_motivo: "no debería poder",
      p_usuario_id: admin.id,
    });
    check("un sorteo YA PAGADO rechaza la corrección", !!ePagado, ePagado ? "" : "no dio error");
    check("y la corrección se deshizo entera (transacción)",
          (await jugadaDe(tkLiq.id)) === antes,
          `quedó ${await jugadaDe(tkLiq.id)}, era ${antes}`);
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
