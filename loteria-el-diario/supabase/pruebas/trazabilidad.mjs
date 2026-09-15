/**
 * Trazabilidad: quién cambió qué, cuándo, y de qué valor a cuál.
 *
 * LO QUE HAY QUE DEMOSTRAR
 * ------------------------
 *   · Que EL AUTOR QUEDE REGISTRADO. Es lo que faltaba: `fn_auditar` sacaba el
 *     usuario de `auth.uid()`, que es nulo desde que la aplicación habla como
 *     `service_role`, así que los 2.681 apuntes existentes no tienen autor.
 *
 *   · Que se guarden LOS DOS VALORES, el de antes y el de después. Sin el
 *     anterior, un apunte dice que algo cambió pero no desde qué.
 *
 *   · Que la consulta diga a QUÉ VENTA afecta cada cambio: sin eso un apunte
 *     dice «se corrigió una venta» y hay que ir a buscar cuál.
 *
 *   · Que los filtros salgan de lo que realmente ocurrió, no de una lista
 *     fija: ofrecer una acción que no pasó lleva a una pantalla vacía.
 *
 *   · Que los apuntes viejos sigan saliendo, sin autor. Ocultarlos sería
 *     perder historia; inventarles un nombre, peor.
 *
 *     node supabase/pruebas/trazabilidad.mjs
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

const FECHA = "2031-02-18";
const NOMBRE = "ZZZ Trazabilidad";

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
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

/** Hoy en Honduras: la consulta filtra por el día en que se registró. */
const HOY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });

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
    p_alias: "ZZZ TRAZA",
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedor = alta[0].vendedor_id;

  const { data: admin } = await sb
    .from("usuario")
    .select("id, nombre, rol")
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

  // --- Se genera actividad, la que de verdad importa auditar ------------------
  // Con `p_usuario_id`: es lo que la aplicación manda siempre, y sin él la
  // venta se registra sin autor — correctamente, porque no hay ninguno que
  // guardar. La prueba lo omitía y se acusaba a sí misma.
  const { data: tanda } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteos[0].id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: 7, monto: 100 }]],
    p_forzar: true,
    p_usuario_id: admin.id,
  });
  const { data: tk } = await sb
    .from("ticket")
    .select("id, folio")
    .eq("folio", tanda[0].r_folio)
    .single();

  // 1. Corregir una venta con números.
  const { error: eEditar } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: tk.id,
    p_lineas: [{ numero: 7, monto: 250 }],
    p_motivo: "el cliente dijo 250",
    p_usuario_id: admin.id,
  });
  if (eEditar) throw new Error(`editar: ${eEditar.message}`);

  // 2. Capturar por totales y corregirla.
  const { data: cap, error: eCap } = await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sorteos[1].id,
    p_vendedor_id: vendedor,
    p_venta: 500,
    p_premios: 0,
    p_nota: null,
    p_usuario_id: admin.id,
  });
  if (eCap) throw new Error(`capturar: ${eCap.message}`);

  const { error: eEditarCap } = await sb.rpc("fn_editar_venta_total", {
    p_id: cap[0].r_id,
    p_venta: 1500,
    p_premios: 0,
    p_nota: "eran 1500",
    p_usuario_id: admin.id,
  });
  if (eEditarCap) throw new Error(`editar captura: ${eEditarCap.message}`);

  // --- EL AUTOR QUEDA REGISTRADO ---------------------------------------------
  console.log("--- El autor ---");
  const { data: traza, error } = await sb.rpc("fn_trazabilidad", {
    p_desde: HOY,
    p_hasta: HOY,
    p_accion: null,
    p_entidad: null,
    p_usuario_id: null,
    p_limite: 500,
  });
  check("la consulta responde", !error, error?.message ?? "");

  const mias = (traza ?? []).filter(
    (f) => f.r_entidad_id === tk.id || f.r_entidad_id === cap[0].r_id,
  );
  check("los cambios aparecen", mias.length >= 3, `${mias.length}`);

  const conAutor = mias.filter((f) => f.r_usuario_id === admin.id);
  check(
    "TODOS LLEVAN QUIÉN LO HIZO",
    conAutor.length === mias.length,
    `${conAutor.length} de ${mias.length}`,
  );
  check(
    "y con su nombre resuelto, no sólo el identificador",
    conAutor.every((f) => f.r_usuario === admin.nombre),
    String(conAutor[0]?.r_usuario),
  );
  check("y su rol", conAutor.every((f) => f.r_rol === "administrador"));

  // --- Los dos valores --------------------------------------------------------
  console.log("\n--- Qué cambió, de qué a qué ---");
  const jugada = mias.find((f) => f.r_campo === "jugada");
  check("la corrección de la venta guarda la jugada", !!jugada, "no aparece");
  check(
    "con el valor ANTERIOR",
    /100/.test(String(jugada?.r_valor_anterior)),
    String(jugada?.r_valor_anterior),
  );
  check(
    "y el NUEVO",
    /250/.test(String(jugada?.r_valor_nuevo)),
    String(jugada?.r_valor_nuevo),
  );

  const ventaCap = mias.find((f) => f.r_entidad === "venta_total" && f.r_campo === "venta");
  check("la corrección de la captura también", !!ventaCap, "no aparece");
  check(
    "de 500 a 1500",
    Number(ventaCap?.r_valor_anterior) === 500 && Number(ventaCap?.r_valor_nuevo) === 1500,
    `${ventaCap?.r_valor_anterior} -> ${ventaCap?.r_valor_nuevo}`,
  );

  // --- A qué venta afecta -----------------------------------------------------
  console.log("\n--- A quién afecta ---");
  check(
    "se dice de qué vendedor es",
    jugada?.r_vendedor === "ZZZ TRAZA",
    String(jugada?.r_vendedor),
  );
  check("con su código", !!jugada?.r_codigo, String(jugada?.r_codigo));
  check(
    "y de qué sorteo",
    jugada?.r_fecha === FECHA && jugada?.r_hora === "11:00",
    `${jugada?.r_fecha} ${jugada?.r_hora}`,
  );

  // --- La hora exacta ---------------------------------------------------------
  console.log("\n--- Cuándo ---");
  const cuando = new Date(jugada?.r_ocurrido_en);
  check("la hora es un instante válido", !Number.isNaN(cuando.getTime()),
        String(jugada?.r_ocurrido_en));
  check(
    "y es de hace un momento, no una fecha inventada",
    Math.abs(Date.now() - cuando.getTime()) < 10 * 60 * 1000,
    cuando.toISOString(),
  );

  // --- Los filtros ------------------------------------------------------------
  console.log("\n--- Los filtros salen de lo que ocurrió ---");
  const { data: filtros, error: eF } = await sb.rpc("fn_trazabilidad_filtros", {
    p_desde: HOY,
    p_hasta: HOY,
  });
  check("los filtros responden", !eF, eF?.message ?? "");

  const acciones = (filtros ?? []).filter((f) => f.r_tipo === "accion").map((f) => f.r_valor);
  check("ofrece «editar», que sí ocurrió", acciones.includes("editar"),
        acciones.join(", "));
  check(
    "no ofrece acciones que no ocurrieron",
    !acciones.includes("inventada"),
    acciones.join(", "),
  );

  const usuarios = (filtros ?? []).filter((f) => f.r_tipo === "usuario");
  check("ofrece a quien hizo los cambios",
        usuarios.some((u) => u.r_valor === admin.id), JSON.stringify(usuarios.map(u=>u.r_rotulo)));

  // --- Filtrar de verdad ------------------------------------------------------
  console.log("\n--- Filtrar recorta ---");
  const { data: soloEditar } = await sb.rpc("fn_trazabilidad", {
    p_desde: HOY,
    p_hasta: HOY,
    p_accion: "editar",
    p_entidad: null,
    p_usuario_id: null,
    p_limite: 500,
  });
  check(
    "filtrando por «editar» sólo vienen ediciones",
    (soloEditar ?? []).every((f) => f.r_accion === "editar"),
    [...new Set((soloEditar ?? []).map((f) => f.r_accion))].join(", "),
  );

  const { data: soloCapturas } = await sb.rpc("fn_trazabilidad", {
    p_desde: HOY,
    p_hasta: HOY,
    p_accion: null,
    p_entidad: "venta_total",
    p_usuario_id: null,
    p_limite: 500,
  });
  check(
    "y por entidad, sólo esa entidad",
    (soloCapturas ?? []).every((f) => f.r_entidad === "venta_total"),
    [...new Set((soloCapturas ?? []).map((f) => f.r_entidad))].join(", "),
  );

  // --- Los apuntes viejos siguen ahí ------------------------------------------
  console.log("\n--- Lo anterior no se borra ni se inventa ---");
  const { count } = await sb
    .from("auditoria")
    .select("*", { count: "exact", head: true })
    .is("usuario_id", null);
  check("los apuntes sin autor siguen existiendo", (count ?? 0) > 0, `${count}`);
  console.log(`        ${count} apuntes anteriores conservan su historia, sin autor`);

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
