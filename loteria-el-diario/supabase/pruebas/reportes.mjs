/**
 * Reporte filtrable.
 *
 * Lo que de verdad se pone a prueba: que los subtotales correspondan al FILTRO
 * COMPLETO y no a la página visible. Para eso el montaje genera más registros
 * de los que la tabla enseña — si alguien alguna vez calcula los subtotales
 * sobre las filas devueltas, esta prueba lo detecta.
 *
 *     PW=<clave-admin> node supabase/pruebas/reportes.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const U = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(U, SERVICE, { db: { schema: "public" }, auth: { persistSession: false } });
const admin = createClient(U, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});
const vend = createClient(U, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

const DIAS = ["2094-04-01", "2094-04-02", "2094-04-03", "2094-04-04", "2094-04-05", "2094-04-06"];
const DESDE = "2094-04-01";
const HASTA = "2094-04-30";
const VISIBLES = 80;
const GANADOR = 33;

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const limpiar = async () => {
  for (const f of DIAS) {
    const { data: ss } = await sb.from("sorteo").select("id").eq("fecha", f);
    for (const s of ss ?? []) {
      await sb.from("liquidacion").delete().eq("sorteo_id", s.id);
      const { data: ts } = await sb.from("ticket").select("id").eq("sorteo_id", s.id);
      for (const t of ts ?? []) await sb.from("linea").delete().eq("ticket_id", t.id);
      await sb.from("ticket").delete().eq("sorteo_id", s.id);
      await sb.from("cupo_numero").delete().eq("sorteo_id", s.id);
      await sb.from("sorteo").delete().eq("id", s.id);
    }
  }
};

let usuario;

try {
  await limpiar();

  const { data: vs } = await sb.from("vendedor").select("id, codigo, nombre").eq("activo", true).order("codigo");

  console.log(`\n1. Montaje: ${DIAS.length} días × 3 sorteos × ${vs.length} vendedores`);
  let ventaTotal = 0;
  for (const [d, fecha] of DIAS.entries()) {
    await sb.rpc("fn_programar_dia", { p_fecha: fecha });
    const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", fecha).order("hora");

    for (const s of ss) {
      let e = (await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: s.id, p_limite_por_numero: 90000 })).error;
      if (e) throw new Error(`abrir ${fecha} ${s.hora}: ${e.message}`);

      for (const [i, v] of vs.entries()) {
        const monto = 10 * (i + 1);
        e = (await sb.rpc("fn_registrar_ticket", {
          p_sorteo_id: s.id, p_vendedor_id: v.id, p_lineas: [{ numero: GANADOR, monto }],
        })).error;
        if (e) throw new Error(`venta ${fecha} ${s.hora}: ${e.message}`);
        ventaTotal += monto;
      }

      // Los tres primeros días se liquidan; los tres últimos quedan pendientes.
      if (d < 3) {
        await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: s.id });
        e = (await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: s.id, p_numero_ganador: GANADOR })).error;
        if (e) throw new Error(`liquidar ${fecha} ${s.hora}: ${e.message}`);
      }
    }
  }
  const registrosEsperados = DIAS.length * 3 * vs.length;
  console.log(`   ${registrosEsperados} registros · venta total ${ventaTotal}`);

  await admin.auth.signInWithPassword({ email: "admin@eldiario.hn", password: process.env.PW });
  const arg = { p_desde: DESDE, p_hasta: HASTA };

  console.log("\n2. Subtotales sobre el filtro completo, no sobre la página");
  const { data: tot, error: eTot } = await admin.rpc("fn_reporte_totales", arg);
  if (eTot) throw new Error(eTot.message);
  const t = tot[0];

  const { data: filas, error: eFilas } = await admin.rpc("fn_reporte_filas", {
    ...arg, p_limite: VISIBLES, p_desde_fila: 0,
  });
  if (eFilas) throw new Error(eFilas.message);

  check("hay más registros que filas visibles", registrosEsperados > VISIBLES, `${registrosEsperados}`);
  check("el conteo es del filtro completo", Number(t.registros) === registrosEsperados, `${t.registros}`);
  check("la tabla devuelve sólo la página", filas.length === VISIBLES, `${filas.length}`);
  check("venta total del filtro", cerca(t.venta, ventaTotal), `${t.venta} vs ${ventaTotal}`);

  const ventaVisible = filas.reduce((a, f) => a + Number(f.venta), 0);
  check(
    "el subtotal NO es la suma de lo visible",
    !cerca(t.venta, ventaVisible),
    `total ${t.venta} · visible ${ventaVisible}`,
  );
  check("días distintos", Number(t.dias) === DIAS.length, `${t.dias}`);

  console.log("\n3. Liquidado y pendiente");
  check("cuenta los registros pendientes", Number(t.registros_pendientes) === 3 * 3 * vs.length, `${t.registros_pendientes}`);
  check("la venta pendiente va aparte", Number(t.venta_pendiente) > 0 && Number(t.venta_pendiente) < ventaTotal, `${t.venta_pendiente}`);
  check(
    "utilidad = venta liquidada − comisión − premios",
    cerca(Number(t.utilidad), ventaTotal - Number(t.venta_pendiente) - Number(t.comision) - Number(t.premios)),
    `${t.utilidad}`,
  );

  console.log("\n4. Filtros");
  const { data: porVend } = await admin.rpc("fn_reporte_totales", { ...arg, p_vendedor_id: vs[0].id });
  check("por vendedor", Number(porVend[0].registros) === DIAS.length * 3, `${porVend[0].registros}`);

  const { data: porHora } = await admin.rpc("fn_reporte_totales", { ...arg, p_hora: "15:00" });
  check("por sorteo", Number(porHora[0].registros) === DIAS.length * vs.length, `${porHora[0].registros}`);

  const { data: porNumero } = await admin.rpc("fn_reporte_totales", { ...arg, p_numero: GANADOR });
  check(
    "por número ganador: sólo sorteos liquidados",
    Number(porNumero[0].registros) === 3 * 3 * vs.length,
    `${porNumero[0].registros}`,
  );

  const { data: otroNumero } = await admin.rpc("fn_reporte_totales", { ...arg, p_numero: 99 });
  check("un número que no salió no devuelve nada", Number(otroNumero[0].registros) === 0, `${otroNumero[0].registros}`);

  const { data: combinado } = await admin.rpc("fn_reporte_totales", {
    ...arg, p_vendedor_id: vs[0].id, p_hora: "15:00",
  });
  check("filtros combinados", Number(combinado[0].registros) === DIAS.length, `${combinado[0].registros}`);

  console.log("\n5. Orden");
  check("lo más reciente arriba", filas[0].fecha >= filas[filas.length - 1].fecha, `${filas[0].fecha}`);
  const delMismoDia = filas.filter((f) => f.fecha === filas[0].fecha);
  check(
    "dentro del día, en el orden en que ocurrió",
    delMismoDia.every((f, i) => i === 0 || f.hora >= delMismoDia[i - 1].hora),
    JSON.stringify(delMismoDia.map((f) => f.hora)),
  );

  console.log("\n6. RLS: el vendedor ve sólo lo suyo");
  const alta = await fetch(`${U}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reportes@eldiario.hn", password: "PruebaReportes123", email_confirm: true }),
  });
  const u = await alta.json();
  usuario = u.id;
  await sb.from("usuario_perfil").insert({ id: u.id, rol: "vendedor", vendedor_id: vs[0].id, nombre: vs[0].nombre });
  await vend.auth.signInWithPassword({ email: "reportes@eldiario.hn", password: "PruebaReportes123" });

  const { data: totV, error: eV } = await vend.rpc("fn_reporte_totales", arg);
  check("el vendedor puede abrir el reporte", !eV, eV?.message);
  if (!eV) {
    check("sólo sus registros", Number(totV[0].registros) === DIAS.length * 3, `${totV[0].registros}`);
    check("subtotales coherentes con lo que ve", Number(totV[0].venta) < ventaTotal, `${totV[0].venta}`);
  }
  const { data: filasV } = await vend.rpc("fn_reporte_filas", { ...arg, p_limite: 200 });
  check(
    "ninguna fila de otro vendedor",
    (filasV ?? []).every((f) => f.vendedor_id === vs[0].id),
    `${(filasV ?? []).length} filas`,
  );
} finally {
  console.log("\n7. Limpieza");
  await limpiar();
  if (usuario) {
    await sb.from("usuario_perfil").delete().eq("id", usuario);
    await fetch(`${U}/auth/v1/admin/users/${usuario}`, {
      method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
  }
  await sb.from("auditoria").delete().gt("id", 0);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
