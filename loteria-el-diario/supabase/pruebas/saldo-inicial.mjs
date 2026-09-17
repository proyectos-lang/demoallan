/**
 * Un vendedor puede entrar al sistema debiendo.
 *
 * QUÉ HUECO LLENA
 * ---------------
 * Los vendedores que se dan de alta no son negocios nuevos: llevan años
 * vendiendo y traen una cuenta abierta de la libreta anterior. El «saldo
 * anterior» de la liquidación se CALCULA sumando los sorteos viejos que no han
 * pagado, y uno recién creado no tiene ninguno: su arrastre es cero y no había
 * forma de decir que debe 4.500.
 *
 * LO QUE ESTA PRUEBA VIGILA DE VERDAD
 * -----------------------------------
 * Tres cosas, y las tres son maneras de perder dinero sin que nada falle:
 *
 *   1. QUE NO SE CUELE EN LA VENTA. La vía corta habría sido fabricar una
 *      `liquidacion` con ese saldo. Aquí se comprueba que la venta del informe
 *      NO se mueva al cargarlo: ese dinero no lo vendió nadie, y si entrara en
 *      `liquidacion` corrompería el tablero, el informe de gerencia y el
 *      control a la vez.
 *
 *   2. QUE SE PUEDA COBRAR. Un saldo visible que no hay forma de cerrar es
 *      peor que no tenerlo. `fn_saldar_arrastre` rechazaba a quien no tuviera
 *      sorteos viejos, que es exactamente el vendedor nuevo.
 *
 *   3. QUE REVERSAR EL CORTE LO DEVUELVA. La referencia es `on delete set
 *      null`, pero `saldado_en` no se limpia solo: sin cuidarlo, reversar un
 *      pago dejaría el saldo marcado como cobrado para siempre y el dinero se
 *      evaporaría en silencio.
 *
 *     node supabase/pruebas/saldo-inicial.mjs
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

const { data: admin } = await sb
  .from("usuario")
  .select("id")
  .eq("rol", "administrador")
  .limit(1)
  .single();

/*
 * La semana con la que se mira. El saldo se carga ANTES de ella para que entre
 * en su arrastre, igual que haria un sorteo viejo.
 *
 * FECHAS PASADAS, y lejanas hacia atras en vez de hacia adelante: la funcion
 * rechaza una apertura futura —casi siempre es un dedazo en el año— asi que
 * las fechas de 2091 que usan otras pruebas aqui no valen. Se eligen unas de
 * 2019, anteriores a cualquier sorteo real del sistema, para que el arrastre
 * que mida esta prueba sea solo el suyo.
 */
const SEMANA = "2019-03-04";
const FIN = "2019-03-10";
const APERTURA = "2019-03-01";
const MONTO = 4500;

/** El vendedor de prueba: se crea y se borra aquí. */
const CODIGO = "V-989";
let vendedorId = null;

const limpiar = async () => {
  const { data: v } = await sb
    .from("vendedor")
    .select("id")
    .eq("codigo", CODIGO)
    .maybeSingle();
  if (!v) return;
  // Los cortes que la prueba haya creado, y sus saldos.
  await sb.from("saldo_inicial").delete().eq("vendedor_id", v.id);
  const { data: cs } = await sb.from("corte_vendedor").select("id").eq("vendedor_id", v.id);
  for (const c of cs ?? []) await sb.from("corte_detalle").delete().eq("corte_id", c.id);
  await sb.from("corte_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("abono_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
  await sb.from("vendedor").delete().eq("id", v.id);
};

try {
  await limpiar();

  // --- Un vendedor nuevo, sin una sola venta -------------------------------
  console.log("1. Un vendedor recién creado");

  const { data: nuevo, error: eNuevo } = await sb
    .from("vendedor")
    .insert({
      codigo: CODIGO,
      nombre: "PRUEBA SALDO INICIAL",
      ciudad: "Choloma",
      zona: "prueba",
      color: "#4f46e5",
      activo: true,
    })
    .select("id")
    .single();

  if (eNuevo) {
    console.error("No se pudo crear el vendedor de prueba:", eNuevo.message);
    process.exit(1);
  }
  vendedorId = nuevo.id;

  await sb.from("parametro_vendedor").insert({
    vendedor_id: vendedorId,
    comision: 0.15,
    factor_pago: 70,
    tope_por_numero: 300,
  });

  const saldosDe = async () => {
    const { data } = await sb.rpc("fn_saldos_por_vendedor", {
      p_desde: SEMANA,
      p_hasta: FIN,
    });
    return (data ?? []).find((f) => f.r_vendedor_id === vendedorId);
  };

  const antes = await saldosDe();
  check(
    "sin ventas ni saldo, arrastra cero",
    !antes || num(antes.r_anterior) === 0,
    `${num(antes?.r_anterior)}`,
  );

  // --- Se le carga lo que traía de la libreta ------------------------------
  console.log("\n2. Se carga el saldo de apertura");

  const { data: cargado, error: eCargar } = await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vendedorId,
    p_monto: MONTO,
    p_vigente_desde: APERTURA,
    p_nota: "prueba saldo-inicial",
    p_usuario_id: admin.id,
  });

  check("el saldo se carga", !eCargar, eCargar ? `${eCargar.code}: ${eCargar.message}` : "");
  if (eCargar) throw new Error("sin saldo cargado no hay nada más que probar");

  const saldoId = cargado?.[0]?.r_id;
  check("devuelve el monto", cerca(num(cargado?.[0]?.r_monto), MONTO), `${cargado?.[0]?.r_monto}`);

  const conSaldo = await saldosDe();
  check(
    "AHORA APARECE EN EL ARRASTRE: es lo que se pidió",
    cerca(num(conSaldo?.r_anterior), MONTO),
    `${num(conSaldo?.r_anterior)} contra ${MONTO}`,
  );
  check(
    "y en el saldo actual, que es lo que se sale a cobrar",
    cerca(num(conSaldo?.r_actual), MONTO),
    `${num(conSaldo?.r_actual)}`,
  );
  check(
    "el vendedor SALE en la lista aunque no tenga ventas",
    Boolean(conSaldo),
    "desapareció justo de la pantalla donde hay que cobrarle",
  );

  // --- Lo que NO puede pasar ----------------------------------------------
  console.log("\n3. No se cuela en las cifras de venta");

  check(
    "la venta de la semana sigue en cero",
    cerca(num(conSaldo?.r_venta), 0),
    `${num(conSaldo?.r_venta)}`,
  );
  check(
    "y la comisión también",
    cerca(num(conSaldo?.r_comision), 0),
    `${num(conSaldo?.r_comision)}`,
  );

  const { count: liqs } = await sb
    .from("liquidacion")
    .select("*", { count: "exact", head: true })
    .eq("vendedor_id", vendedorId);
  check(
    "NO se inventó ninguna liquidación: eso habría corrompido cinco informes",
    liqs === 0,
    `${liqs} filas de liquidación`,
  );

  // --- Uno solo vivo por vendedor -----------------------------------------
  console.log("\n4. Uno vivo por vendedor");

  const { error: eDoble } = await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vendedorId,
    p_monto: 999,
    p_vigente_desde: APERTURA,
    p_usuario_id: admin.id,
  });
  check("cargar un segundo se rechaza", Boolean(eDoble), "dejó cargar dos");

  const { error: eCero } = await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vendedorId,
    p_monto: 0,
    p_vigente_desde: APERTURA,
    p_usuario_id: admin.id,
  });
  check("un saldo de cero se rechaza: no es un saldo", Boolean(eCero), "");

  // --- La fecha manda ------------------------------------------------------
  console.log("\n5. Sólo cuenta desde su fecha");

  const { data: previa } = await sb.rpc("fn_saldos_por_vendedor", {
    // Una semana ANTERIOR a la apertura: ahí todavía no se le había cargado.
    p_desde: "2019-02-18",
    p_hasta: "2019-02-24",
  });
  const enPrevia = (previa ?? []).find((f) => f.r_vendedor_id === vendedorId);
  check(
    "mirando una semana anterior a la apertura, no arrastra nada",
    !enPrevia || num(enPrevia.r_anterior) === 0,
    `${num(enPrevia?.r_anterior)}`,
  );

  // --- Se cobra como cualquier deuda vieja --------------------------------
  console.log("\n6. Se puede cobrar");

  const { data: pago, error: ePago } = await sb.rpc("fn_saldar_arrastre", {
    p_vendedor_id: vendedorId,
    p_desde: SEMANA,
    p_entrega: MONTO,
    p_fecha_pago: null,
    p_motivo: null,
    p_usuario_id: admin.id,
  });

  check(
    "SALDAR CIERRA EL SALDO DE APERTURA, aunque no haya sorteos viejos",
    !ePago,
    ePago ? `${ePago.code}: ${ePago.message}` : "",
  );

  let corteId = null;
  if (!ePago) {
    corteId = pago?.[0]?.r_corte_id;
    check(
      "el corte cobra exactamente ese saldo",
      cerca(num(pago?.[0]?.r_saldo), MONTO),
      `${num(pago?.[0]?.r_saldo)}`,
    );
    check("y sin sorteos, porque no los hay", num(pago?.[0]?.r_sorteos) === 0, `${pago?.[0]?.r_sorteos}`);

    const { data: corte } = await sb
      .from("corte_vendedor")
      .select("venta, comision, premios, saldo, nota")
      .eq("id", corteId)
      .single();
    check(
      "el corte NO dice que vendió nada: la venta queda en cero",
      cerca(num(corte.venta), 0) && cerca(num(corte.comision), 0),
      `venta ${corte.venta} · comisión ${corte.comision}`,
    );
    check(
      "pero sí que cobró el saldo",
      cerca(num(corte.saldo), MONTO),
      `${corte.saldo}`,
    );
    check("y la nota lo explica", /inicial|apertura/i.test(corte.nota ?? ""), `${corte.nota}`);

    const cobrado = await saldosDe();
    check(
      "tras cobrar, el arrastre vuelve a cero",
      !cobrado || cerca(num(cobrado.r_anterior), 0),
      `${num(cobrado?.r_anterior)}`,
    );
  }

  // --- Y reversar lo devuelve ---------------------------------------------
  console.log("\n7. Reversar el corte devuelve el saldo");

  if (corteId) {
    const { error: eRev } = await sb.rpc("fn_reversar_corte", {
      p_corte_id: corteId,
      p_motivo: "prueba saldo-inicial",
      p_usuario_id: admin.id,
    });
    check("la reversa se acepta", !eRev, eRev?.message ?? "");

    if (!eRev) {
      const devuelto = await saldosDe();
      check(
        "EL SALDO VUELVE A DEBERSE: no se evapora con el corte",
        cerca(num(devuelto?.r_anterior), MONTO),
        `${num(devuelto?.r_anterior)} contra ${MONTO}`,
      );

      const { data: fila } = await sb
        .from("saldo_inicial")
        .select("saldado_en, saldado_corte_id")
        .eq("id", saldoId)
        .single();
      check(
        "y queda otra vez sin saldar, no sólo sin corte",
        fila.saldado_en === null && fila.saldado_corte_id === null,
        `saldado_en ${fila.saldado_en}`,
      );
    }
  }

  // --- Negativo: la casa le debe ------------------------------------------
  console.log("\n8. Un saldo negativo es dinero que la casa debe");

  await sb.from("saldo_inicial").delete().eq("vendedor_id", vendedorId);

  const { error: eNeg } = await sb.rpc("fn_cargar_saldo_inicial", {
    p_vendedor_id: vendedorId,
    p_monto: -1200,
    p_vigente_desde: APERTURA,
    p_usuario_id: admin.id,
  });
  check("se admite un saldo negativo", !eNeg, eNeg?.message ?? "");

  if (!eNeg) {
    const neg = await saldosDe();
    check(
      "y sale en negativo, que es como se lee «la casa le debe»",
      cerca(num(neg?.r_anterior), -1200),
      `${num(neg?.r_anterior)}`,
    );
  }

  // --- Anular ---------------------------------------------------------------
  console.log("\n9. Se puede quitar, y queda el rastro");

  const { data: vivo } = await sb
    .from("saldo_inicial")
    .select("id")
    .eq("vendedor_id", vendedorId)
    .is("anulado_en", null)
    .maybeSingle();

  if (vivo) {
    const { error: eAnular } = await sb.rpc("fn_anular_saldo_inicial", {
      p_id: vivo.id,
      p_motivo: "se cargó mal",
      p_usuario_id: admin.id,
    });
    check("se quita sin error", !eAnular, eAnular?.message ?? "");

    const sinNada = await saldosDe();
    check(
      "y deja de contar en el arrastre",
      !sinNada || cerca(num(sinNada.r_anterior), 0),
      `${num(sinNada?.r_anterior)}`,
    );

    const { data: fila } = await sb
      .from("saldo_inicial")
      .select("anulado_en, motivo_anulacion")
      .eq("id", vivo.id)
      .single();
    check("no se borra: queda con su motivo", Boolean(fila.anulado_en), "");
    check("y el motivo se guarda", /cargó mal/.test(fila.motivo_anulacion ?? ""), `${fila.motivo_anulacion}`);

    const { data: aud } = await sb
      .from("auditoria")
      .select("accion, usuario_id")
      .eq("entidad", "saldo_inicial")
      .eq("entidad_id", vivo.id);
    check("queda auditado con autor", (aud ?? []).some((a) => a.usuario_id), `${aud?.length} entradas`);
  }
} finally {
  console.log("\n10. Limpieza");
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
