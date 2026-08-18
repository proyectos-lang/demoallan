/**
 * Prueba de extremo a extremo del núcleo transaccional contra el proyecto real.
 * Crea datos de prueba, ejerce las reglas y borra todo al final.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const URL_BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": "allan",
  "Content-Profile": "allan",
};

let ok = 0;
let fallos = 0;

function comprobar(nombre, condicion, detalle = "") {
  if (condicion) {
    ok++;
    console.log(`  ok    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre} ${detalle}`);
  }
}

async function rest(ruta, opciones = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { ...opciones, headers: { ...H, ...opciones.headers } });
  const texto = await r.text();
  let cuerpo;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  return { status: r.status, cuerpo };
}

const rpc = (fn, args) =>
  rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const anon = (ruta) =>
  fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      "Accept-Profile": "allan",
    },
  });

const limpiar = [];

try {
  // Restos de una corrida anterior interrumpida. Hay que borrar respetando
  // las claves foráneas: liquidación y líneas antes que el ticket, y el
  // ticket antes que el sorteo y el vendedor.
  {
    const sorteos = await rest("sorteo?fecha=gte.2099-01-01&select=id");
    for (const s of sorteos.cuerpo ?? []) {
      await rest(`liquidacion?sorteo_id=eq.${s.id}`, { method: "DELETE" });
      const tickets = await rest(`ticket?sorteo_id=eq.${s.id}&select=id`);
      for (const t of tickets.cuerpo ?? []) {
        await rest(`linea?ticket_id=eq.${t.id}`, { method: "DELETE" });
      }
      await rest(`ticket?sorteo_id=eq.${s.id}`, { method: "DELETE" });
      await rest(`cupo_numero?sorteo_id=eq.${s.id}`, { method: "DELETE" });
      await rest(`sorteo?id=eq.${s.id}`, { method: "DELETE" });
    }
    const previos = await rest("vendedor?codigo=eq.V-901&select=id");
    for (const x of previos.cuerpo ?? []) {
      await rest(`parametro_vendedor?vendedor_id=eq.${x.id}`, { method: "DELETE" });
      await rest(`vendedor?id=eq.${x.id}`, { method: "DELETE" });
    }
  }

  // --- 1. Vendedor de prueba ---------------------------------------------
  console.log("\n1. Alta de vendedor y parámetros versionados");
  const v = await rest("vendedor", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      codigo: "V-901",
      nombre: "Prueba Automatizada",
      ciudad: "San Pedro Sula",
      zona: "SPS · Prueba",
      color: "#2563eb",
      lat: 15.5045,
      lng: -88.025,
    }),
  });
  comprobar("crea vendedor", v.status === 201, JSON.stringify(v.cuerpo));
  const vendedorId = v.cuerpo?.[0]?.id;
  limpiar.push(async () => {
    await rest(`parametro_vendedor?vendedor_id=eq.${vendedorId}`, { method: "DELETE" });
    await rest(`vendedor?id=eq.${vendedorId}`, { method: "DELETE" });
  });

  // comisión 12.5 % = 0.125 · factor 70 · tope 1000
  const p1 = await rpc("fn_guardar_parametros", {
    p_vendedor_id: vendedorId,
    p_comision: 0.125,
    p_factor_pago: 70,
    p_tope_por_numero: 1000,
  });
  comprobar("guarda parámetros", p1.status === 200, JSON.stringify(p1.cuerpo));

  const rango = await rpc("fn_guardar_parametros", {
    p_vendedor_id: vendedorId,
    p_comision: 0.9,
    p_factor_pago: 70,
    p_tope_por_numero: 1000,
  });
  comprobar(
    "rechaza comisión fuera de rango",
    rango.status >= 400 && JSON.stringify(rango.cuerpo).includes("60"),
    JSON.stringify(rango.cuerpo),
  );

  // --- 2. Sorteo ----------------------------------------------------------
  console.log("\n2. Ciclo de vida del sorteo");
  const cierre = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  const s = await rest("sorteo", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ fecha: "2099-01-01", hora: "20:00", hora_cierre: cierre }),
  });
  comprobar("crea sorteo programado", s.status === 201, JSON.stringify(s.cuerpo));
  const sorteoId = s.cuerpo?.[0]?.id;
  // El sorteo no se puede borrar mientras tenga tickets o liquidaciones que lo
  // referencien — la clave foránea lo impide, y así debe ser: un sorteo con
  // ventas no puede desaparecer. Hay que borrar los dependientes primero.
  limpiar.push(async () => {
    await rest(`liquidacion?sorteo_id=eq.${sorteoId}`, { method: "DELETE" });
    const tickets = await rest(`ticket?sorteo_id=eq.${sorteoId}&select=id`);
    for (const t of tickets.cuerpo ?? []) {
      await rest(`linea?ticket_id=eq.${t.id}`, { method: "DELETE" });
    }
    await rest(`ticket?sorteo_id=eq.${sorteoId}`, { method: "DELETE" });
    await rest(`cupo_numero?sorteo_id=eq.${sorteoId}`, { method: "DELETE" });
    await rest(`sorteo?id=eq.${sorteoId}`, { method: "DELETE" });
  });

  const ganadorAntes = await rest("sorteo", {
    method: "POST",
    body: JSON.stringify({
      fecha: "2099-01-02",
      hora: "11:00",
      hora_cierre: cierre,
      numero_ganador: 42,
    }),
  });
  comprobar(
    "el CHECK impide número ganador sin liquidar",
    ganadorAntes.status >= 400,
    JSON.stringify(ganadorAntes.cuerpo),
  );

  const abrir = await rpc("fn_abrir_sorteo", {
    p_sorteo_id: sorteoId,
    p_limite_por_numero: 6000,
  });
  comprobar("abre el sorteo", [200, 204].includes(abrir.status), JSON.stringify(abrir.cuerpo));

  const cupos = await rest(`cupo_numero?sorteo_id=eq.${sorteoId}&select=numero`);
  comprobar("siembra 100 números de cupo", cupos.cuerpo?.length === 100, `n=${cupos.cuerpo?.length}`);

  // --- 3. Venta -----------------------------------------------------------
  console.log("\n3. Registro de ticket y congelamiento");
  const t1 = await rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_lineas: [
      { numero: 47, monto: 300 },
      { numero: 23, monto: 200 },
    ],
    p_lat: 15.5,
    p_lng: -88.02,
  });
  comprobar("registra ticket", t1.status === 200, JSON.stringify(t1.cuerpo));
  const folio = t1.cuerpo?.[0]?.ticket_folio;
  comprobar("folio con formato V901-YYYYMMDD-NNNN", /^V901-20990101-0001$/.test(folio ?? ""), folio);

  const lineas1 = await rest(
    `linea?select=numero,monto,comision_congelada,factor_congelado&ticket_id=eq.${t1.cuerpo?.[0]?.ticket_id}&order=numero`,
  );
  comprobar(
    "congela comisión 0.125 y factor 70 en cada línea",
    Array.isArray(lineas1.cuerpo) && lineas1.cuerpo.every(
      (l) => Number(l.comision_congelada) === 0.125 && Number(l.factor_congelado) === 70,
    ),
    JSON.stringify(lineas1.cuerpo),
  );

  const cupo47 = await rest(`cupo_numero?sorteo_id=eq.${sorteoId}&numero=eq.47&select=vendido`);
  comprobar("descuenta el cupo vendido", Number(cupo47.cuerpo?.[0]?.vendido) === 300);

  // --- 4. Cupo ------------------------------------------------------------
  console.log("\n4. Tope por número");
  const disp = await rpc("fn_cupo_disponible", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_numero: 47,
  });
  comprobar("cupo disponible = 1000 − 300 = 700", Number(disp.cuerpo) === 700, JSON.stringify(disp.cuerpo));

  const excede = await rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_lineas: [{ numero: 47, monto: 701 }],
  });
  comprobar(
    "rechaza pasarse del tope del vendedor",
    excede.status >= 400 && JSON.stringify(excede.cuerpo).includes("Cupo del vendedor"),
    JSON.stringify(excede.cuerpo),
  );

  const cupoTrasFallo = await rest(`cupo_numero?sorteo_id=eq.${sorteoId}&numero=eq.47&select=vendido`);
  comprobar(
    "el rechazo no deja cupo consumido a medias",
    Number(cupoTrasFallo.cuerpo?.[0]?.vendido) === 300,
    JSON.stringify(cupoTrasFallo.cuerpo),
  );

  // --- 5. Congelamiento frente a cambio de parámetros ---------------------
  console.log("\n5. Cambiar parámetros no reescribe historia");
  await rpc("fn_guardar_parametros", {
    p_vendedor_id: vendedorId,
    p_comision: 0.2,
    p_factor_pago: 80,
    p_tope_por_numero: 1000,
  });
  const t2 = await rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_lineas: [{ numero: 47, monto: 100 }],
  });
  comprobar("segunda venta tras el cambio", t2.status === 200, JSON.stringify(t2.cuerpo));

  const viejas = await rest(
    `linea?select=comision_congelada,factor_congelado&ticket_id=eq.${t1.cuerpo?.[0]?.ticket_id}&numero=eq.47`,
  );
  comprobar(
    "la línea vieja conserva 0.125 / 70",
    Number(viejas.cuerpo?.[0]?.comision_congelada) === 0.125 &&
      Number(viejas.cuerpo?.[0]?.factor_congelado) === 70,
    JSON.stringify(viejas.cuerpo),
  );
  const nuevas = await rest(
    `linea?select=comision_congelada,factor_congelado&ticket_id=eq.${t2.cuerpo?.[0]?.ticket_id}`,
  );
  comprobar(
    "la línea nueva usa 0.200 / 80",
    Number(nuevas.cuerpo?.[0]?.comision_congelada) === 0.2 &&
      Number(nuevas.cuerpo?.[0]?.factor_congelado) === 80,
    JSON.stringify(nuevas.cuerpo),
  );

  const versiones = await rest(`parametro_vendedor?vendedor_id=eq.${vendedorId}&select=vigente_hasta`);
  comprobar("versiona en vez de actualizar", versiones.cuerpo?.length === 2, `n=${versiones.cuerpo?.length}`);
  comprobar(
    "sólo una versión vigente",
    versiones.cuerpo?.filter((x) => x.vigente_hasta === null).length === 1,
  );

  // --- 6. Liquidación -----------------------------------------------------
  console.log("\n6. Liquidación");
  const liqAbierto = await rpc("fn_liquidar_sorteo", { p_sorteo_id: sorteoId, p_numero_ganador: 47 });
  comprobar(
    "no liquida un sorteo abierto",
    liqAbierto.status >= 400,
    JSON.stringify(liqAbierto.cuerpo),
  );

  await rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteoId });
  const ventaCerrado = await rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_lineas: [{ numero: 12, monto: 50 }],
  });
  comprobar("no vende con el sorteo cerrado", ventaCerrado.status >= 400);

  const liq = await rpc("fn_liquidar_sorteo", { p_sorteo_id: sorteoId, p_numero_ganador: 47 });
  comprobar("liquida", liq.status === 200, JSON.stringify(liq.cuerpo));

  // 300 × 70 (línea vieja) + 100 × 80 (línea nueva) = 21000 + 8000 = 29000
  comprobar(
    "premio = Σ monto × factor congelado de cada línea (29 000)",
    Number(liq.cuerpo?.[0]?.total_premios) === 29000,
    JSON.stringify(liq.cuerpo),
  );

  const l = await rest(`liquidacion?sorteo_id=eq.${sorteoId}&select=venta,comision,premios,utilidad`);
  const fila = l.cuerpo?.[0];
  // venta 600 · comisión 300×.125 + 200×.125 + 100×.2 = 37.5+25+20 = 82.5
  comprobar("venta agregada = 600", Number(fila?.venta) === 600, JSON.stringify(fila));
  comprobar("comisión con factores congelados = 82.50", Number(fila?.comision) === 82.5, JSON.stringify(fila));
  comprobar(
    "utilidad = venta − comisión − premios",
    Number(fila?.utilidad) === 600 - 82.5 - 29000,
    JSON.stringify(fila),
  );

  const dobleLiq = await rpc("fn_liquidar_sorteo", { p_sorteo_id: sorteoId, p_numero_ganador: 47 });
  comprobar("no se puede liquidar dos veces", dobleLiq.status >= 400);

  // --- 7. Auditoría y superficie pública ----------------------------------
  console.log("\n7. Auditoría, RLS y consulta pública");
  const aud = await rest(`auditoria?select=accion&order=id.desc&limit=20`);
  const acciones = new Set((aud.cuerpo ?? []).map((a) => a.accion));
  comprobar(
    "auditoría registra abrir/crear/liquidar",
    ["abrir", "crear", "liquidar"].every((a) => acciones.has(a)),
    [...acciones].join(","),
  );

  const anonVendedor = await anon("vendedor?select=id&limit=1");
  comprobar("anon NO puede leer vendedor", anonVendedor.status >= 400, `http=${anonVendedor.status}`);

  const anonTicket = await anon("ticket?select=id&limit=1");
  comprobar("anon NO puede leer tickets", anonTicket.status >= 400, `http=${anonTicket.status}`);

  const anonPublico = await anon("v_resultado_publico?select=*");
  const cuerpoPublico = await anonPublico.json();
  comprobar("anon SÍ lee la vista pública", anonPublico.status === 200, `http=${anonPublico.status}`);
  comprobar(
    "la vista pública sólo expone fecha/hora/numero_ganador",
    Array.isArray(cuerpoPublico) &&
      cuerpoPublico.every(
        (r) => Object.keys(r).sort().join(",") === "fecha,hora,numero_ganador",
      ),
    JSON.stringify(cuerpoPublico).slice(0, 200),
  );
} finally {
  console.log("\n8. Limpieza");
  // Se borra en orden inverso; ON DELETE CASCADE arrastra cupo y líneas.
  for (const paso of limpiar.reverse()) {
    // ignorar errores de FK: se resuelven con el borrado en cascada siguiente
    await paso().catch(() => {});
  }
}

console.log(`\n=== ${ok} comprobaciones ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
