/**
 * ¿Se puede sobrevender un número bajo concurrencia?
 *
 * Se dispara un lote de ventas SIMULTÁNEAS sobre el mismo número, pidiendo
 * entre todas más de lo que hay. Si el bloqueo de fila funciona, la suma
 * vendida debe quedar exactamente en el límite y ni un lempira por encima;
 * las demás peticiones deben recibir un error de cupo, no un ticket.
 *
 * Éste es el punto donde el prototipo fallaba por diseño: consultaba el cupo y
 * luego insertaba, en dos pasos separados.
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

async function rest(ruta, opciones = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    ...opciones,
    headers: { ...H, ...opciones.headers },
  });
  const texto = await r.text();
  let cuerpo;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  return { status: r.status, cuerpo };
}
const rpc = (fn, args) => rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

const LIMITE = 1000;      // límite de la casa en el número 47
const TOPE = 1000;        // tope del vendedor
const MONTO = 100;        // cada venta pide 100
const PETICIONES = 25;    // 2 500 pedidos contra 1 000 disponibles
const ESPERADOS = LIMITE / MONTO;

let vendedorId, sorteoId;

try {
  // limpieza previa
  for (const x of (await rest("vendedor?codigo=eq.V-902&select=id")).cuerpo ?? []) {
    await rest(`ticket?vendedor_id=eq.${x.id}`, { method: "DELETE" });
    await rest(`parametro_vendedor?vendedor_id=eq.${x.id}`, { method: "DELETE" });
    await rest(`vendedor?id=eq.${x.id}`, { method: "DELETE" });
  }
  await rest("sorteo?fecha=eq.2099-06-06", { method: "DELETE" });

  const v = await rest("vendedor", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      codigo: "V-902",
      nombre: "Prueba Concurrencia",
      ciudad: "San Pedro Sula",
      zona: "SPS · Prueba",
      color: "#0891b2",
    }),
  });
  vendedorId = v.cuerpo[0].id;

  await rpc("fn_guardar_parametros", {
    p_vendedor_id: vendedorId,
    p_comision: 0.1,
    p_factor_pago: 70,
    p_tope_por_numero: TOPE,
  });

  const s = await rest("sorteo", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      fecha: "2099-06-06",
      hora: "20:00",
      hora_cierre: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    }),
  });
  sorteoId = s.cuerpo[0].id;

  await rpc("fn_abrir_sorteo", { p_sorteo_id: sorteoId, p_limite_por_numero: LIMITE });

  console.log(
    `Disparando ${PETICIONES} ventas simultáneas de L ${MONTO} sobre el número 47`,
  );
  console.log(`Disponible: L ${LIMITE}. Se piden L ${PETICIONES * MONTO}.\n`);

  const inicio = Date.now();
  const resultados = await Promise.all(
    Array.from({ length: PETICIONES }, () =>
      rpc("fn_registrar_ticket", {
        p_sorteo_id: sorteoId,
        p_vendedor_id: vendedorId,
        p_lineas: [{ numero: 47, monto: MONTO }],
      }),
    ),
  );
  const ms = Date.now() - inicio;

  const aceptadas = resultados.filter((r) => r.status === 200);
  const rechazadas = resultados.filter((r) => r.status >= 400);
  const porCupo = rechazadas.filter((r) => JSON.stringify(r.cuerpo).includes("Cupo"));
  const otros = rechazadas.filter((r) => !JSON.stringify(r.cuerpo).includes("Cupo"));

  const cupo = await rest(`cupo_numero?sorteo_id=eq.${sorteoId}&numero=eq.47&select=vendido,limite_casa`);
  const vendido = Number(cupo.cuerpo[0].vendido);

  const lineas = await rest(
    `linea?select=monto,ticket:ticket_id!inner(sorteo_id)&ticket.sorteo_id=eq.${sorteoId}`,
  );
  const sumaLineas = (lineas.cuerpo ?? []).reduce((a, l) => a + Number(l.monto), 0);

  const folios = new Set(aceptadas.map((r) => r.cuerpo[0].ticket_folio));

  console.log(`  aceptadas          ${aceptadas.length}  (esperadas ${ESPERADOS})`);
  console.log(`  rechazadas por cupo ${porCupo.length}`);
  console.log(`  otros errores       ${otros.length}`, otros[0] ? JSON.stringify(otros[0].cuerpo).slice(0, 160) : "");
  console.log(`  cupo.vendido        L ${vendido} / límite L ${cupo.cuerpo[0].limite_casa}`);
  console.log(`  Σ montos de líneas  L ${sumaLineas}`);
  console.log(`  folios únicos       ${folios.size}`);
  console.log(`  tiempo              ${ms} ms\n`);

  let fallos = 0;
  const check = (n, c, d = "") => {
    if (c) console.log(`  ok    ${n}`);
    else {
      fallos++;
      console.log(`  FALLA ${n} ${d}`);
    }
  };

  check("no se sobrevendió: vendido <= límite", vendido <= LIMITE, `${vendido} > ${LIMITE}`);
  check("se vendió todo el cupo disponible", vendido === LIMITE, `${vendido}`);
  check("aceptadas == cupo / monto", aceptadas.length === ESPERADOS, `${aceptadas.length}`);
  check("el resto se rechazó por cupo, no por otro error", otros.length === 0);
  check("las líneas cuadran con el contador de cupo", sumaLineas === vendido, `${sumaLineas} vs ${vendido}`);
  check("ningún folio duplicado", folios.size === aceptadas.length, `${folios.size}`);

  console.log(`\n=== ${fallos === 0 ? "sin sobreventa" : "SOBREVENTA DETECTADA"} ===`);
  process.exitCode = fallos > 0 ? 1 : 0;
} finally {
  if (sorteoId) {
    await rest(`ticket?sorteo_id=eq.${sorteoId}`, { method: "DELETE" });
    await rest(`sorteo?id=eq.${sorteoId}`, { method: "DELETE" });
  }
  if (vendedorId) {
    await rest(`parametro_vendedor?vendedor_id=eq.${vendedorId}`, { method: "DELETE" });
    await rest(`vendedor?id=eq.${vendedorId}`, { method: "DELETE" });
  }
}
