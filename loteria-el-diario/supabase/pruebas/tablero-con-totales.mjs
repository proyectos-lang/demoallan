/**
 * El tablero del día tiene que contar toda la venta, no sólo la del portal.
 *
 * CÓMO APARECIÓ
 * -------------
 * Corregido el tablero de control (0088-0091), se revisó una por una el resto
 * de funciones que informan de venta: se registraba una captura por totales y
 * se miraba cuál se movía. La mayoría ya la veían —`fn_resumen_periodo`,
 * `fn_resumen_mensual`, `fn_reporte_totales` e `fn_informe_gerencia` leen de
 * `liquidacion`, donde la captura entra desde la 0048—. Dos no.
 *
 * Para el 07/09/2026 el tablero decía 27.185 de venta cuando ese día se
 * vendieron 156.805. Seis de cada siete lempiras faltaban de la pantalla que
 * se abre al entrar, y de ahí salen sus cuatro cifras de cabecera.
 *
 * La causa es la vista `v_agregado_sorteo_vendedor`, cuyo comentario de la
 * 0008 dice «ningún total se captura a mano». Era cierto hasta que la 0047
 * introdujo justamente eso.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que la venta del día cuadre con `liquidacion`, que es la cuenta buena.
 *   · Que una captura nueva sobre un sorteo abierto se vea en el acto.
 *   · Que sume a la comisión, porque la captura congela su tasa al registrarse.
 *   · Que NO sume a los premios mientras el sorteo siga abierto: el premio de
 *     una captura se paga cuando el sorteo cierra, igual que en la liquidación.
 *   · Que no invente tickets, que es lo que haría creer que hay algo que abrir.
 *   · Que el desglose por vendedor no pierda a quien sólo vendió por totales.
 *   · Que a quien tiene las dos cosas le salga UNA fila con la suma, no dos.
 *   · Que el desglose cuadre con el resumen: son la misma pantalla.
 *
 *     node supabase/pruebas/tablero-con-totales.mjs
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

const num = (x) => Number(x ?? 0);
const cerca = (a, b, t = 1) => Math.abs(a - b) <= t;
const suma = (filas, campo) => (filas ?? []).reduce((a, r) => a + num(r[campo]), 0);

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

// ---------------------------------------------------------------------------
// 1. Un día ya liquidado, con capturas reales: la cuenta tiene que cuadrar.
// ---------------------------------------------------------------------------
console.log("--- Un día liquidado con capturas ---");

const F = "2026-09-07";
const { data: sorDia } = await sb.from("sorteo").select("id, hora, estado").eq("fecha", F);
const idsDia = (sorDia ?? []).map((s) => s.id);

const { data: lqDia } = await sb.from("liquidacion").select("venta").in("sorteo_id", idsDia);
const ventaReal = suma(lqDia, "venta");

const { data: capDia } = await sb
  .from("venta_total")
  .select("venta")
  .in("sorteo_id", idsDia)
  .is("anulado_en", null);
const capReal = suma(capDia, "venta");

console.log(`${F}: liquidacion ${ventaReal} · de ellos ${capReal} por totales`);

check(
  "el día elegido tiene capturas por totales, que es lo que lo hace una prueba",
  capReal > 0,
  `${capReal}`,
);

const { data: resDia } = await sb.rpc("fn_resumen_dia", { p_fecha: F });
check(
  "la venta del tablero cuadra con la liquidación del día",
  cerca(suma(resDia, "venta"), ventaReal, 2),
  `tablero ${suma(resDia, "venta")} contra ${ventaReal}`,
);

const { data: desDia } = await sb.rpc("fn_desglose_dia", { p_fecha: F });
check(
  "el desglose por vendedor suma lo mismo que el resumen",
  cerca(suma(desDia, "venta"), suma(resDia, "venta"), 2),
  `desglose ${suma(desDia, "venta")} contra resumen ${suma(resDia, "venta")}`,
);

// Quien sólo tuvo captura ese día tiene que aparecer en el desglose.
const { data: capPorVend } = await sb
  .from("venta_total")
  .select("vendedor_id, sorteo_id")
  .in("sorteo_id", idsDia)
  .is("anulado_en", null);

const conTicket = new Set();
const { data: tksDia } = await sb
  .from("ticket")
  .select("vendedor_id")
  .in("sorteo_id", idsDia)
  .is("anulado_en", null);
for (const t of tksDia ?? []) conTicket.add(t.vendedor_id);

const soloTotales = [...new Set((capPorVend ?? []).map((c) => c.vendedor_id))].filter(
  (id) => !conTicket.has(id),
);
const enDesglose = new Set((desDia ?? []).map((d) => d.vendedor_id));

check(
  "ese día hubo quien vendió sólo por totales, que es el caso que se perdía",
  soloTotales.length > 0,
  `${soloTotales.length} vendedores`,
);
check(
  "y el desglose no lo deja fuera",
  soloTotales.every((id) => enDesglose.has(id)),
  `${soloTotales.filter((id) => !enDesglose.has(id)).length} ausentes de ${soloTotales.length}`,
);

// Nadie puede salir dos veces por el mismo sorteo.
const vistos = new Map();
let duplicados = 0;
for (const d of desDia ?? []) {
  const k = `${d.vendedor_id}|${d.hora}`;
  if (vistos.has(k)) duplicados++;
  vistos.set(k, true);
}
check(
  "nadie sale dos veces en el mismo sorteo: las dos fuentes se suman en una fila",
  duplicados === 0,
  `${duplicados} filas repetidas`,
);

// ---------------------------------------------------------------------------
// 2. Una captura nueva sobre un sorteo abierto se ve en el acto.
// ---------------------------------------------------------------------------
console.log("\n--- Una captura nueva, sorteo abierto ---");

const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });
const { data: sorHoy } = await sb
  .from("sorteo")
  .select("id, hora, estado")
  .eq("fecha", hoy)
  .order("hora");
const abierto = (sorHoy ?? []).find((s) => s.estado !== "liquidado");

let capturaId = null;
if (!abierto) {
  console.log("  (no hay sorteo sin liquidar hoy; se omite este bloque)");
} else {
  const { data: ocupados } = await sb
    .from("venta_total")
    .select("vendedor_id")
    .eq("sorteo_id", abierto.id)
    .is("anulado_en", null);
  const tomados = new Set((ocupados ?? []).map((r) => r.vendedor_id));

  const { data: cands } = await sb
    .from("vendedor")
    .select("id, codigo, alias, nombre")
    .eq("activo", true)
    .is("eliminado_en", null)
    .order("codigo");
  const v = (cands ?? []).find((c) => !tomados.has(c.id));

  const antes = (await sb.rpc("fn_resumen_dia", { p_fecha: hoy })).data ?? [];
  const fAntes = antes.find((r) => r.hora === abierto.hora) ?? {};

  const MONTO = 3210;
  const PREMIO = 500;
  const { error: eReg } = await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: abierto.id,
    p_vendedor_id: v.id,
    p_venta: MONTO,
    p_premios: PREMIO,
    p_nota: "prueba tablero-con-totales",
    p_usuario_id: admin.id,
  });

  try {
    if (eReg) {
      check("se pudo registrar la captura de prueba", false, eReg.message);
    } else {
      const { data: creada } = await sb
        .from("venta_total")
        .select("id, comision_congelada")
        .eq("sorteo_id", abierto.id)
        .eq("vendedor_id", v.id)
        .is("anulado_en", null)
        .maybeSingle();
      capturaId = creada?.id ?? null;

      const despues = (await sb.rpc("fn_resumen_dia", { p_fecha: hoy })).data ?? [];
      const fDespues = despues.find((r) => r.hora === abierto.hora) ?? {};

      check(
        "la venta del sorteo sube con la captura",
        cerca(num(fDespues.venta), num(fAntes.venta) + MONTO, 0.02),
        `${num(fAntes.venta)} -> ${num(fDespues.venta)}, esperado ${num(fAntes.venta) + MONTO}`,
      );
      check(
        "la comisión sube con la tasa congelada de la captura",
        cerca(
          num(fDespues.comision),
          num(fAntes.comision) + MONTO * num(creada?.comision_congelada),
          0.05,
        ),
        `${num(fAntes.comision)} -> ${num(fDespues.comision)}`,
      );
      check(
        "los premios NO suben: el sorteo sigue abierto",
        cerca(num(fDespues.premios), num(fAntes.premios), 0.02),
        `${num(fAntes.premios)} -> ${num(fDespues.premios)}`,
      );
      check(
        "no inventa un ticket que nadie podría abrir",
        num(fDespues.tickets) === num(fAntes.tickets),
        `${num(fAntes.tickets)} -> ${num(fDespues.tickets)}`,
      );

      const desHoy = (await sb.rpc("fn_desglose_dia", { p_fecha: hoy })).data ?? [];
      const suyas = desHoy.filter((d) => d.vendedor_id === v.id && d.hora === abierto.hora);
      check(
        "el vendedor aparece en el desglose del sorteo",
        suyas.length === 1,
        `${suyas.length} filas para ${v.codigo}`,
      );
      if (suyas.length === 1)
        check(
          "y su venta incluye la captura",
          num(suyas[0].venta) >= MONTO - 0.02,
          `${num(suyas[0].venta)} contra al menos ${MONTO}`,
        );
    }
  } finally {
    if (capturaId) {
      const { error } = await sb.rpc("fn_anular_venta_total", {
        p_id: capturaId,
        p_usuario_id: admin.id,
      });
      if (error) console.log(`  AVISO: no se limpió la captura ${capturaId}: ${error.message}`);
    }
  }

  if (capturaId) {
    const vuelta = (await sb.rpc("fn_resumen_dia", { p_fecha: hoy })).data ?? [];
    const fVuelta = vuelta.find((r) => r.hora === abierto.hora) ?? {};
    check(
      "al anular, la venta vuelve a lo que era",
      cerca(num(fVuelta.venta), num(fAntes.venta), 0.02),
      `${num(fVuelta.venta)} contra ${num(fAntes.venta)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. La utilidad sigue siendo venta − comisión − premios, fila por fila.
// ---------------------------------------------------------------------------
console.log("\n--- La utilidad se sostiene ---");

let descuadres = 0;
for (const r of resDia ?? []) {
  const esperada = num(r.venta) - num(r.comision) - num(r.premios);
  if (!cerca(num(r.utilidad), esperada, 0.02)) descuadres++;
}
check(
  "cada sorteo cuadra: utilidad = venta − comisión − premios",
  descuadres === 0,
  `${descuadres} sorteos descuadrados`,
);

let descuadresD = 0;
for (const d of desDia ?? []) {
  const esperada = num(d.venta) - num(d.comision) - num(d.premios);
  if (!cerca(num(d.utilidad), esperada, 0.02)) descuadresD++;
}
check(
  "y cada fila del desglose también",
  descuadresD === 0,
  `${descuadresD} filas descuadradas`,
);

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
