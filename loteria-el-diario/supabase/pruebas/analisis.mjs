/**
 * Análisis de resultados: que el grano reparta y no recalcule.
 *
 * `fn_analisis_resultados` corta el mismo período de cinco maneras —sorteo,
 * día, semana, mes y año—. La propiedad que la hace confiable es que las cinco
 * sumen lo mismo: si el total de un mes leído sorteo por sorteo no es idéntico
 * —al céntimo— al de ese mes leído de una sola tarjeta, entonces el corte está
 * inventando o perdiendo dinero en alguna frontera, y las tarjetas bonitas
 * estarían mintiendo.
 *
 * Lo mismo con los filtros: las tres loterías por separado tienen que sumar el
 * total sin filtro, y los vendedores uno a uno también. Un filtro que reparte
 * es un filtro; uno que no, es otra consulta.
 *
 * SÓLO LEE. No escribe nada: trabaja sobre el histórico que ya está cargado.
 *
 *     node supabase/pruebas/analisis.mjs
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

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

/** Los importes viajan como texto para no perder precisión: se suman en céntimos. */
const cent = (v) => Math.round(Number(v ?? 0) * 100);

const totales = (filas) =>
  filas.reduce(
    (a, f) => ({
      venta: a.venta + cent(f.r_venta),
      comision: a.comision + cent(f.r_comision),
      premios: a.premios + cent(f.r_premios),
      utilidad: a.utilidad + cent(f.r_utilidad),
      sorteos: a.sorteos + f.r_sorteos,
    }),
    { venta: 0, comision: 0, premios: 0, utilidad: 0, sorteos: 0 },
  );

const iguales = (a, b) =>
  a.venta === b.venta && a.comision === b.comision && a.premios === b.premios &&
  a.utilidad === b.utilidad && a.sorteos === b.sorteos;

const describir = (t) =>
  `venta=${t.venta} comision=${t.comision} premios=${t.premios} utilidad=${t.utilidad} sorteos=${t.sorteos}`;

const analizar = async (args) => {
  const { data, error } = await sb.rpc("fn_analisis_resultados", args);
  if (error) throw new Error(`${error.message} · ${JSON.stringify(args)}`);
  return data;
};

try {
  // --- Sobre qué período se prueba --------------------------------------
  // Se busca en el histórico real: la prueba no siembra nada, así que tiene
  // que descubrir dónde hay datos en vez de suponerlos.
  console.log("\n1. Período de trabajo");
  const { data: liq } = await sb
    .from("liquidacion")
    .select("sorteo:sorteo_id(fecha)")
    .order("sorteo_id", { ascending: false })
    .limit(1);

  const { data: fechas } = await sb
    .from("sorteo")
    .select("fecha")
    .eq("estado", "liquidado")
    .order("fecha", { ascending: false })
    .limit(1);

  check("hay sorteos liquidados en la base", Boolean(fechas?.length) && Boolean(liq?.length));
  if (!fechas?.length) throw new Error("Sin histórico liquidado: no hay nada que analizar.");

  const ultima = fechas[0].fecha;
  const [a, m] = ultima.split("-").map(Number);
  // Un mes entero, que es el caso donde las cuatro particiones se cruzan.
  const desde = `${a}-${String(m).padStart(2, "0")}-01`;
  const hasta = ultima;
  console.log(`  ·     ${desde} → ${hasta}`);

  // --- Las cuatro particiones del mismo rango ---------------------------
  console.log("\n2. El grano reparte el mismo total");
  const base = { p_desde: desde, p_hasta: hasta, p_vendedor_id: null, p_hora: null };

  const porSorteo = await analizar({ ...base, p_grano: "sorteo" });
  const porDia = await analizar({ ...base, p_grano: "dia" });
  const porSemana = await analizar({ ...base, p_grano: "semana" });
  const porMes = await analizar({ ...base, p_grano: "mes" });
  const porAnio = await analizar({ ...base, p_grano: "anio" });

  const tDia = totales(porDia);
  check("día a día devuelve tarjetas", porDia.length > 0, `${porDia.length}`);
  check(
    "sorteo por sorteo suma lo mismo que día a día",
    iguales(tDia, totales(porSorteo)),
    `\n        dia:    ${describir(tDia)}\n        sorteo: ${describir(totales(porSorteo))}`,
  );
  check(
    "semana a semana suma lo mismo que día a día",
    iguales(tDia, totales(porSemana)),
    `\n        dia:    ${describir(tDia)}\n        semana: ${describir(totales(porSemana))}`,
  );
  check(
    "mes a mes suma lo mismo que día a día",
    iguales(tDia, totales(porMes)),
    `\n        dia: ${describir(tDia)}\n        mes: ${describir(totales(porMes))}`,
  );
  check(
    "año a año suma lo mismo que día a día",
    iguales(tDia, totales(porAnio)),
    `\n        dia:  ${describir(tDia)}\n        anio: ${describir(totales(porAnio))}`,
  );
  check(
    "el mes cabe en una sola tarjeta",
    porMes.length === 1 && porAnio.length === 1,
    `mes=${porMes.length} anio=${porAnio.length}`,
  );

  // --- El suelo del análisis --------------------------------------------
  // Debajo de un sorteo ya no hay resultado, hay tickets. Esta sección
  // comprueba que a ese grano cada tarjeta sea de verdad UN sorteo.
  console.log("\n3. Sorteo por sorteo es el grano más fino");
  check(
    "hay una tarjeta por sorteo liquidado",
    porSorteo.length === tDia.sorteos,
    `tarjetas=${porSorteo.length} sorteos=${tDia.sorteos}`,
  );
  check(
    "cada tarjeta trae su lotería y su número ganador",
    // Contra una versión vieja de la función estos campos llegan `undefined`,
    // y `undefined !== null` es cierto: la comprobación aprobaría por ausencia.
    // Por eso se exige el valor, no que no sea nulo.
    porSorteo.every(
      (f) =>
        ["11:00", "15:00", "20:00"].includes(f.r_hora) &&
        Number.isInteger(f.r_numero_ganador) &&
        f.r_numero_ganador >= 0 &&
        f.r_numero_ganador <= 99,
    ),
  );
  check(
    "cada tarjeta es un solo sorteo de un solo día",
    porSorteo.every((f) => f.r_sorteos === 1 && f.r_dias === 1 && f.r_inicio === f.r_fin),
  );
  check(
    "los días distintos coinciden con las tarjetas de día a día",
    new Set(porSorteo.map((f) => f.r_inicio)).size === porDia.length,
    `${new Set(porSorteo.map((f) => f.r_inicio)).size} vs ${porDia.length}`,
  );
  check(
    "los granos más gruesos no traen hora ni número",
    [...porDia, ...porSemana, ...porMes, ...porAnio].every(
      (f) => f.r_hora === null && f.r_numero_ganador === null,
    ),
    "«el número ganador de agosto» no significa nada",
  );
  const soloUna = await analizar({ ...base, p_grano: "sorteo", p_hora: "15:00" });
  check(
    "filtrando una lotería sólo vienen sus sorteos",
    soloUna.length > 0 && soloUna.every((f) => f.r_hora === "15:00"),
    `${soloUna.length} tarjetas`,
  );
  check(
    "las tarjetas de sorteo vienen en orden de día y hora",
    porSorteo.every((f, i) => {
      if (i === 0) return true;
      const a = porSorteo[i - 1];
      return f.r_inicio > a.r_inicio || (f.r_inicio === a.r_inicio && f.r_hora > a.r_hora);
    }),
  );

  // --- La utilidad es una resta, no una columna -------------------------
  console.log("\n4. La utilidad se resta");
  const restaOk = porDia.every(
    (f) => cent(f.r_utilidad) === cent(f.r_venta) - cent(f.r_comision) - cent(f.r_premios),
  );
  check("utilidad = venta − comisión − premios en cada tarjeta", restaOk);

  // --- Los filtros reparten ---------------------------------------------
  console.log("\n5. Los filtros reparten, no recalculan");
  const horas = ["11:00", "15:00", "20:00"];
  const porHora = [];
  for (const h of horas) porHora.push(await analizar({ ...base, p_grano: "dia", p_hora: h }));
  const sumaHoras = totales(porHora.flat());
  check(
    "las tres loterías por separado suman el total",
    iguales(tDia, sumaHoras),
    `\n        total:   ${describir(tDia)}\n        3 horas: ${describir(sumaHoras)}`,
  );

  const { data: vendedores } = await sb.from("vendedor").select("id").limit(200);
  const porVendedor = [];
  for (const v of vendedores ?? []) {
    porVendedor.push(await analizar({ ...base, p_grano: "mes", p_vendedor_id: v.id }));
  }
  const sumaVendedores = totales(porVendedor.flat());
  check(
    `los ${vendedores?.length ?? 0} vendedores uno a uno suman el total`,
    sumaVendedores.venta === tDia.venta &&
      sumaVendedores.comision === tDia.comision &&
      sumaVendedores.premios === tDia.premios &&
      sumaVendedores.utilidad === tDia.utilidad,
    `\n        total:      ${describir(tDia)}\n        vendedores: ${describir(sumaVendedores)}`,
  );

  // --- Los bordes del período -------------------------------------------
  console.log("\n6. El período que se enseña es el que se pidió");
  check(
    "ninguna tarjeta empieza antes del rango",
    porSemana.every((f) => f.r_inicio >= desde),
    porSemana.map((f) => f.r_inicio).join(", "),
  );
  check(
    "ninguna tarjeta termina después del rango",
    porSemana.every((f) => f.r_fin <= hasta),
    porSemana.map((f) => f.r_fin).join(", "),
  );

  // Un rango que arranca a mitad de semana: la primera tarjeta tiene que
  // decir que empieza ese día, no el lunes anterior.
  const medio = `${a}-${String(m).padStart(2, "0")}-04`;
  if (medio <= hasta) {
    const parcial = await analizar({ ...base, p_desde: medio, p_grano: "semana" });
    check(
      "un rango que corta la semana la enseña recortada",
      parcial.length > 0 && parcial[0].r_inicio === medio,
      `r_inicio=${parcial[0]?.r_inicio} esperado=${medio}`,
    );
  }

  check("las tarjetas vienen en orden", porDia.every((f, i) => i === 0 || f.r_inicio > porDia[i - 1].r_inicio));

  // --- Un vendedor sin movimiento ---------------------------------------
  console.log("\n7. Sin datos, ninguna tarjeta");
  const vacio = await analizar({ ...base, p_desde: "2099-01-01", p_hasta: "2099-01-31", p_grano: "dia" });
  check("un rango sin liquidaciones devuelve cero filas", vacio.length === 0, `${vacio.length}`);
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
