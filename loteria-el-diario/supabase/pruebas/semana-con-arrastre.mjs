/**
 * La semana en curso aparece aunque el vendedor no haya vendido.
 *
 * EL CASO QUE LO MOTIVA
 * ---------------------
 * La tarjeta de «arrastre de semanas anteriores» —y su botón de saldar— no
 * salía nunca en la hoja del vendedor. La causa: `fn_liquidacion_por_semana`
 * construye la lista desde `liquidacion`, así que una semana sólo existe si en
 * ella hubo ventas. Y el arrastre se muestra en la semana SIGUIENTE a la que
 * lo generó.
 *
 * Un vendedor que dejó saldo y no ha vuelto a vender arrastra una deuda que no
 * tiene dónde verse — y es justo a quien hay que ir a cobrarle.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que un vendedor con saldo viejo y sin ventas esta semana TENGA una fila
 *     para la semana en curso, con el arrastre a la vista.
 *   · Que esa fila venga en CERO en lo suyo: no vendió nada, y decir otra cosa
 *     sería inventar.
 *   · Que a quien no arrastra nada NO se le añada una fila vacía: sería ruido
 *     en el riel de semanas.
 *   · Que las semanas con ventas no cambien.
 *
 *     node supabase/pruebas/semana-con-arrastre.mjs
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

const NOMBRE = "ZZZ Arrastre visible";

/** El lunes de la semana en curso, en Honduras. */
const HOY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
const lunesDe = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toLocaleDateString("en-CA");
};
const LUNES = lunesDe(HOY);
// Una semana bien atrás: la deuda se generó y nunca se volvió a vender.
const VIEJA = (() => {
  const d = new Date(`${LUNES}T12:00:00`);
  d.setDate(d.getDate() - 21);
  return d.toLocaleDateString("en-CA");
})();

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
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", VIEJA);
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

const crear = async (sufijo) => {
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
    p_alias: null,
  });
  if (error) throw new Error(`${sufijo}: ${error.message}`);
  return data[0].vendedor_id;
};

async function main() {
  await limpiar();

  // DEBE: vendió hace tres semanas y dejó saldo. SIN: no tiene nada.
  const debe = await crear("DEBE");
  const sin = await crear("SIN");

  await sb.rpc("fn_programar_dia", { p_fecha: VIEJA });
  const { data: s } = await sb
    .from("sorteo")
    .select("id")
    .eq("fecha", VIEJA)
    .eq("hora", "11:00")
    .single();
  // Cada paso se comprueba: un fallo silencioso aquí haría creer que el
  // defecto está en la función que se quiere probar.
  for (const [que, p] of [
    ["abrir", sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 })],
  ]) {
    const { error } = await p;
    if (error) { console.log(`no se pudo ${que}: ${error.message}`); await limpiar(); process.exit(1); }
  }
  /*
   * Se vende FORZANDO, que es lo que hace administración.
   *
   * El sorteo es de hace tres semanas y su hora de venta pasó hace mucho: la
   * base lo rechaza, y hace bien. Forzar es la vía legítima para registrar
   * sobre un sorteo cerrado, y aquí sólo sirve para montar el escenario —un
   * saldo viejo sin pagar— que es lo que de verdad se quiere probar.
   */
  const { error: eVenta } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: s.id,
    p_vendedor_id: debe,
    p_tickets: [[{ numero: 7, monto: 1000 }]],
    p_forzar: true,
  });
  if (eVenta) { console.log("no se pudo vender:", eVenta.message); await limpiar(); process.exit(1); }

  const { error: eCierre } = await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
  if (eCierre) { console.log("no se pudo cerrar:", eCierre.message); await limpiar(); process.exit(1); }

  const { error: eLiq } = await sb.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: s.id, p_numero_ganador: 55,
  });
  if (eLiq) { console.log("no se pudo liquidar:", eLiq.message); await limpiar(); process.exit(1); }

  // --- El que arrastra ---------------------------------------------------
  const { data: semanas, error } = await sb.rpc("fn_liquidacion_por_semana", {
    p_vendedor_id: debe,
  });
  check("la consulta no da error", !error, error?.message ?? "");

  const enCurso = (semanas ?? []).find((x) => x.r_inicio === LUNES);
  check(
    "LA SEMANA EN CURSO APARECE aunque no vendió",
    !!enCurso,
    `semanas: ${(semanas ?? []).map((x) => x.r_inicio).join(", ")}`,
  );

  if (enCurso) {
    // 1000 − 100 de comisión = 900 de saldo viejo.
    check(
      "y trae el arrastre a la vista",
      Number(enCurso.r_arrastre) === 900,
      String(enCurso.r_arrastre),
    );
    check("sin inventar venta", Number(enCurso.r_venta) === 0, String(enCurso.r_venta));
    check("ni sorteos", enCurso.r_sorteos === 0, String(enCurso.r_sorteos));
    check(
      "el acumulado es sólo lo de atrás",
      Number(enCurso.r_acumulado) === 900,
      String(enCurso.r_acumulado),
    );
  }

  // La semana en que sí vendió no cambia.
  const vieja = (semanas ?? []).find((x) => x.r_inicio === lunesDe(VIEJA));
  check("la semana con ventas sigue igual", Number(vieja?.r_pendiente) === 900,
        String(vieja?.r_pendiente));

  // --- El que no arrastra nada -------------------------------------------
  const { data: sinNada } = await sb.rpc("fn_liquidacion_por_semana", {
    p_vendedor_id: sin,
  });
  check(
    "a quien no debe nada NO se le añade una semana vacía",
    (sinNada ?? []).length === 0,
    `${(sinNada ?? []).length} semanas`,
  );

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
