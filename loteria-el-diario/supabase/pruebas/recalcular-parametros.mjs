/**
 * Aplicar hacia atrás una comisión o un factor que se cambió tarde.
 *
 * EL CASO REAL QUE LO MOTIVA
 * --------------------------
 * V-058 ISABEL tenía 15% y se le subió al 20% un lunes a las 2:25 de la tarde.
 * Su venta de esa mañana conservaba el 15%, porque cada línea congela la
 * comisión que regía al registrarse. Eso es lo correcto por omisión, pero
 * cuando el trato se acordó por la mañana lo correcto es lo contrario.
 *
 * LO QUE HAY QUE DEMOSTRAR, EN ORDEN DE IMPORTANCIA
 * -------------------------------------------------
 *   · Que LA LIQUIDACIÓN CUADRE CON SUS PROPIAS LÍNEAS después de recalcular.
 *     Es lo que puede romperse en silencio: si la fila de `liquidacion` no se
 *     rehace, el informe dice una cifra y el detalle otra, y nadie lo nota
 *     hasta que alguien suma a mano.
 *
 *   · Que la FECHA se respete: lo anterior no se toca. Recalcular de más
 *     reescribiría semanas que ya estaban bien.
 *
 *   · Que el PREMIO se rehaga con el factor nuevo — premio = monto x factor, y
 *     dejarlo viejo descuadra la liquidación contra sus líneas.
 *
 *   · Que la captura por totales cambie SÓLO la comisión: su premio va en
 *     lempiras, no multiplicado, así que tocar el factor ahí sería inventar.
 *
 *   · Que la vista previa diga la verdad: lo que anuncia es lo que ocurre.
 *
 *   · Que un sorteo YA PAGADO se recalcule igual —así se pidió— y que se
 *     devuelva cuántos, porque es lo que deja papel sin cuadrar.
 *
 *     node supabase/pruebas/recalcular-parametros.mjs
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

/*
 * Fechas PASADAS, no futuras.
 *
 * El resto de pruebas usa 2031 para no chocar con la operación real, pero aquí
 * no sirve: `fn_recalcular_parametros` rechaza una fecha futura —casi siempre
 * es un dedazo en el año— y con 2031 fallaba todo por esa guarda, que estaba
 * haciendo bien su trabajo.
 *
 * Se usa un año muy anterior a los datos reales, que empiezan en 2026.
 */
const VIEJA = "2019-03-10";   // antes del corte: no se debe tocar
const NUEVA = "2019-03-11";   // desde aquí se recalcula
const NOMBRE = "ZZZ Recalculo";
const ANTES = { comision: 0.15, factor: 70 };
const AHORA = { comision: 0.2, factor: 80 };

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
  for (const F of [VIEJA, NUEVA]) {
    const { data: sorteos } = await sb.from("sorteo").select("id").eq("fecha", F);
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
  }
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
    for (const c of cs ?? []) {
      await sb.from("corte_detalle").delete().eq("corte_id", c.id);
      await sb.from("auditoria").delete().eq("entidad_id", c.id);
    }
    await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

/** La liquidación de un sorteo, y lo que suman sus propias líneas. */
const cuadre = async (vendedor, sorteoId) => {
  const { data: lq } = await sb
    .from("liquidacion")
    .select("venta, comision, premios, utilidad")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", vendedor)
    .maybeSingle();

  const { data: tks } = await sb
    .from("ticket")
    .select("id")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", vendedor)
    .is("anulado_en", null);

  const { data: ls } = (tks ?? []).length
    ? await sb
        .from("linea")
        .select("monto, comision_congelada, factor_congelado, gana, premio")
        .in("ticket_id", (tks ?? []).map((t) => t.id))
    : { data: [] };

  const { data: vts } = await sb
    .from("venta_total")
    .select("venta, premios, comision_congelada")
    .eq("sorteo_id", sorteoId)
    .eq("vendedor_id", vendedor)
    .is("anulado_en", null);

  const suma = {
    venta:
      (ls ?? []).reduce((a, l) => a + Number(l.monto), 0) +
      (vts ?? []).reduce((a, v) => a + Number(v.venta), 0),
    comision:
      (ls ?? []).reduce((a, l) => a + Number(l.monto) * Number(l.comision_congelada), 0) +
      (vts ?? []).reduce((a, v) => a + Number(v.venta) * Number(v.comision_congelada), 0),
    premios:
      (ls ?? []).reduce((a, l) => a + Number(l.premio), 0) +
      (vts ?? []).reduce((a, v) => a + Number(v.premios), 0),
  };

  return { lq, lineas: ls ?? [], suma };
};

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
    p_comision: ANTES.comision,
    p_factor_pago: ANTES.factor,
    p_tope_por_numero: 500000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedor = alta[0].vendedor_id;

  const { data: admin } = await sb
    .from("usuario")
    .select("id")
    .eq("rol", "administrador")
    .limit(1)
    .single();

  const GANADOR = 33;
  const sorteoDe = async (fecha, indice) => {
    await sb.rpc("fn_programar_dia", { p_fecha: fecha });
    const { data } = await sb
      .from("sorteo")
      .select("id, hora")
      .eq("fecha", fecha)
      .order("hora");
    return data[indice];
  };

  // Un día ANTES del corte, que no se debe tocar.
  const sVieja = await sorteoDe(VIEJA, 0);
  await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: sVieja.id, p_limite_por_numero: 500000 });
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sVieja.id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: GANADOR, monto: 100 }, { numero: 7, monto: 900 }]],
    p_forzar: true,
  });

  // Y dos del día que SÍ se recalcula: uno con números, otro por totales.
  const sNueva = await sorteoDe(NUEVA, 0);
  const sTotales = await sorteoDe(NUEVA, 1);
  for (const s of [sNueva, sTotales]) {
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 500000 });
  }
  await sb.rpc("fn_registrar_tanda", {
    p_sorteo_id: sNueva.id,
    p_vendedor_id: vendedor,
    p_tickets: [[{ numero: GANADOR, monto: 200 }, { numero: 7, monto: 800 }]],
    p_forzar: true,
  });
  await sb.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sTotales.id,
    p_vendedor_id: vendedor,
    p_venta: 500,
    p_premios: 350,
    p_nota: "hoja de papel",
    p_usuario_id: admin.id,
  });

  for (const s of [sVieja, sNueva, sTotales]) {
    await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
    await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: GANADOR });
  }

  // --- Cómo está antes --------------------------------------------------------
  console.log("--- Antes de recalcular ---");
  const antesNueva = await cuadre(vendedor, sNueva.id);
  check("la comisión congelada es la vieja",
        antesNueva.lineas.every((l) => Number(l.comision_congelada) === ANTES.comision),
        JSON.stringify(antesNueva.lineas.map((l) => l.comision_congelada)));
  check("el premio se pagó al factor viejo: 200 × 70",
        Number(antesNueva.lq.premios) === 200 * ANTES.factor,
        String(antesNueva.lq.premios));

  // --- La vista previa --------------------------------------------------------
  console.log("\n--- La vista previa ---");
  const { data: imp, error: eImp } = await sb.rpc("fn_impacto_recalculo", {
    p_vendedor_id: vendedor,
    p_desde: NUEVA,
    p_comision: AHORA.comision,
    p_factor_pago: AHORA.factor,
  });
  check("la vista previa responde", !eImp, eImp?.message ?? "");
  const i = imp?.[0];
  check("cuenta los dos sorteos del día nuevo", i?.r_sorteos === 2, String(i?.r_sorteos));
  check("y NO el anterior al corte", i?.r_desde_real === NUEVA, String(i?.r_desde_real));
  check("ninguno está pagado todavía", i?.r_pagados === 0, String(i?.r_pagados));
  // 1000 con números + 500 de captura = 1500. Al 15% = 225; al 20% = 300.
  check("dice la comisión de ahora", Number(i?.r_comision_antes) === 225,
        String(i?.r_comision_antes));
  check("y la que quedaría", Number(i?.r_comision_ahora) === 300,
        String(i?.r_comision_ahora));

  // --- Recalcular -------------------------------------------------------------
  console.log("\n--- Recalculando desde el día nuevo ---");
  const { data: r, error: eR } = await sb.rpc("fn_recalcular_parametros", {
    p_vendedor_id: vendedor,
    p_desde: NUEVA,
    p_comision: AHORA.comision,
    p_factor_pago: AHORA.factor,
    p_usuario_id: admin.id,
  });
  check("el recálculo no da error", !eR, eR?.message ?? "");
  check("reescribió las dos líneas", r?.[0]?.r_lineas === 2, String(r?.[0]?.r_lineas));
  check("y la captura por totales", r?.[0]?.r_capturas === 1, String(r?.[0]?.r_capturas));
  check("rehizo los dos sorteos", r?.[0]?.r_sorteos === 2, String(r?.[0]?.r_sorteos));

  // --- LO QUE MÁS IMPORTA: que la liquidación cuadre con sus líneas -----------
  console.log("\n--- La liquidación cuadra con sus propias líneas ---");
  const trasNueva = await cuadre(vendedor, sNueva.id);
  check(
    "venta",
    Math.abs(Number(trasNueva.lq.venta) - trasNueva.suma.venta) < 0.01,
    `${trasNueva.lq.venta} vs ${trasNueva.suma.venta}`,
  );
  check(
    "COMISIÓN",
    Math.abs(Number(trasNueva.lq.comision) - trasNueva.suma.comision) < 0.01,
    `${trasNueva.lq.comision} vs ${trasNueva.suma.comision}`,
  );
  check(
    "PREMIOS",
    Math.abs(Number(trasNueva.lq.premios) - trasNueva.suma.premios) < 0.01,
    `${trasNueva.lq.premios} vs ${trasNueva.suma.premios}`,
  );
  check(
    "y la utilidad es venta − comisión − premios",
    Math.abs(
      Number(trasNueva.lq.utilidad) -
        (Number(trasNueva.lq.venta) - Number(trasNueva.lq.comision) - Number(trasNueva.lq.premios)),
    ) < 0.01,
    String(trasNueva.lq.utilidad),
  );

  console.log("\n--- Las cifras nuevas ---");
  check("la comisión congelada es la nueva",
        trasNueva.lineas.every((l) => Number(l.comision_congelada) === AHORA.comision),
        JSON.stringify(trasNueva.lineas.map((l) => l.comision_congelada)));
  check("EL PREMIO SE REHIZO con el factor nuevo: 200 × 80",
        Number(trasNueva.lq.premios) === 200 * AHORA.factor,
        String(trasNueva.lq.premios));
  check("la comisión del sorteo con números: 1000 × 20%",
        Number(trasNueva.lq.comision) === 200,
        String(trasNueva.lq.comision));

  // La captura: sólo la comisión.
  const { data: vt } = await sb
    .from("venta_total")
    .select("comision_congelada, premios")
    .eq("sorteo_id", sTotales.id)
    .eq("vendedor_id", vendedor)
    .single();
  check("la captura cambia su comisión", Number(vt.comision_congelada) === AHORA.comision,
        String(vt.comision_congelada));
  check("pero su premio NO se toca: va en lempiras, no multiplicado",
        Number(vt.premios) === 350, String(vt.premios));

  // --- Lo anterior a la fecha no se tocó --------------------------------------
  console.log("\n--- Lo anterior al corte sigue intacto ---");
  const trasVieja = await cuadre(vendedor, sVieja.id);
  check("conserva la comisión vieja",
        trasVieja.lineas.every((l) => Number(l.comision_congelada) === ANTES.comision),
        JSON.stringify(trasVieja.lineas.map((l) => l.comision_congelada)));
  check("y el premio al factor viejo: 100 × 70",
        Number(trasVieja.lq.premios) === 100 * ANTES.factor,
        String(trasVieja.lq.premios));

  // --- Un sorteo ya pagado ----------------------------------------------------
  console.log("\n--- Un sorteo que ya se pagó en un corte ---");
  const { data: liqNueva } = await sb
    .from("liquidacion")
    .select("id")
    .eq("sorteo_id", sNueva.id)
    .eq("vendedor_id", vendedor)
    .single();

  const { error: eCorte } = await sb.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedor,
    p_liquidacion_ids: [liqNueva.id],
    p_desde: NUEVA,
    p_hasta: NUEVA,
    p_nota: "prueba",
    p_usuario_id: admin.id,
  });

  if (eCorte) {
    console.log(`  (se omite: ${eCorte.message})`);
  } else {
    const { data: imp2 } = await sb.rpc("fn_impacto_recalculo", {
      p_vendedor_id: vendedor,
      p_desde: NUEVA,
      p_comision: 0.25,
      p_factor_pago: AHORA.factor,
    });
    check("LA VISTA PREVIA AVISA de que hay uno pagado",
          imp2?.[0]?.r_pagados === 1, String(imp2?.[0]?.r_pagados));

    const { data: r2, error: eR2 } = await sb.rpc("fn_recalcular_parametros", {
      p_vendedor_id: vendedor,
      p_desde: NUEVA,
      p_comision: 0.25,
      p_factor_pago: AHORA.factor,
      p_usuario_id: admin.id,
    });
    check("se recalcula igual, como se pidió", !eR2, eR2?.message ?? "");
    check("y DICE cuántos estaban pagados", r2?.[0]?.r_pagados === 1,
          String(r2?.[0]?.r_pagados));

    const pagada = await cuadre(vendedor, sNueva.id);
    check("la liquidación del pagado también se rehízo: 1000 × 25%",
          Number(pagada.lq.comision) === 250, String(pagada.lq.comision));
    check("y sigue cuadrando con sus líneas",
          Math.abs(Number(pagada.lq.comision) - pagada.suma.comision) < 0.01,
          `${pagada.lq.comision} vs ${pagada.suma.comision}`);
  }

  // --- Rechazos ---------------------------------------------------------------
  console.log("\n--- Lo que no se acepta ---");
  const { error: eFuturo } = await sb.rpc("fn_recalcular_parametros", {
    p_vendedor_id: vendedor,
    p_desde: "2099-01-01",
    p_comision: 0.2,
    p_factor_pago: 70,
    p_usuario_id: admin.id,
  });
  check("una fecha futura se rechaza", !!eFuturo, eFuturo ? "" : "no dio error");

  const { error: eAlta2 } = await sb.rpc("fn_recalcular_parametros", {
    p_vendedor_id: vendedor,
    p_desde: NUEVA,
    p_comision: 0.9,
    p_factor_pago: 70,
    p_usuario_id: admin.id,
  });
  check("una comisión del 90% se rechaza", !!eAlta2, eAlta2 ? "" : "no dio error");

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
