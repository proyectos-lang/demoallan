/**
 * Formateadores portados literalmente del prototipo.
 *
 * Dos detalles que parecen erratas y no lo son:
 *  - El signo negativo es U+2212 MINUS SIGN («−»), no el guion ASCII.
 *  - La agrupación de miles usa la locale `en-US` (coma), aunque todo el texto
 *    de la aplicación esté en español. Así se ve la maqueta aprobada.
 */

const MENOS = "−";

/** `fmt(1234)` → `"L 1,234"` · `fmt(1234, false)` → `"1,234"` (para tablas). */
export function fmt(n: number, conPrefijo = true): string {
  const s = Math.round(Math.abs(n)).toLocaleString("en-US");
  return (n < 0 ? MENOS : "") + (conPrefijo ? `L ${s}` : s);
}

/** Escala corta para KPIs: `≥1M` → `L 9.36M`, `≥1k` → `L 253.1k`, si no entero. */
export function fmtK(n: number): string {
  const a = Math.abs(n);
  const s =
    a >= 1_000_000
      ? `${(a / 1_000_000).toFixed(2)}M`
      : a >= 1_000
        ? `${(a / 1_000).toFixed(1)}k`
        : Math.round(a).toString();
  return (n < 0 ? `${MENOS}L ` : "L ") + s;
}

/** `pad2(7)` → `"07"`. El número de lotería es dato numérico; esto es presentación. */
export function pad2(n: number | string): string {
  return String(n).padStart(2, "0");
}

/**
 * Zona horaria del negocio. Honduras es UTC−6 todo el año, sin horario de verano.
 *
 * TODO tiempo que se muestre o se derive pasa por aquí. No basta con confiar en
 * el huso de la máquina: las pantallas se renderizan en el servidor, que en
 * producción corre en UTC, y `getHours()` allí daría seis horas de más — un
 * ticket de las 19:00 aparecería como de la 1:00 del día siguiente.
 */
export const ZONA = "America/Tegucigalpa";

/** Fecha local a `YYYY-MM-DD` sin pasar por UTC (evita el corrimiento de un día). */
export function iso(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const partesEnZona = (fecha: Date) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(fecha)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", string>;

/** `YYYY-MM-DD` del día en Honduras, no del día donde corra el proceso. */
export function fechaHonduras(fecha: Date | string = new Date()): string {
  const p = partesEnZona(typeof fecha === "string" ? new Date(fecha) : fecha);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:MM` en hora de Honduras. */
export function horaHonduras(fecha: Date | string): string {
  const p = partesEnZona(typeof fecha === "string" ? new Date(fecha) : fecha);
  // `hour12: false` puede devolver «24» a medianoche en algunos entornos.
  return `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** Hoy en Honduras, como Date a medianoche local, para aritmética de días. */
export function hoyHonduras(): Date {
  const [a, m, d] = fechaHonduras().split("-").map(Number);
  return new Date(a, m - 1, d);
}

const MESES_CORTOS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

const MESES_LARGOS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

const DIAS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

/** `mesNombre(7)` → `"ago"` (índice 0–11). */
export function mesNombre(i: number): string {
  return MESES_CORTOS[i];
}

/** `fechaLarga('2026-08-17')` → `"lunes 17 de agosto de 2026"`. */
export function fechaLarga(fechaIso: string): string {
  const [a, m, d] = fechaIso.split("-").map(Number);
  const dow = DIAS[new Date(a, m - 1, d).getDay()];
  return `${dow} ${d} de ${MESES_LARGOS[m - 1]} de ${a}`;
}

/**
 * Igual pero sin el día de la semana: `"17 de agosto de 2026"`.
 *
 * Existe como función y no como `.replace(/^\w+ /, '')` porque `\w` no cubre
 * las vocales acentuadas: sobre «miércoles» la expresión no encuentra el
 * espacio tras «mi» y deja el día puesto. Es el bug que traía el prototipo.
 */
export function fechaLargaSinDia(fechaIso: string): string {
  const [a, m, d] = fechaIso.split("-").map(Number);
  return `${d} de ${MESES_LARGOS[m - 1]} de ${a}`;
}

/**
 * Cuenta regresiva `HH:MM:SS` hasta la hora de cierre de venta. En el prototipo
 * la hora está fija a las 19:50; aquí se recibe del sorteo, que es la fuente de
 * verdad. Si el instante ya pasó, se salta al día siguiente.
 */
export function countdown(ahora: number, horaCierre: { h: number; m: number }): string {
  const now = new Date(ahora);
  const t = new Date(now);
  t.setHours(horaCierre.h, horaCierre.m, 0, 0);
  if (t < now) t.setDate(t.getDate() + 1);

  const s = Math.floor((t.getTime() - now.getTime()) / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Cuenta regresiva `HH:MM:SS` hasta un instante dado. A diferencia de
 * `countdown`, no reinterpreta la hora: recibe el `hora_cierre` del sorteo tal
 * como está en la base, que es la fuente de verdad de cuándo cierra la venta.
 * Al llegar a cero se queda en `00:00:00`.
 */
export function countdownHasta(ahora: number, destinoIso: string): string {
  const restante = Math.max(0, Math.floor((new Date(destinoIso).getTime() - ahora) / 1000));
  const hh = String(Math.floor(restante / 3600)).padStart(2, "0");
  const mm = String(Math.floor((restante % 3600) / 60)).padStart(2, "0");
  const ss = String(restante % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Iniciales para el chip de identidad: dos primeras palabras de más de 2 letras. */
export function iniciales(nombre: string): string {
  return nombre
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}
