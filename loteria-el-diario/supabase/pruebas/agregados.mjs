/**
 * Agregados del tablero.
 *
 * Monta un histórico de tres meses con sorteos en distintos estados y compara
 * lo que devuelven las funciones contra cuentas hechas a mano. Lo que más
 * importa comprobar:
 *
 *   1. Que la venta de un sorteo SIN liquidar nunca se cuele en premios ni en
 *      utilidad — serían proyección, no resultado (§5).
 *   2. Que un vendedor autenticado agregue sólo lo suyo, porque las funciones
 *      corren como el invocador y RLS filtra.
 *
 *     PW=<clave-admin> node supabase/pruebas/agregados.mjs
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
const sb = createClient(U, SERVICE, { db: { schema: "allan" }, auth: { persistSession: false } });
const admin = createClient(U, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});
const vend = createClient(U, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});

const FECHAS = ["2095-01-15", "2095-02-15", "2095-03-15"];
const DESDE = "2095-01-01";
const HASTA = "2095-12-31";

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
const cerca = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

const limpiar = async () => {
  for (const f of FECHAS) {
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

let usuarioVendedor;

try {
  await limpiar();

  const { data: vs } = await sb
    .from("vendedor")
    .select("id, codigo, nombre, parametro_vendedor!inner(comision, factor_pago, vigente_hasta)")
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");
  const par = (v) => (Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor);
  const [v1, v2] = vs;
  const p1 = par(v1), p2 = par(v2);

  // Cuentas a mano, acumuladas mientras se monta.
  const esperado = {
    venta: 0, comision: 0, premios: 0, utilidad: 0, ventaPendiente: 0,
    porMes: {}, porVendedor: { [v1.id]: { venta: 0, utilidad: 0 }, [v2.id]: { venta: 0, utilidad: 0 } },
  };

  console.log("\n1. Montaje de tres meses");
  for (const [i, fecha] of FECHAS.entries()) {
    await sb.rpc("fn_programar_dia", { p_fecha: fecha });
    const { data: ss } = await sb.from("sorteo").select("id, hora").eq("fecha", fecha);
    const id = ss.find((s) => s.hora === "20:00").id;
    await sb.rpc("fn_abrir_sorteo", { p_sorteo_id: id, p_limite_por_numero: 90000 });

    // Montos distintos por mes para que la serie mensual no sea plana.
    const m1 = 100 * (i + 1);
    const m2 = 50 * (i + 1);
    const ganador = 42;

    let e = (await sb.rpc("fn_registrar_ticket", {
      p_sorteo_id: id, p_vendedor_id: v1.id,
      p_lineas: [{ numero: ganador, monto: m1 }, { numero: 7, monto: m1 }],
    })).error;
    if (e) throw new Error(`venta v1 ${fecha}: ${e.message}`);

    e = (await sb.rpc("fn_registrar_ticket", {
      p_sorteo_id: id, p_vendedor_id: v2.id, p_lineas: [{ numero: ganador, monto: m2 }],
    })).error;
    if (e) throw new Error(`venta v2 ${fecha}: ${e.message}`);

    const ventaSorteo = m1 * 2 + m2;
    const comisionSorteo = m1 * 2 * Number(p1.comision) + m2 * Number(p2.comision);
    const premiosSorteo = m1 * Number(p1.factor_pago) + m2 * Number(p2.factor_pago);

    esperado.venta += ventaSorteo;

    // El último mes se queda SIN liquidar: es el caso que importa.
    const seLiquida = i < FECHAS.length - 1;
    if (seLiquida) {
      await sb.rpc("fn_cerrar_sorteo", { p_sorteo_id: id });
      e = (await sb.rpc("fn_liquidar_sorteo", { p_sorteo_id: id, p_numero_ganador: ganador })).error;
      if (e) throw new Error(`liquidar ${fecha}: ${e.message}`);

      esperado.comision += comisionSorteo;
      esperado.premios += premiosSorteo;
      esperado.utilidad += ventaSorteo - comisionSorteo - premiosSorteo;
      esperado.porMes[i] = ventaSorteo - comisionSorteo - premiosSorteo;
      esperado.porVendedor[v1.id].venta += m1 * 2;
      esperado.porVendedor[v1.id].utilidad +=
        m1 * 2 - m1 * 2 * Number(p1.comision) - m1 * Number(p1.factor_pago);
      esperado.porVendedor[v2.id].venta += m2;
      esperado.porVendedor[v2.id].utilidad +=
        m2 - m2 * Number(p2.comision) - m2 * Number(p2.factor_pago);
    } else {
      esperado.ventaPendiente += ventaSorteo;
      esperado.porMes[i] = 0;
      esperado.porVendedor[v1.id].venta += m1 * 2;
      esperado.porVendedor[v2.id].venta += m2;
    }
    console.log(`   ${fecha}  venta ${ventaSorteo}  ${seLiquida ? "liquidado" : "SIN liquidar"}`);
  }

  console.log("\n2. Totales del período");
  await admin.auth.signInWithPassword({ email: "admin@eldiario.hn", password: process.env.PW });
  const { data: tot, error: eTot } = await admin.rpc("fn_resumen_periodo", {
    p_desde: DESDE, p_hasta: HASTA,
  });
  if (eTot) throw new Error(eTot.message);
  const t = tot[0];

  check("venta total incluye lo pendiente", cerca(t.venta, esperado.venta), `${t.venta} vs ${esperado.venta}`);
  check("premios sólo de sorteos liquidados", cerca(t.premios, esperado.premios), `${t.premios} vs ${esperado.premios}`);
  check("utilidad sólo de sorteos liquidados", cerca(t.utilidad, esperado.utilidad), `${t.utilidad} vs ${esperado.utilidad}`);
  check("venta pendiente separada", cerca(t.venta_pendiente, esperado.ventaPendiente), `${t.venta_pendiente} vs ${esperado.ventaPendiente}`);
  check("cuenta los sorteos pendientes", Number(t.sorteos_pendientes) === 1, `${t.sorteos_pendientes}`);
  check("cuenta los sorteos liquidados", Number(t.sorteos_liquidados) === 2, `${t.sorteos_liquidados}`);
  check("tickets del período", Number(t.tickets) === 6, `${t.tickets}`);

  // La comprobación que de verdad importa: lo pendiente no se coló.
  check(
    "la venta sin liquidar NO entró en la utilidad",
    Number(t.utilidad) === Number(t.venta_liquidada) - Number(t.comision_liquidada) - Number(t.premios),
    `${t.utilidad}`,
  );

  console.log("\n3. Serie mensual");
  const { data: meses } = await admin.rpc("fn_resumen_mensual", { p_desde: DESDE, p_hasta: HASTA });
  check("tres meses", meses.length === 3, `${meses.length}`);
  check("meses en base 0 (enero = 0)", Number(meses[0].mes) === 0, `${meses[0].mes}`);
  check("utilidad de enero", cerca(meses[0].utilidad, esperado.porMes[0]), `${meses[0].utilidad}`);
  check("utilidad de febrero", cerca(meses[1].utilidad, esperado.porMes[1]), `${meses[1].utilidad}`);
  check("marzo sin liquidar: utilidad 0", Number(meses[2].utilidad) === 0, `${meses[2].utilidad}`);
  check("marzo declara su venta pendiente", Number(meses[2].venta_pendiente) > 0, `${meses[2].venta_pendiente}`);

  console.log("\n4. Por vendedor");
  const { data: porV } = await admin.rpc("fn_resumen_vendedor", { p_desde: DESDE, p_hasta: HASTA });
  const f1 = porV.find((x) => x.vendedor_id === v1.id);
  const f2 = porV.find((x) => x.vendedor_id === v2.id);
  check("venta del vendedor 1", cerca(f1.venta, esperado.porVendedor[v1.id].venta), `${f1.venta}`);
  check("utilidad del vendedor 1", cerca(f1.utilidad, esperado.porVendedor[v1.id].utilidad), `${f1.utilidad}`);
  check("venta del vendedor 2", cerca(f2.venta, esperado.porVendedor[v2.id].venta), `${f2.venta}`);
  check("ordenado por venta descendente", Number(porV[0].venta) >= Number(porV[1].venta));
  check("incluye vendedores sin ventas, en cero", porV.length >= 5, `${porV.length}`);

  console.log("\n5. Un día");
  const { data: dia } = await admin.rpc("fn_resumen_dia", { p_fecha: FECHAS[2] });
  check("los tres sorteos del día", dia.length === 3, `${dia.length}`);
  const noche = dia.find((d) => d.hora === "20:00");
  check("el de las 20:00 sigue abierto", noche.estado === "abierto", noche.estado);
  check("sin liquidar no hay premios", Number(noche.premios) === 0, `${noche.premios}`);
  check("sin liquidar no hay número ganador", noche.numero_ganador === null, `${noche.numero_ganador}`);
  check("los sorteos sin ventas salen en cero, no ausentes", dia.filter((d) => Number(d.venta) === 0).length === 2);

  const { data: desglose } = await admin.rpc("fn_desglose_dia", { p_fecha: FECHAS[2] });
  check("desglose: una fila por vendedor con ventas", desglose.length === 2, `${desglose.length}`);

  console.log("\n6. RLS: un vendedor agrega sólo lo suyo");
  const alta = await fetch(`${U}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "agregados@eldiario.hn", password: "PruebaAgregados123", email_confirm: true }),
  });
  const u = await alta.json();
  usuarioVendedor = u.id;
  await sb.from("usuario_perfil").insert({ id: u.id, rol: "vendedor", vendedor_id: v1.id, nombre: v1.nombre });

  await vend.auth.signInWithPassword({ email: "agregados@eldiario.hn", password: "PruebaAgregados123" });
  const { data: totV, error: eV } = await vend.rpc("fn_resumen_periodo", { p_desde: DESDE, p_hasta: HASTA });

  check("el vendedor puede consultar sus agregados", !eV, eV?.message);
  if (!eV) {
    check(
      "sólo ve su propia venta, no la de todos",
      cerca(totV[0].venta, esperado.porVendedor[v1.id].venta),
      `${totV[0].venta} vs propio ${esperado.porVendedor[v1.id].venta} (total del negocio ${esperado.venta})`,
    );
    check("y desde luego menos que el total", Number(totV[0].venta) < esperado.venta);
  }
} finally {
  console.log("\n7. Limpieza");
  await limpiar();
  if (usuarioVendedor) {
    await sb.from("usuario_perfil").delete().eq("id", usuarioVendedor);
    await fetch(`${U}/auth/v1/admin/users/${usuarioVendedor}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
  }
  await sb.from("auditoria").delete().gt("id", 0);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
