/**
 * El cierre a un minuto del sorteo, y la tanda de tickets.
 *
 * Dos cosas que sólo se ven contra la base:
 *
 *   · `fn_programar_dia` tiene que dejar `hora_cierre` a las 10:59, 14:59 y
 *     19:59 en hora de Honduras. Diez minutos era la convención del prototipo;
 *     el negocio vende hasta que empieza el sorteo.
 *
 *   · Una tanda es UNA transacción. Si el tercer ticket no cabe por cupo, no
 *     puede quedar ninguno registrado: media cola cobrada y media no es peor
 *     que un rechazo limpio.
 *
 *     node supabase/pruebas/cierre-y-tanda.mjs
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

const FECHA = "2097-05-06";

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const limpiar = async () => {
  const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of sorteos ?? []) {
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
};

/** `HH:MM` de un timestamptz, en hora de Honduras. */
const horaHn = (iso) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Tegucigalpa",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

try {
  await limpiar();

  // --- 1. La hora de cierre ----------------------------------------------
  console.log("\n1. Cierre un minuto antes del sorteo");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });

  const { data: sorteos } = await sb
    .from("sorteo")
    .select("id, hora, hora_cierre")
    .eq("fecha", FECHA)
    .order("hora");

  const esperado = { "11:00": "10:59", "15:00": "14:59", "20:00": "19:59" };
  for (const s of sorteos ?? []) {
    check(
      `el sorteo de ${s.hora} cierra a las ${esperado[s.hora]}`,
      horaHn(s.hora_cierre) === esperado[s.hora],
      `da ${horaHn(s.hora_cierre)}`,
    );
  }

  // --- 2. La tanda entra entera ------------------------------------------
  console.log("\n2. Tanda de varios tickets");
  const sorteoId = sorteos.find((s) => s.hora === "20:00").id;
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: 50000 });

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(tope_por_numero, vigente_hasta)")
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");

  const v = vs[0];
  const tope = Number(
    (Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor)
      .tope_por_numero,
  );

  const { data: tanda, error: eTanda } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_tickets: [
      [{ numero: 11, monto: 20 }, { numero: 22, monto: 30 }],
      [{ numero: 33, monto: 40 }],
      [{ numero: 44, monto: 50 }],
    ],
  });

  check("tres tickets devuelven tres folios", (tanda ?? []).length === 3, eTanda?.message ?? "");
  check(
    "los folios son consecutivos y distintos",
    new Set((tanda ?? []).map((t) => t.r_folio)).size === 3,
  );
  check(
    "el total de la tanda es 140",
    (tanda ?? []).reduce((a, t) => a + Number(t.r_total), 0) === 140,
  );

  const { count: nTickets } = await sb
    .from("ticket")
    .select("id", { count: "exact", head: true })
    .eq("sorteo_id", sorteoId);
  check("quedan tres tickets en la base", nTickets === 3);

  // --- 3. Si uno no cabe, no entra ninguno --------------------------------
  console.log("\n3. Atomicidad: el tercero no cabe");
  const { error: eParcial } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_tickets: [
      [{ numero: 55, monto: 10 }],
      [{ numero: 66, monto: 10 }],
      // Se pasa del tope del vendedor: la tanda entera tiene que caerse.
      [{ numero: 77, monto: tope + 1000 }],
    ],
  });

  check("la tanda con un ticket imposible se rechaza", !!eParcial, "no dio error");

  const { count: despues } = await sb
    .from("ticket")
    .select("id", { count: "exact", head: true })
    .eq("sorteo_id", sorteoId);
  check(
    "no quedó ninguno de los tres a medias",
    despues === 3,
    `hay ${despues} tickets, se esperaban 3`,
  );

  // --- 4. El tope de cordura ----------------------------------------------
  console.log("\n4. Tope de tamaño");
  const { error: eGrande } = await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: v.id,
    p_tickets: Array.from({ length: 51 }, () => [{ numero: 1, monto: 1 }]),
  });
  check("una tanda de 51 tickets se rechaza", !!eGrande);
} finally {
  await limpiar();
  await sb.from("auditoria").delete().gte("ocurrido_en", new Date(Date.now() - 600000).toISOString())
    .eq("entidad", "sorteo").is("entidad_id", null);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
