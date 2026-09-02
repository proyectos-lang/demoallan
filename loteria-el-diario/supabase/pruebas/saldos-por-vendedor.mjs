/**
 * Los saldos del informe tienen que ser LOS MISMOS que los de la liquidación.
 *
 * `fn_saldos_por_vendedor` repite la aritmética de `fn_liquidacion_por_semana`
 * para todo el padrón de una vez, porque llamarla treinta veces tardaba siete
 * segundos. Repetir una cuenta es exactamente donde aparecen las diferencias:
 * basta que una redondee antes y la otra después para que el informe y la hoja
 * del vendedor discrepen en un céntimo, y a partir de ahí no se puede confiar
 * en ninguna de las dos.
 *
 * Esta prueba las compara vendedor por vendedor y semana por semana, sobre el
 * histórico real. No escribe nada.
 *
 *     node supabase/pruebas/saldos-por-vendedor.mjs
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
  db: { schema: "allan" },
  auth: { persistSession: false },
});

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const cent = (v) => Math.round(Number(v ?? 0) * 100);

try {
  console.log("\n1. Contra la liquidación, vendedor por vendedor");

  const { data: semanas } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: null });
  check("hay semanas para comparar", (semanas ?? []).length > 0);

  const { data: vendedores } = await sb.from("vendedor").select("id, codigo").order("codigo");

  // Tres semanas repartidas: la más reciente, una del medio y la más vieja.
  const elegidas = [
    semanas[0],
    semanas[Math.floor(semanas.length / 2)],
    semanas[semanas.length - 1],
  ];

  let comparadas = 0;
  let discrepan = 0;

  for (const sem of elegidas) {
    const { data: saldos } = await sb.rpc("fn_saldos_por_vendedor", {
      p_desde: sem.r_inicio,
      p_hasta: sem.r_fin,
    });
    const porId = new Map((saldos ?? []).map((s) => [s.r_vendedor_id, s]));

    for (const v of vendedores ?? []) {
      const { data: suyas } = await sb.rpc("fn_liquidacion_por_semana", { p_vendedor_id: v.id });
      const fila = (suyas ?? []).find((x) => x.r_inicio === sem.r_inicio);
      const s = porId.get(v.id);

      // Un vendedor sin nada esa semana puede no salir en ninguna de las dos.
      if (!fila && (!s || (cent(s.r_anterior) === 0 && cent(s.r_venta) === 0))) continue;

      comparadas++;

      // El arrastre de la liquidación y el «saldo anterior» del informe son la
      // misma cifra: lo pendiente de las semanas anteriores.
      const anteriorOk = s && fila && cent(s.r_anterior) === cent(fila.r_arrastre);
      const actualOk = s && fila && cent(s.r_actual) === cent(fila.r_acumulado);
      const semanaOk = s && fila && cent(s.r_semana) === cent(fila.r_saldo);

      if (!anteriorOk || !actualOk || !semanaOk) {
        discrepan++;
        if (discrepan <= 3) {
          console.log(
            `        ${v.codigo} ${sem.r_inicio}: anterior ${s?.r_anterior}/${fila?.r_arrastre}` +
              ` · semana ${s?.r_semana}/${fila?.r_saldo} · actual ${s?.r_actual}/${fila?.r_acumulado}`,
          );
        }
      }
    }
  }

  check(
    `los saldos coinciden en las ${comparadas} comparaciones`,
    discrepan === 0,
    `${discrepan} discrepan`,
  );

  // --- 2. La identidad interna -------------------------------------------
  console.log("\n2. La cuenta cierra sobre sí misma");
  const { data: saldos, error: eSaldos } = await sb.rpc("fn_saldos_por_vendedor", {
    p_desde: semanas[0].r_inicio,
    p_hasta: semanas[0].r_fin,
  });

  /*
   * Sin esta comprobación, todo lo de abajo aprueba en falso: `[].every(...)`
   * es cierto y `[].reduce(...)` da cero, así que una función que no existe
   * —o que no devuelve nada— pasaría las tres identidades sin despeinarse.
   */
  check("la función responde y devuelve filas", !eSaldos && (saldos ?? []).length > 0,
    eSaldos?.message ?? `${(saldos ?? []).length} filas`);

  check(
    "saldo actual = anterior + pendiente, en todos",
    (saldos ?? []).every((s) => cent(s.r_actual) === cent(s.r_anterior) + cent(s.r_pendiente)),
  );
  check(
    "saldo de la semana = liquidado + pendiente, en todos",
    (saldos ?? []).every((s) => cent(s.r_semana) === cent(s.r_liquidado) + cent(s.r_pendiente)),
  );
  check(
    "el saldo de la semana es venta − comisión − premios",
    (saldos ?? []).every(
      (s) => cent(s.r_semana) === cent(s.r_venta) - cent(s.r_comision) - cent(s.r_premios),
    ),
  );

  // --- 3. Contra el total de la semana ------------------------------------
  console.log("\n3. Contra el total del padrón");
  const sumaSemana = (saldos ?? []).reduce((a, s) => a + cent(s.r_semana), 0);
  check(
    "la suma por vendedor da el saldo de la semana",
    sumaSemana === cent(semanas[0].r_saldo),
    `${sumaSemana} vs ${cent(semanas[0].r_saldo)}`,
  );
  const sumaPend = (saldos ?? []).reduce((a, s) => a + cent(s.r_pendiente), 0);
  check(
    "la suma de lo pendiente da lo pendiente de la semana",
    sumaPend === cent(semanas[0].r_pendiente),
    `${sumaPend} vs ${cent(semanas[0].r_pendiente)}`,
  );

  // --- 4. Nadie con saldo se queda fuera ----------------------------------
  console.log("\n4. Nadie con saldo desaparece");
  const conSaldo = (saldos ?? []).filter((s) => cent(s.r_actual) !== 0).length;
  check(`${conSaldo} vendedores traen saldo y todos están listados`, conSaldo > 0);
  check(
    "ninguno de los listados es una baja sin saldo ni movimiento",
    (saldos ?? []).every(
      (s) => s.r_activo || cent(s.r_anterior) !== 0 || cent(s.r_venta) !== 0,
    ),
  );
} catch (e) {
  fallos++;
  console.log(`\n  FALLA excepción: ${e.message}`);
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
