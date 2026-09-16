/**
 * El vendedor corrige lo suyo, y sólo mientras el sorteo siga abierto.
 *
 * QUÉ ESTÁ EN JUEGO
 * -----------------
 * Hasta ahora una venta mal registrada sólo se podía ANULAR desde el panel del
 * vendedor: el ticket entero desaparecía y había que volver a teclear las doce
 * líneas para arreglar una. Corregir llena ese hueco.
 *
 * Pero corregir es una puerta peligrosa, y por dos sitios distintos:
 *
 *   1. DESPUÉS DEL CIERRE. Corregir sabiendo el número ganador convierte «me
 *      equivoqué» en «esta apuesta ya sé que perdió». `fn_editar_venta` NO
 *      mira el estado del sorteo —a propósito, porque administración corrige
 *      auditando, cuando el día ya terminó— así que para el vendedor el límite
 *      lo pone la Server Action. Esta prueba comprueba la regla contra la base,
 *      que es donde se puede comprobar de verdad.
 *
 *   2. EL TOPE. Si corregir no volviera a comprobar el límite por número,
 *      cualquiera podría vender poco y luego «corregir» hacia arriba. La base
 *      sí lo comprueba, y aquí se verifica que siga haciéndolo.
 *
 * Y una tercera cosa que no es peligro sino contabilidad: el CUPO tiene que
 * quedar cuadrado. Se devuelve lo viejo y se consume lo nuevo; si esa cuenta
 * se desajusta, el error no se ve hasta que alguien no puede vender un número
 * que sí tenía sitio.
 *
 *     node supabase/pruebas/vendedor-corrige.mjs
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

// Fecha lejana: la prueba monta su propio día y lo limpia al final.
const FECHA = "2094-04-04";

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

const limpiar = async () => {
  const { data: ss } = await sb.from("sorteo").select("id").eq("fecha", FECHA);
  for (const s of ss ?? []) {
    await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
    const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
    for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
    await sb.from("ticket").delete().eq("sorteo_id", s.id);
    await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
    await sb.from("venta_total").delete().eq("sorteo_id", s.id);
    await sb.from("sorteo").delete().eq("id", s.id);
  }
};

try {
  await limpiar();

  // --- Montaje -------------------------------------------------------------
  console.log("1. Montaje");
  await sb.rpc("fn_programar_dia", { p_fecha: FECHA });
  const { data: sorteos } = await sb.from("sorteo").select("id, hora").eq("fecha", FECHA);

  // Dos sorteos: uno se queda abierto y el otro se cierra. La regla que se
  // prueba es justo la diferencia entre los dos.
  const ordenados = [...(sorteos ?? [])].sort((a, b) => (a.hora < b.hora ? -1 : 1));
  const abierto = ordenados[0];
  const cerrado = ordenados[ordenados.length - 1];

  for (const s of [abierto, cerrado])
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 5000 });

  const { data: vend } = await sb
    .from("vendedor")
    .select("id, codigo, parametro_vendedor!inner(tope_por_numero, vigente_hasta)")
    .eq("activo", true)
    .is("eliminado_en", null)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo")
    .limit(1);

  const v = vend?.[0];
  if (!v) {
    console.error("No hay vendedor activo con parámetros vigentes.");
    process.exit(1);
  }
  const par = Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor;
  const TOPE = num(par.tope_por_numero);
  console.log(`   vendedor ${v.codigo} · tope por número ${TOPE}`);

  const vender = async (sorteoId, lineas) => {
    const { data, error } = await sb.rpc("fn_registrar_ticket", {
      p_sorteo_id: sorteoId,
      p_vendedor_id: v.id,
      p_lineas: lineas,
      p_usuario_id: admin.id,
    });
    if (error) throw new Error(`vender: ${error.message}`);
    return data?.[0];
  };

  const t1 = await vender(abierto.id, [
    { numero: 7, monto: 100 },
    { numero: 42, monto: 250 },
  ]);
  const { data: fila1 } = await sb
    .from("ticket")
    .select("id, folio, total")
    .eq("folio", t1.ticket_folio)
    .single();

  check("se registró la venta de prueba", Boolean(fila1?.id), t1?.ticket_folio);

  const cupoDe = async (sorteoId, numero) => {
    const { data } = await sb
      .from("cupo_numero")
      .select("vendido")
      .eq("sorteo_id", sorteoId)
      .eq("numero", numero)
      .maybeSingle();
    return num(data?.vendido);
  };

  const cupo7Antes = await cupoDe(abierto.id, 7);
  const cupo42Antes = await cupoDe(abierto.id, 42);

  // --- La jugada llega al historial ---------------------------------------
  console.log("\n2. El historial trae la jugada");
  const { data: mis, error: eMis } = await sb.rpc("fn_mis_tickets", {
    p_vendedor_id: v.id,
    p_fecha: FECHA,
    p_limite: 40,
  });

  if (eMis) {
    check("fn_mis_tickets responde", false, `${eMis.code}: ${eMis.message}`);
  } else {
    const f = (mis ?? []).find((x) => x.r_folio === t1.ticket_folio);
    check("el ticket aparece en su historial", Boolean(f), t1.ticket_folio);
    check(
      "y trae la jugada, que es lo que permite corregir sin otro viaje",
      typeof f?.r_jugada === "string" && f.r_jugada.length > 0,
      `r_jugada = ${JSON.stringify(f?.r_jugada)}`,
    );
    if (f?.r_jugada) {
      check(
        "la jugada dice los números y los montos que se vendieron",
        f.r_jugada.includes("07:100") && f.r_jugada.includes("42:250"),
        f.r_jugada,
      );
      check(
        "en el mismo formato que el resto del sistema, sin decimales de más",
        !/\.00/.test(f.r_jugada),
        f.r_jugada,
      );
    }
    check(
      "el historial trae el estado del sorteo, que es lo que decide si se puede corregir",
      f?.r_estado === "abierto",
      `${f?.r_estado}`,
    );
  }

  // --- Corregir con el sorteo abierto -------------------------------------
  console.log("\n3. Corregir con el sorteo abierto");
  const { data: corr, error: eCorr } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: fila1.id,
    p_lineas: [
      { numero: 7, monto: 300 },
      { numero: 55, monto: 50 },
    ],
    p_motivo: "prueba vendedor-corrige",
    p_usuario_id: admin.id,
  });

  check("la corrección se acepta", !eCorr, eCorr?.message ?? "");
  if (!eCorr) {
    check("devuelve el total nuevo", cerca(num(corr?.[0]?.r_total), 350), `${corr?.[0]?.r_total}`);
    check("y cuántas líneas quedaron", num(corr?.[0]?.r_lineas) === 2, `${corr?.[0]?.r_lineas}`);

    const { data: t } = await sb.from("ticket").select("folio, total").eq("id", fila1.id).single();
    check(
      "EL FOLIO NO CAMBIA: es la misma venta corregida, no otra",
      t.folio === fila1.folio,
      `${fila1.folio} -> ${t.folio}`,
    );
    check("el total del ticket se actualiza", cerca(num(t.total), 350), `${t.total}`);

    // El cupo: se devuelve lo viejo y se consume lo nuevo.
    check(
      "el 07 pasa de 100 a 300 en el cupo",
      cerca(await cupoDe(abierto.id, 7), cupo7Antes - 100 + 300),
      `${await cupoDe(abierto.id, 7)}`,
    );
    check(
      "el 42 devuelve su cupo, porque ya no está en la venta",
      cerca(await cupoDe(abierto.id, 42), cupo42Antes - 250),
      `${await cupoDe(abierto.id, 42)}`,
    );
    check("y el 55 lo consume, porque entró", (await cupoDe(abierto.id, 55)) >= 50, "");

    // La jugada del historial refleja lo corregido: es lo que se va a imprimir.
    const { data: mis2 } = await sb.rpc("fn_mis_tickets", {
      p_vendedor_id: v.id,
      p_fecha: FECHA,
      p_limite: 40,
    });
    const f2 = (mis2 ?? []).find((x) => x.r_folio === fila1.folio);
    check(
      "el historial ya muestra la jugada corregida",
      f2?.r_jugada?.includes("07:300") && f2?.r_jugada?.includes("55:50"),
      `${f2?.r_jugada}`,
    );
    check(
      "y el 42 desapareció de la jugada",
      !f2?.r_jugada?.includes("42:"),
      `${f2?.r_jugada}`,
    );
  }

  // --- La jugada anterior queda en la auditoría ---------------------------
  console.log("\n4. Queda constancia de lo que decía antes");
  const { data: aud } = await sb
    .from("auditoria")
    .select("accion, entidad, campo, valor_anterior, valor_nuevo, usuario_id")
    .eq("entidad_id", fila1.id)
    .order("ocurrido_en", { ascending: false })
    .limit(5);

  // La fila que guarda la jugada: `accion = 'editar'`, `campo = 'jugada'`.
  const edicion = (aud ?? []).find(
    (a) => /editar/i.test(a.accion ?? "") && a.campo === "jugada",
  );
  check("la corrección se auditó", Boolean(edicion), (aud ?? []).map((a) => a.accion).join(", "));
  if (edicion) {
    check(
      "guarda la jugada ANTERIOR, que es lo que decía la tirilla del cliente",
      /07:100/.test(edicion.valor_anterior ?? ""),
      `${edicion.valor_anterior}`,
    );
    check(
      "y la nueva",
      /07:300/.test(edicion.valor_nuevo ?? ""),
      `${edicion.valor_nuevo}`,
    );
    check("con el autor puesto", Boolean(edicion.usuario_id), `${edicion.usuario_id}`);
  }

  // --- El tope se vuelve a comprobar --------------------------------------
  console.log("\n5. Corregir no es la puerta para saltarse el tope");
  const { error: eTope } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: fila1.id,
    p_lineas: [{ numero: 7, monto: TOPE + 1000 }],
    p_motivo: "prueba de tope",
    p_usuario_id: admin.id,
  });
  check(
    "pasarse del tope por número se rechaza al corregir, igual que al vender",
    Boolean(eTope),
    eTope ? "" : "la dejó pasar",
  );

  const { data: intacto } = await sb
    .from("ticket")
    .select("total")
    .eq("id", fila1.id)
    .single();
  check(
    "y la venta se queda como estaba, no a medias",
    cerca(num(intacto.total), 350),
    `${intacto.total}`,
  );

  // --- Dejar la venta sin números no es corregir --------------------------
  console.log("\n6. Una venta corregida no puede quedar vacía");
  const { error: eVacia } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: fila1.id,
    p_lineas: [],
    p_motivo: "prueba vacía",
    p_usuario_id: admin.id,
  });
  check("se rechaza dejarla sin líneas: para eso está anular", Boolean(eVacia), "");

  // --- El límite del vendedor: sorteo cerrado -----------------------------
  console.log("\n7. Con el sorteo cerrado, el vendedor no corrige");

  const t2 = await vender(cerrado.id, [{ numero: 13, monto: 80 }]);
  const { data: fila2 } = await sb
    .from("ticket")
    .select("id, folio")
    .eq("folio", t2.ticket_folio)
    .single();

  await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: cerrado.id });
  const { data: estadoCerrado } = await sb
    .from("sorteo")
    .select("estado")
    .eq("id", cerrado.id)
    .single();
  check("el sorteo quedó cerrado", estadoCerrado.estado !== "abierto", estadoCerrado.estado);

  /*
   * La comprobación clave, y hay que leerla con cuidado: `fn_editar_venta`
   * ACEPTA esto, porque administración tiene que poder corregir un sorteo
   * cerrado. Lo que la prueba fija es que el historial del vendedor diga
   * `estado <> 'abierto'`, que es el dato con el que la Server Action —y la
   * pantalla— cierran esa puerta. Si un día `fn_mis_tickets` dejara de traer
   * el estado, esto lo delata antes de que un vendedor pueda corregir una
   * apuesta conociendo el resultado.
   */
  const { data: mis3 } = await sb.rpc("fn_mis_tickets", {
    p_vendedor_id: v.id,
    p_fecha: FECHA,
    p_limite: 40,
  });
  const f3 = (mis3 ?? []).find((x) => x.r_folio === fila2.folio);
  check(
    "el historial marca ese ticket como de sorteo NO abierto",
    Boolean(f3) && f3.r_estado !== "abierto",
    `${f3?.r_estado}`,
  );
  check(
    "y el del sorteo abierto sigue marcado como abierto",
    (mis3 ?? []).find((x) => x.r_folio === fila1.folio)?.r_estado === "abierto",
    "",
  );

  // --- Una venta anulada no se corrige ------------------------------------
  console.log("\n8. Una venta anulada no se corrige");
  await sb.rpc("fn_anular_ticket", {
    p_ticket_id: fila1.id,
    p_motivo: "prueba",
    p_usuario_id: admin.id,
    p_forzar: false,
  });
  const { error: eAnulada } = await sb.rpc("fn_editar_venta", {
    p_ticket_id: fila1.id,
    p_lineas: [{ numero: 7, monto: 100 }],
    p_motivo: "sobre anulada",
    p_usuario_id: admin.id,
  });
  check("corregir una venta anulada se rechaza", Boolean(eAnulada), "");
} finally {
  console.log("\n9. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
