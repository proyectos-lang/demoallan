/**
 * Saldar el arrastre de semanas anteriores.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que el ARRASTRE QUEDE EN CERO y deje de sumar. Es todo el encargo: el
 *     saldo anterior crecía y no bajaba nunca. Se comprueba con la misma
 *     función que alimenta la pantalla —`fn_saldos_por_vendedor`—, no con una
 *     consulta paralela: si se midiera de otra forma, la prueba podría pasar
 *     mientras la pantalla sigue mostrando la deuda.
 *
 *   · Que el SALDO DE LA SEMANA EN CURSO NO SE TOQUE. Saldar lo viejo no puede
 *     llevarse por delante lo que el vendedor debe de esta semana; sería la
 *     forma más silenciosa de perder dinero.
 *
 *   · Que la DIFERENCIA se registre como ajuste en vez de repartirse entre los
 *     sorteos, y que sin motivo se rechace.
 *
 *   · Que no se pueda saldar dos veces, ni con fecha futura, ni sin nada que
 *     saldar.
 *
 * Crea un vendedor y sorteos en fechas lejanas; borra todo al final.
 *
 *     node supabase/pruebas/saldar-arrastre.mjs
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

// Dos semanas lejanas: la «vieja» arrastra, la «actual» no debe tocarse.
const VIEJA = "2031-03-03"; // lunes
const ACTUAL = "2031-03-10"; // lunes siguiente
const NOMBRE = "ZZZ Arrastre";

/*
 * Hoy en Honduras. El pago se registra HOY aunque los sorteos sean de 2031:
 * la función rechaza fechas de pago futuras, y hace bien — un pago que aún no
 * ocurrió no se registra.
 */
const HOY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });

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
  for (const f of [VIEJA, ACTUAL]) {
    const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", f);
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

/** Lo que ve la pantalla de saldos para ese vendedor en esa semana. */
async function saldos(vendedorId, desde, hasta) {
  const { data } = await sb.rpc("fn_saldos_por_vendedor", { p_desde: desde, p_hasta: hasta });
  const f = (data ?? []).find((x) => x.r_vendedor_id === vendedorId);
  if (!f) return null;
  return {
    anterior: Number(f.r_anterior),
    semana: Number(f.r_semana),
    pendiente: Number(f.r_pendiente),
    actual: Number(f.r_actual),
  };
}

/** Un sorteo vendido y liquidado sin premio, para que el saldo sea limpio. */
async function sorteoConVenta(fecha, hora, vendedorId, monto) {
  await sb.rpc("fn_programar_dia", { p_fecha: fecha });
  const { data: s } = await sb
    .from("sorteo")
    .select("id")
    .eq("fecha", fecha)
    .eq("hora", hora)
    .single();
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: s.id,
    p_vendedor_id: vendedorId,
    p_tickets: [[{ numero: 7, monto }]],
  });
  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
  // Gana el 55, que nadie jugó: sin premios el saldo es venta − comisión.
  await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: 55 });
  return s.id;
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
    p_comision: 0.1, // 10%: los números salen redondos
    p_factor_pago: 70,
    p_tope_por_numero: 500000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const id = alta[0].vendedor_id;

  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  // Semana vieja: dos sorteos, 1000 y 2000 -> saldo 900 + 1800 = 2700.
  await sorteoConVenta(VIEJA, "11:00", id, 1000);
  await sorteoConVenta(VIEJA, "15:00", id, 2000);
  // Semana actual: un sorteo de 500 -> saldo 450. NO se debe tocar.
  await sorteoConVenta(ACTUAL, "11:00", id, 500);

  const antes = await saldos(id, ACTUAL, "2031-03-16");
  check("el arrastre de la semana vieja se ve", antes?.anterior === 2700, JSON.stringify(antes));
  check("y el saldo de la semana actual", antes?.semana === 450, String(antes?.semana));
  check("el saldo actual los suma", antes?.actual === 3150, String(antes?.actual));

  // --- Qué compone el arrastre ---------------------------------------------
  const { data: det, error: eDet } = await sb.rpc("fn_arrastre_pendiente", {
    p_vendedor_id: id,
    p_desde: ACTUAL,
  });
  check("el detalle no da error", !eDet, eDet?.message ?? "");
  check("trae los dos sorteos viejos", (det ?? []).length === 2, `${(det ?? []).length}`);
  check(
    "y sólo los ANTERIORES a la semana",
    (det ?? []).every((d) => d.r_fecha < ACTUAL),
    JSON.stringify((det ?? []).map((d) => d.r_fecha)),
  );

  // --- Rechazos -------------------------------------------------------------
  const { error: eFutura } = await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: id,
    p_desde: ACTUAL,
    p_entrega: 2700,
    p_fecha_pago: "2099-01-01",
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("rechaza una fecha de pago futura", !!eFutura, eFutura ? "" : "no dio error");

  const { error: eSinMotivo } = await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: id,
    p_desde: ACTUAL,
    p_entrega: 2500, // 200 menos: hay ajuste
    p_fecha_pago: null,
    p_motivo: null,
    p_usuario_id: admin.id,
  });
  check("con diferencia y sin motivo, rechaza", !!eSinMotivo, eSinMotivo ? "" : "no dio error");

  // Nada quedó a medias tras los rechazos.
  const trasRechazos = await saldos(id, ACTUAL, "2031-03-16");
  check("los rechazos no dejaron nada a medias", trasRechazos?.anterior === 2700,
        String(trasRechazos?.anterior));

  // --- Se salda, con un ajuste ---------------------------------------------
  const { data: r, error: eSaldar } = await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: id,
    p_desde: ACTUAL,
    p_entrega: 2500,
    p_fecha_pago: HOY,
    p_motivo: "se redondeó el resto",
    p_usuario_id: admin.id,
  });
  check("se salda con motivo", !eSaldar, eSaldar?.message ?? "");

  const res = r?.[0];
  check("cierra los dos sorteos", res?.r_sorteos === 2, String(res?.r_sorteos));
  check("el saldo calculado es 2700", Number(res?.r_saldo) === 2700, String(res?.r_saldo));
  check("la entrega es 2500", Number(res?.r_entrega) === 2500, String(res?.r_entrega));
  check("y el ajuste es -200", Number(res?.r_ajuste) === -200, String(res?.r_ajuste));

  // LO IMPORTANTE.
  const despues = await saldos(id, ACTUAL, "2031-03-16");
  check("EL ARRASTRE QUEDA EN CERO", despues?.anterior === 0, String(despues?.anterior));
  check("la semana en curso NO se tocó", despues?.semana === 450, String(despues?.semana));
  check("el saldo actual ya sólo es la semana", despues?.actual === 450, String(despues?.actual));

  // --- Lo que quedó guardado ------------------------------------------------
  const { data: corte } = await sb
    .from("corte_vendedor")
    .select("saldo, entrega, ajuste, motivo_ajuste, pagado_en, registrado_en, sorteos")
    .eq("vendedor_id", id)
    .single();

  check("el corte guarda el saldo real", Number(corte.saldo) === 2700, String(corte.saldo));
  check("y lo que se entregó", Number(corte.entrega) === 2500, String(corte.entrega));
  check("y el ajuste con su motivo",
        Number(corte.ajuste) === -200 && corte.motivo_ajuste === "se redondeó el resto",
        `${corte.ajuste} / ${corte.motivo_ajuste}`);
  check("la fecha de pago es la que se puso",
        String(corte.pagado_en).startsWith(HOY), String(corte.pagado_en));
  check("y se guarda aparte cuándo se tecleó",
        corte.registrado_en !== null, String(corte.registrado_en));

  const { data: aud } = await sb
    .from("auditoria")
    .select("accion")
    .in("accion", ["saldar_arrastre", "ajustar"]);
  const acciones = new Set((aud ?? []).map((a) => a.accion));
  check("queda auditado el pago", acciones.has("saldar_arrastre"), [...acciones].join(","));
  check("y el ajuste, por separado", acciones.has("ajustar"), [...acciones].join(","));

  // --- No se salda dos veces ------------------------------------------------
  const { error: eOtra } = await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: id,
    p_desde: ACTUAL,
    p_entrega: 100,
    p_fecha_pago: null,
    p_motivo: "otra vez",
    p_usuario_id: admin.id,
  });
  check("no se salda dos veces", !!eOtra, eOtra ? "" : "no dio error");

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
