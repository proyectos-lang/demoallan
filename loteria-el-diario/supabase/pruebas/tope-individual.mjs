/**
 * El tope por número es de CADA VENDEDOR. Nunca se comparte.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * Vendedores reportaron que no les dejaba vender el 94 «aunque no lo hubieran
 * vendido». Tenían razón: en el sorteo de las 11:00 del 13 de septiembre el 94
 * lo jugaron dieciocho vendedores distintos y entre todos completaron los
 * 4.000 de `limite_casa`. A partir de ahí el número quedó cerrado para todo el
 * mundo, incluidos los que no habían vendido ni una lempira en él.
 *
 * Los contadores estaban bien —se compararon los 300 números del día contra
 * las líneas vivas, sin un solo descuadre—. Lo que estaba mal era la regla:
 * había un segundo techo, compartido, que nadie pidió.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que un vendedor pueda vender SU TOPE ENTERO por muy agotado que esté el
 *     número para los demás. Es el caso reportado, del derecho.
 *   · Que varios vendedores sumados puedan pasarse holgadamente del viejo
 *     límite de la casa sin que nadie sea rechazado.
 *   · Que el tope propio SIGA rechazando: quitar el techo compartido no puede
 *     haber abierto la puerta a vender sin límite.
 *   · Que el mensaje diga que es SU límite, con la cifra, para que nadie
 *     vuelva a leer «cupo agotado» y entienda que el sistema falló.
 *   · Que `cupo_numero.vendido` se siga llevando al día: de ahí sale la
 *     lectura de exposición de la casa, que no se quiso perder.
 *
 *     node supabase/pruebas/cupo-de-quien.mjs
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

const FECHA = "2031-12-03";
const NOMBRE = "ZZZ Tope individual";
const NUM = 94;
/** Deliberadamente pequeño: con 500 y cuatro vendedores de 400, se desborda. */
const CASA = 500;
const TOPE = 400;

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
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

async function main() {
  await limpiar();

  const crear = async (sufijo, tope) => {
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
      p_tope_por_numero: tope,
      p_alias: null,
    });
    if (error) throw new Error(`${sufijo}: ${error.message}`);
    return data[0].vendedor_id;
  };

  const vendedores = [];
  for (const s of ["UNO", "DOS", "TRES", "CUATRO"]) {
    vendedores.push({ nombre: s, id: await crear(s, TOPE) });
  }

  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: s } = await sb
    .from("sorteo")
    .select("id")
    .eq("fecha", FECHA)
    .eq("hora", "11:00")
    .single();

  const { error: eAbrir } = await sb.rpc("fn_abrir_sorteo", {
    p_sorteo_id: s.id,
    p_limite_por_numero: CASA,
  });
  if (eAbrir) {
    console.log("no se pudo abrir:", eAbrir.message);
    await limpiar();
    process.exit(1);
  }

  const vender = (vendedorId, monto) =>
    sb.rpc("fn_registrar_tanda", {
      p_sorteo_id: s.id,
      p_vendedor_id: vendedorId,
      p_tickets: [[{ numero: NUM, monto }]],
      p_forzar: true,
    });

  // --- Cada uno vende lo suyo, pase lo que pase con los demás ----------------
  console.log(`--- Cuatro vendedores de ${TOPE} sobre una casa de ${CASA} ---`);

  for (const v of vendedores) {
    const { error } = await vender(v.id, TOPE);
    check(
      `${v.nombre} vende sus ${TOPE} completos`,
      !error,
      error?.message ?? "",
    );
  }

  const { data: cupo } = await sb
    .from("cupo_numero")
    .select("limite_casa, vendido")
    .eq("sorteo_id", s.id)
    .eq("numero", NUM)
    .single();

  console.log(
    `        vendido ${cupo.vendido} sobre un limite_casa de ${cupo.limite_casa}`,
  );
  check(
    "EL VIEJO LÍMITE DE LA CASA SE SUPERA sin rechazar a nadie",
    Number(cupo.vendido) === TOPE * vendedores.length,
    `${cupo.vendido}`,
  );
  check(
    "y el contador se sigue llevando al día",
    Number(cupo.vendido) > Number(cupo.limite_casa),
    `${cupo.vendido} vs ${cupo.limite_casa}`,
  );

  // --- El caso reportado, del derecho ---------------------------------------
  console.log("\n--- El caso reportado: llegar cuando otros ya lo agotaron ---");

  const tarde = await crear("TARDE", TOPE);

  const { data: suyas } = await sb
    .from("linea")
    .select("monto, ticket!inner(vendedor_id, sorteo_id)")
    .eq("numero", NUM)
    .eq("ticket.vendedor_id", tarde)
    .eq("ticket.sorteo_id", s.id);
  check("el vendedor nuevo no ha vendido nada en ese número",
        (suyas ?? []).length === 0, `${(suyas ?? []).length} líneas`);

  const { error: eTarde } = await vender(tarde, TOPE);
  check(
    "PUEDE VENDER SU TOPE ENTERO aunque el número esté agotadísimo",
    !eTarde,
    eTarde?.message ?? "",
  );

  // --- Pero su propio tope sigue mandando -----------------------------------
  console.log("\n--- El tope propio sigue rechazando ---");

  const { error: eSuyo } = await vender(tarde, 1);
  check("una lempira más que su tope se rechaza", !!eSuyo,
        eSuyo ? "" : "no dio error — el tope dejó de aplicarse");
  if (eSuyo) console.log(`        «${eSuyo.message}»`);
  check(
    "y el mensaje dice que es SU límite",
    /ya vendió todo lo que tiene permitido/i.test(eSuyo?.message ?? ""),
    eSuyo?.message ?? "",
  );
  check(
    "diciendo cuál es la cifra",
    new RegExp(`${TOPE}`).test(eSuyo?.message ?? ""),
    eSuyo?.message ?? "",
  );
  check(
    "sin hablar de un cupo compartido, que ya no existe",
    !/casa|todos los vendedores/i.test(eSuyo?.message ?? ""),
    eSuyo?.message ?? "",
  );

  // --- Y corregir una venta tampoco choca contra la casa ---------------------
  console.log("\n--- Corregir tampoco choca contra el viejo techo ---");

  const { data: unTicket } = await sb
    .from("ticket")
    .select("id")
    .eq("sorteo_id", s.id)
    .eq("vendedor_id", vendedores[0].id)
    .is("anulado_en", null)
    .limit(1)
    .single();

  const { error: eEditar } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: unTicket.id,
    p_lineas: [{ numero: NUM, monto: TOPE }],
    p_motivo: "misma cifra, para probar el camino",
    p_usuario_id: null,
  });
  check(
    "se puede corregir una venta con el número desbordado",
    !eEditar,
    eEditar?.message ?? "",
  );

  // --- Los contadores siguen cuadrando --------------------------------------
  console.log("\n--- Los contadores ---");
  const { data: tks } = await sb
    .from("ticket")
    .select("id")
    .eq("sorteo_id", s.id)
    .is("anulado_en", null);
  const { data: lineas } = await sb
    .from("linea")
    .select("monto")
    .eq("numero", NUM)
    .in("ticket_id", (tks ?? []).map((t) => t.id));
  const real = (lineas ?? []).reduce((a, l) => a + Number(l.monto), 0);

  const { data: cupoFin } = await sb
    .from("cupo_numero")
    .select("vendido")
    .eq("sorteo_id", s.id)
    .eq("numero", NUM)
    .single();

  check(
    "el contador coincide con las líneas vivas",
    Number(cupoFin.vendido) === real,
    `${cupoFin.vendido} vs ${real}`,
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
