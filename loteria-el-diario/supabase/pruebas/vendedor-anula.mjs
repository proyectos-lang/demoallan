/**
 * El vendedor anula sus propias ventas, sólo con el sorteo abierto.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que CON EL SORTEO CERRADO NO PUEDA. Es todo el límite del encargo, y lo
 *     que separa «corregir un dedazo» de «quitar de los libros una apuesta que
 *     ya se sabe perdedora». Se comprueba llamando como lo hace la aplicación
 *     del vendedor —sin `p_forzar`—, no confiando en que la pantalla esconda
 *     el botón.
 *
 *   · Que CON EL SORTEO ABIERTO sí, y que el CUPO VUELVA. Anular sin devolver
 *     el cupo dejaría números bloqueados por una venta que ya no existe.
 *
 *   · Que administración SÍ pueda sobre el sorteo cerrado, con `p_forzar`. Es
 *     la vía que no debe romperse al cerrarle la puerta al vendedor.
 *
 *   · Que la lista del vendedor traiga lo que la pantalla necesita para
 *     decidir a qué fila ofrecerle el botón: el identificador y el estado.
 *
 * Crea un vendedor y sorteos en fecha lejana; borra todo al final.
 *
 *     node supabase/pruebas/vendedor-anula.mjs
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
const NOMBRE = "ZZZ Anula vendedor";

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
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

/** Lo que la aplicación del vendedor manda: nunca fuerza. */
const anularComoVendedor = (ticketId, usuarioId) =>
  sb.rpc("fn_anular_ticket", {
    p_ticket_id: ticketId,
    p_motivo: "número equivocado",
    p_usuario_id: usuarioId,
    p_forzar: false,
  });

async function cupoDe(sorteoId, numero) {
  const { data } = await sb
    .from("cupo_numero")
    .select("vendido")
    .eq("sorteo_id", sorteoId)
    .eq("numero", numero)
    .maybeSingle();
  return data ? Number(data.vendido) : 0;
}

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
    p_comision: 0.12,
    p_factor_pago: 70,
    p_tope_por_numero: 500000,
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
  const seCierra = sorteos.find((s) => s.hora === "15:00");

  for (const s of [abierto, seCierra]) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }

  const vender = async (sorteoId, numero, monto) => {
    const { data } = await sb.rpc("fn_registrar_tanda", {
      p_sorteo_id: sorteoId,
      p_vendedor_id: vendedorId,
      p_tickets: [[{ numero, monto }]],
    });
    const { data: t } = await sb
      .from("ticket")
      .select("id")
      .eq("folio", data[0].r_folio)
      .single();
    return t.id;
  };

  const enAbierto = await vender(abierto.id, 7, 300);
  const enCerrado = await vender(seCierra.id, 7, 500);
  const paraAdmin = await vender(seCierra.id, 42, 200);

  // --- La lista trae lo que la pantalla necesita ------------------------------
  const { data: lista, error: eLista } = await sb.rpc("fn_mis_tickets", {
    p_vendedor_id: vendedorId,
    p_fecha: FECHA,
    p_limite: 40,
  });
  check("la lista no da error", !eLista, eLista?.message ?? "");

  const fila = (lista ?? []).find((f) => f.r_ticket_id === enAbierto);
  check("trae el identificador del ticket", !!fila, "no vino r_ticket_id");
  check("y el estado del sorteo", fila?.r_estado === "abierto", String(fila?.r_estado));

  // --- Con el sorteo abierto: sí, y el cupo vuelve ----------------------------
  const cupoAntes = await cupoDe(abierto.id, 7);
  check("el cupo refleja la venta", cupoAntes === 300, String(cupoAntes));

  const { error: eAbierto } = await anularComoVendedor(enAbierto, admin.id);
  check("CON EL SORTEO ABIERTO el vendedor SÍ puede", !eAbierto, eAbierto?.message ?? "");

  const { data: tkAbierto } = await sb
    .from("ticket")
    .select("anulado_en, motivo_anulacion")
    .eq("id", enAbierto)
    .single();
  check("la venta queda anulada", tkAbierto.anulado_en !== null);
  check("con su motivo", tkAbierto.motivo_anulacion === "número equivocado",
        String(tkAbierto.motivo_anulacion));
  check("EL CUPO VUELVE", (await cupoDe(abierto.id, 7)) === 0, String(await cupoDe(abierto.id, 7)));

  // Anular dos veces no se puede.
  const { error: eOtra } = await anularComoVendedor(enAbierto, admin.id);
  check("no se anula dos veces", !!eOtra, eOtra ? "" : "no dio error");

  // --- Con el sorteo cerrado: NO -----------------------------------------------
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: seCierra.id });

  const cupoCerrado = await cupoDe(seCierra.id, 7);
  const { error: eCerrado } = await anularComoVendedor(enCerrado, admin.id);
  check("CON EL SORTEO CERRADO el vendedor NO puede", !!eCerrado, eCerrado ? "" : "no dio error");

  const { data: tkCerrado } = await sb
    .from("ticket")
    .select("anulado_en")
    .eq("id", enCerrado)
    .single();
  check("y la venta sigue viva", tkCerrado.anulado_en === null, "quedó anulada pese al rechazo");
  check("y el cupo no se movió", (await cupoDe(seCierra.id, 7)) === cupoCerrado,
        `era ${cupoCerrado}`);

  // La lista lo dice, para que la pantalla no ofrezca el botón ahí.
  const { data: lista2 } = await sb.rpc("fn_mis_tickets", {
    p_vendedor_id: vendedorId,
    p_fecha: FECHA,
    p_limite: 40,
  });
  const filaCerrada = (lista2 ?? []).find((f) => f.r_ticket_id === enCerrado);
  check("la lista marca ese sorteo como cerrado", filaCerrada?.r_estado === "cerrado",
        String(filaCerrada?.r_estado));

  // --- Administración sí, forzando ---------------------------------------------
  const { error: eAdmin } = await sb.rpc("fn_anular_ticket", {
    p_ticket_id: paraAdmin,
    p_motivo: "corrección de administración",
    p_usuario_id: admin.id,
    p_forzar: true,
  });
  check("administración SÍ puede sobre el cerrado", !eAdmin, eAdmin?.message ?? "");

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
