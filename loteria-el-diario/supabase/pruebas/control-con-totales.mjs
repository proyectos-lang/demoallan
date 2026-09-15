/**
 * El tablero de control tiene que contar TODA la venta, no sólo la del portal.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * Se registra una captura por totales de 777 para un vendedor en el sorteo de
 * la noche —todavía sin liquidar— y el tablero sigue mostrando 200: sólo su
 * ticket. La captura no aparece en VENTA, ni en la fila del vendedor, ni en la
 * barra del día.
 *
 * La causa no era la que parecía. `fn_control_vendedores` lee los importes de
 * `liquidacion`, que SÍ incluye las capturas desde la 0048; por eso un día ya
 * liquidado cuadra perfecto. El agujero estaba en el otro brazo de la función
 * —el de los sorteos sin liquidar—, que baja a `ticket` y `linea`. Una captura
 * por totales no es un ticket: no tiene líneas ni números. Así que la venta
 * del día en curso, que es justo la que se mira en un tablero de control,
 * salía incompleta hasta que el sorteo se liquidaba.
 *
 * QUÉ SE COMPRUEBA
 * ----------------
 *   · Que una captura sobre un sorteo SIN liquidar aparezca en la venta.
 *   · Que entre en `pendiente` y no en premios ni en utilidad: mientras no haya
 *     número ganador, sumarla ahí sería proyección, y la nota al pie del
 *     tablero afirma justo lo contrario.
 *   · Que la barra del día también la cuente: un día vendido entero por
 *     totales no puede dibujarse como un hueco.
 *   · Que los CONTEOS no se inventen tickets que nadie podría abrir.
 *   · Que lo ya liquidado siga cuadrando exactamente igual que antes, que es
 *     la parte que hoy funciona y no se puede romper.
 *   · Que anular la captura devuelva las cifras a su sitio.
 *
 *     node supabase/pruebas/control-con-totales.mjs
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
const cerca = (a, b, t = 0.02) => Math.abs(a - b) <= t;

const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Tegucigalpa" });

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

// ---------------------------------------------------------------------------
// 1. Un sorteo SIN liquidar, que es donde estaba el agujero.
// ---------------------------------------------------------------------------
const { data: sorteos } = await sb
  .from("sorteo")
  .select("id, fecha, hora, estado")
  .eq("fecha", hoy)
  .order("hora");

const abierto = (sorteos ?? []).find((s) => s.estado !== "liquidado");
if (!abierto) {
  console.error(`No hay ningún sorteo sin liquidar el ${hoy}; la prueba necesita uno.`);
  process.exit(1);
}

// Un vendedor activo que NO tenga ya una captura viva en ese sorteo: la tabla
// sólo admite una por sorteo y vendedor.
const { data: yaCapturados } = await sb
  .from("venta_total")
  .select("vendedor_id")
  .eq("sorteo_id", abierto.id)
  .is("anulado_en", null);
const ocupados = new Set((yaCapturados ?? []).map((r) => r.vendedor_id));

const { data: candidatos } = await sb
  .from("vendedor")
  .select("id, codigo, alias, nombre")
  .eq("activo", true)
  .is("eliminado_en", null)
  .order("codigo");

const v = (candidatos ?? []).find((c) => !ocupados.has(c.id));
if (!v) {
  console.error("Todos los vendedores activos ya tienen captura en ese sorteo.");
  process.exit(1);
}

console.log(
  `Sorteo ${abierto.hora} del ${hoy} (${abierto.estado}) · vendedor ${v.codigo} ${v.alias ?? v.nombre}\n`,
);

const control = () =>
  sb.rpc("fn_control_vendedores", {
    p_desde: hoy,
    p_hasta: hoy,
    p_vendedores: [v.id],
    p_hora: abierto.hora,
  });

const serie = () =>
  sb.rpc("fn_control_serie", {
    p_desde: hoy,
    p_hasta: hoy,
    p_vendedores: [v.id],
    p_hora: abierto.hora,
  });

const { data: antesCtrl, error: eCtrl } = await control();
if (eCtrl) {
  console.error("fn_control_vendedores no respondió:", eCtrl.message);
  process.exit(1);
}
const a0 = antesCtrl?.[0] ?? {};
const { data: antesSerie } = await serie();
const s0 = num(antesSerie?.[0]?.r_venta);

const MONTO = 777;

const { error: eReg } = await sb.rpc("fn_registrar_venta_total", {
  p_sorteo_id: abierto.id,
  p_vendedor_id: v.id,
  p_venta: MONTO,
  p_premios: 0,
  p_nota: "prueba control-con-totales",
  p_usuario_id: admin.id,
});

let capturaId = null;
try {
  if (eReg) {
    check("se pudo registrar la captura de prueba", false, eReg.message);
  } else {
    const { data: creada } = await sb
      .from("venta_total")
      .select("id")
      .eq("sorteo_id", abierto.id)
      .eq("vendedor_id", v.id)
      .is("anulado_en", null)
      .maybeSingle();
    capturaId = creada?.id ?? null;
    check("se registró la captura de prueba", Boolean(capturaId));

    console.log("\n--- Sorteo sin liquidar ---");
    const { data: dCtrl } = await control();
    const a1 = dCtrl?.[0] ?? {};

    check(
      "la venta del tablero sube con la captura",
      cerca(num(a1.r_venta), num(a0.r_venta) + MONTO),
      `${num(a0.r_venta)} -> ${num(a1.r_venta)}, esperado ${num(a0.r_venta) + MONTO}`,
    );
    check(
      "la captura entra en lo pendiente, no en lo liquidado",
      cerca(num(a1.r_pendiente), num(a0.r_pendiente) + MONTO),
      `${num(a0.r_pendiente)} -> ${num(a1.r_pendiente)}`,
    );
    check(
      "no toca los premios: el sorteo aún no tiene número ganador",
      cerca(num(a1.r_premios), num(a0.r_premios)),
      `${num(a0.r_premios)} -> ${num(a1.r_premios)}`,
    );
    check(
      "no toca la utilidad, que sería una proyección",
      cerca(num(a1.r_utilidad), num(a0.r_utilidad)),
      `${num(a0.r_utilidad)} -> ${num(a1.r_utilidad)}`,
    );
    check(
      "no inventa un ticket que nadie podría abrir",
      num(a1.r_tickets) === num(a0.r_tickets),
      `${num(a0.r_tickets)} -> ${num(a1.r_tickets)}`,
    );
    check(
      "ni una línea",
      num(a1.r_lineas) === num(a0.r_lineas),
      `${num(a0.r_lineas)} -> ${num(a1.r_lineas)}`,
    );

    const { data: dSerie } = await serie();
    check(
      "la barra del día también la cuenta",
      cerca(num(dSerie?.[0]?.r_venta), s0 + MONTO),
      `${s0} -> ${num(dSerie?.[0]?.r_venta)}`,
    );
    check(
      "y la barra no se duplica por cada línea de ticket",
      num(dSerie?.[0]?.r_venta) <= s0 + MONTO + 0.02,
      `${num(dSerie?.[0]?.r_venta)} contra un tope de ${s0 + MONTO}`,
    );

    const { data: cap } = await sb.rpc("fn_control_capturado", {
      p_desde: hoy,
      p_hasta: hoy,
      p_vendedores: [v.id],
      p_hora: abierto.hora,
    });
    check(
      "el tablero puede decir qué parte se capturó por totales",
      cerca(num(cap), MONTO),
      `${num(cap)} contra ${MONTO}`,
    );
  }
} finally {
  if (capturaId) {
    const { error } = await sb.rpc("fn_anular_venta_total", {
      p_id: capturaId,
      p_usuario_id: admin.id,
    });
    if (error) console.log(`  AVISO: no se pudo limpiar la captura ${capturaId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Al anular, todo vuelve a su sitio.
// ---------------------------------------------------------------------------
if (capturaId) {
  console.log("\n--- Al anular la captura ---");
  const { data: fCtrl } = await control();
  const a2 = fCtrl?.[0] ?? {};
  check(
    "la venta vuelve a lo que era",
    cerca(num(a2.r_venta), num(a0.r_venta)),
    `${num(a2.r_venta)} contra ${num(a0.r_venta)}`,
  );
  check(
    "y lo pendiente también",
    cerca(num(a2.r_pendiente), num(a0.r_pendiente)),
    `${num(a2.r_pendiente)} contra ${num(a0.r_pendiente)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Lo ya liquidado no se puede romper: V-011 el 07/09 es el caso conocido.
// ---------------------------------------------------------------------------
console.log("\n--- Lo ya liquidado sigue cuadrando ---");

const { data: v11 } = await sb
  .from("vendedor")
  .select("id, codigo")
  .eq("codigo", "V-011")
  .maybeSingle();

if (v11) {
  const { data: caps } = await sb
    .from("venta_total")
    .select("venta, premios, sorteo:sorteo_id(fecha, estado)")
    .eq("vendedor_id", v11.id)
    .is("anulado_en", null);

  const delDia = (caps ?? []).filter(
    (c) => c.sorteo?.fecha === "2026-09-07" && c.sorteo?.estado === "liquidado",
  );

  if (delDia.length) {
    const sumaCap = delDia.reduce((a, c) => a + num(c.venta), 0);
    const { data: ctrl11 } = await sb.rpc("fn_control_vendedores", {
      p_desde: "2026-09-07",
      p_hasta: "2026-09-07",
      p_vendedores: [v11.id],
      p_hora: null,
    });
    const f = ctrl11?.[0] ?? {};

    // Sus tickets de ese día, para poder sumar las dos fuentes a mano.
    const { data: sorDia } = await sb.from("sorteo").select("id").eq("fecha", "2026-09-07");
    const ids = (sorDia ?? []).map((s) => s.id);
    const { data: tks } = await sb
      .from("ticket")
      .select("id")
      .eq("vendedor_id", v11.id)
      .is("anulado_en", null)
      .in("sorteo_id", ids);
    let ventaTickets = 0;
    for (const t of tks ?? []) {
      const { data: ls } = await sb.from("linea").select("monto").eq("ticket_id", t.id);
      ventaTickets += (ls ?? []).reduce((a, l) => a + num(l.monto), 0);
    }

    check(
      "la venta liquidada es capturas + tickets, sin contar nada dos veces",
      cerca(num(f.r_venta), sumaCap + ventaTickets, 1),
      `tablero ${num(f.r_venta)} · capturas ${sumaCap} + tickets ${ventaTickets}`,
    );
    check(
      "un día ya liquidado no deja nada pendiente",
      cerca(num(f.r_pendiente), 0),
      `${num(f.r_pendiente)}`,
    );
    check(
      "y sus premios siguen saliendo de la liquidación",
      num(f.r_premios) > 0,
      `${num(f.r_premios)}`,
    );

    const { data: serie11 } = await sb.rpc("fn_control_serie", {
      p_desde: "2026-09-07",
      p_hasta: "2026-09-07",
      p_vendedores: [v11.id],
      p_hora: null,
    });
    check(
      "la barra del día coincide con la venta del tablero",
      cerca(num(serie11?.[0]?.r_venta), num(f.r_venta), 1),
      `barra ${num(serie11?.[0]?.r_venta)} contra tablero ${num(f.r_venta)}`,
    );
  } else {
    console.log("  (V-011 ya no tiene capturas vivas el 07/09; se omite este bloque)");
  }
}

// ---------------------------------------------------------------------------
// 4. Sin filtro de vendedor, el total del padrón tampoco puede perder venta.
// ---------------------------------------------------------------------------
console.log("\n--- Todo el padrón ---");

const { data: todos } = await sb.rpc("fn_control_vendedores", {
  p_desde: "2026-09-07",
  p_hasta: "2026-09-07",
  p_vendedores: null,
  p_hora: null,
});
const ventaTodos = (todos ?? []).reduce((a, r) => a + num(r.r_venta), 0);

const { data: capTodos } = await sb.rpc("fn_control_capturado", {
  p_desde: "2026-09-07",
  p_hasta: "2026-09-07",
  p_vendedores: null,
  p_hora: null,
});

check(
  "el padrón entero responde sin error",
  Array.isArray(todos) && todos.length > 0,
  `${todos?.length ?? 0} filas`,
);
check(
  "y la venta del día es al menos lo capturado por totales",
  ventaTodos >= num(capTodos) - 1,
  `venta ${ventaTodos} contra capturado ${num(capTodos)}`,
);

const { data: serieTodos } = await sb.rpc("fn_control_serie", {
  p_desde: "2026-09-07",
  p_hasta: "2026-09-07",
  p_vendedores: null,
  p_hora: null,
});
check(
  "la barra del día cuadra con la suma por vendedor",
  cerca(num(serieTodos?.[0]?.r_venta), ventaTodos, 2),
  `barra ${num(serieTodos?.[0]?.r_venta)} contra ${ventaTodos}`,
);

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
