/**
 * Reimpresión de la tirilla de una venta.
 *
 * Lo que se comprueba, en orden de importancia:
 *
 *   · Que reimprimir NO REGISTRE NADA. Es la propiedad de la que depende todo
 *     lo demás: se llama diez veces seguidas y al final tiene que haber el
 *     mismo número de tickets, las mismas líneas y el mismo cupo vendido. Un
 *     vendedor ya reportó una vez que reimprimir le había duplicado una venta
 *     —resultó ser un doble envío del registro, no una reimpresión—, así que
 *     esto se demuestra en vez de afirmarse.
 *
 *   · Que un vendedor NO PUEDA SACAR la tirilla de otro. El folio llega del
 *     navegador; lo único que impide leer las apuestas ajenas es el filtro por
 *     vendedor de la propia función.
 *
 *   · Que las líneas vuelvan completas y en el mismo orden que se imprimieron.
 *
 * Crea dos vendedores y un sorteo en una fecha lejana; borra todo al final.
 *
 *     node supabase/pruebas/reimprimir.mjs
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

// Una fecha lejana: no se cruza con ningún sorteo real ni con los informes.
const FECHA = "2031-04-17";
const NOMBRE_A = "ZZZ Reimpresion A";
const NOMBRE_B = "ZZZ Reimpresion B";

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
    for (const t of tks ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", "ZZZ Reimpresion%");
  for (const v of vs ?? []) {
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

const crearVendedor = async (nombre, alias) => {
  const { data, error } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: nombre,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.125,
    p_factor_pago: 70,
    p_tope_por_numero: 5000,
    p_alias: alias,
  });
  if (error) throw new Error(`${nombre}: ${error.message}`);
  return data[0].vendedor_id;
};

async function main() {
  await limpiar();

  const idA = await crearVendedor(NOMBRE_A, "TIRILLA A");
  const idB = await crearVendedor(NOMBRE_B, null);

  // Un sorteo propio en la fecha lejana.
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteo } = await sb
    .from("sorteo")
    .select("id")
    .eq("fecha", FECHA)
    .eq("hora", "11:00")
    .single();
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteo.id, p_limite_por_numero: 50000 });

  // La venta que se va a reimprimir. Tres líneas, una con decimales, para que
  // se vea si algo se pierde por el camino.
  const LINEAS = [
    { numero: 7, monto: 100 },
    { numero: 42, monto: 250.5 },
    { numero: 7, monto: 50 },
  ];
  const { data: venta, error: eVenta } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteo.id,
    p_vendedor_id: idA,
    p_tickets: [LINEAS],
  });
  if (eVenta) {
    console.log("no se pudo registrar la venta de prueba:", eVenta.message);
    await limpiar();
    process.exit(1);
  }
  const folio = venta[0].r_folio;

  // --- Estado ANTES de reimprimir ------------------------------------------
  const contar = async () => {
    const { count: tickets } = await sb
      .from("ticket")
      .select("id", { count: "exact", head: true })
      .eq("sorteo_id", sorteo.id);
    const { data: cupos } = await sb
      .from("cupo_numero")
      .select("numero, vendido")
      .eq("sorteo_id", sorteo.id)
      .in("numero", [7, 42]);
    const vendido = (cupos ?? []).reduce((a, c) => a + Number(c.vendido), 0);
    const { data: t } = await sb.from("ticket").select("id").eq("folio", folio).single();
    const { count: lineas } = await sb
      .from("linea")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", t.id);
    return { tickets, vendido, lineas };
  };

  const antes = await contar();

  // --- Lo que devuelve ------------------------------------------------------
  const { data: r1, error: e1 } = await sb.rpc("fn_ticket_para_reimprimir", {
    p_folio: folio,
    p_vendedor_id: idA,
  });
  check("la reimpresión no da error", !e1, e1?.message ?? "");

  const t1 = r1?.[0];
  check("devuelve el ticket", !!t1, "no vino nada");

  if (t1) {
    check("el folio coincide", t1.r_folio === folio, t1.r_folio);
    check("el total coincide", Number(t1.r_total) === 400.5, String(t1.r_total));
    check("trae el alias del vendedor", t1.r_alias === "TIRILLA A", String(t1.r_alias));
    check("trae el código de barras", /^\d{13}$/.test(t1.r_codigo ?? ""), String(t1.r_codigo));
    check("no está anulado", t1.r_anulado === false, String(t1.r_anulado));
    check("la fecha del sorteo coincide", t1.r_fecha === FECHA, t1.r_fecha);

    const ls = t1.r_lineas ?? [];
    check("devuelve las tres líneas", ls.length === 3, `vinieron ${ls.length}`);
    // Ordenadas por número y monto, como se imprimieron.
    check(
      "las líneas vienen en el mismo orden que se imprimieron",
      JSON.stringify(ls.map((l) => [Number(l.numero), Number(l.monto)])) ===
        JSON.stringify([[7, 50], [7, 100], [42, 250.5]]),
      JSON.stringify(ls),
    );
    check(
      "los decimales sobreviven",
      ls.some((l) => Number(l.monto) === 250.5),
      JSON.stringify(ls.map((l) => l.monto)),
    );
  }

  // --- LO IMPORTANTE: reimprimir no registra nada ---------------------------
  for (let i = 0; i < 10; i++) {
    await sb.rpc("fn_ticket_para_reimprimir", { p_folio: folio, p_vendedor_id: idA });
  }
  const despues = await contar();

  check("diez reimpresiones NO crean tickets", despues.tickets === antes.tickets,
        `antes ${antes.tickets}, después ${despues.tickets}`);
  check("diez reimpresiones NO crean líneas", despues.lineas === antes.lineas,
        `antes ${antes.lineas}, después ${despues.lineas}`);
  check("diez reimpresiones NO mueven el cupo", despues.vendido === antes.vendido,
        `antes ${antes.vendido}, después ${despues.vendido}`);

  // --- La frontera entre vendedores -----------------------------------------
  const { data: ajeno } = await sb.rpc("fn_ticket_para_reimprimir", {
    p_folio: folio,
    p_vendedor_id: idB,
  });
  check("un vendedor NO ve la tirilla de otro", (ajeno ?? []).length === 0,
        `devolvió ${(ajeno ?? []).length} filas`);

  // Administración sí, por la otra puerta.
  const { data: comoAdmin } = await sb.rpc("fn_ticket_para_reimprimir_admin", { p_folio: folio });
  check("administración sí puede", (comoAdmin ?? []).length === 1,
        `devolvió ${(comoAdmin ?? []).length} filas`);

  // Un folio que no existe no devuelve nada, y no revienta.
  const { data: fantasma, error: eF } = await sb.rpc("fn_ticket_para_reimprimir", {
    p_folio: "V999-20310417-9999",
    p_vendedor_id: idA,
  });
  check("un folio inexistente devuelve vacío sin error", !eF && (fantasma ?? []).length === 0,
        eF?.message ?? `${(fantasma ?? []).length} filas`);

  // --- Un ticket anulado se puede reimprimir, marcado ------------------------
  const { data: tk } = await sb.from("ticket").select("id").eq("folio", folio).single();
  const { error: eAnular } = await sb.rpc("fn_anular_ticket", { p_ticket_id: tk.id });
  if (!eAnular) {
    const { data: r2 } = await sb.rpc("fn_ticket_para_reimprimir", {
      p_folio: folio,
      p_vendedor_id: idA,
    });
    check("un ticket anulado se sigue pudiendo imprimir", (r2 ?? []).length === 1,
          `devolvió ${(r2 ?? []).length} filas`);
    check("y viene marcado como anulado", r2?.[0]?.r_anulado === true, String(r2?.[0]?.r_anulado));
  } else {
    console.log(`  (se omite lo del anulado: ${eAnular.message})`);
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
