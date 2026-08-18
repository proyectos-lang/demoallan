/**
 * Programa los tres sorteos de una fecha y abre los que todavía admiten venta.
 *
 *     node supabase/programar-dia.mjs            # hoy
 *     node supabase/programar-dia.mjs 2026-08-18
 *
 * Un sorteo se abre sólo si aún no ha pasado su hora de cierre; los de más
 * temprano quedan en `programado` para no simular una venta que no ocurrió.
 *
 * Provisional: esto lo hará un cron. Mientras tanto desbloquea el desarrollo
 * del punto de venta, que necesita un sorteo abierto para existir.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

// Límite de la casa por número, DIFERENCIADO POR FRANJA (decisión §13): el
// sorteo de la noche vende bastante más que el de la mañana.
const LIMITE = { "11:00": 4000, "15:00": 5000, "20:00": 7000 };

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "allan" },
  auth: { persistSession: false },
});

const pad = (n) => String(n).padStart(2, "0");
const hoy = new Date();
const fecha =
  process.argv[2] ?? `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(hoy.getDate())}`;

const { error } = await sb.rpc("fn_programar_dia", { p_fecha: fecha });
if (error) {
  console.error("No se pudo programar:", error.message);
  process.exit(1);
}

const { data: sorteos } = await sb
  .from("sorteo")
  .select("id, hora, estado, hora_cierre")
  .eq("fecha", fecha)
  .order("hora");

for (const s of sorteos ?? []) {
  const cierre = new Date(s.hora_cierre);
  const vigente = cierre > new Date();

  if (s.estado !== "programado") {
    console.log(`  ${s.hora}  ya estaba ${s.estado}`);
    continue;
  }
  if (!vigente) {
    console.log(`  ${s.hora}  se queda programado (su cierre ya pasó)`);
    continue;
  }

  const { error: e } = await sb.rpc("fn_abrir_sorteo", {
    p_sorteo_id: s.id,
    p_limite_por_numero: LIMITE[s.hora],
  });
  console.log(
    e
      ? `  ${s.hora}  ERROR ${e.message}`
      : `  ${s.hora}  abierto · límite de la casa L ${LIMITE[s.hora]} por número · cierra ${cierre.toLocaleTimeString("es-HN")}`,
  );
}

console.log(`\nFecha ${fecha} lista.`);
