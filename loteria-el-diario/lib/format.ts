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

/*
   El importe COMPLETO, con separador de millares: `L 9,360,000`.

   Antes abreviaba —`L 9.36M`, `L 253.1k`— y eso tiene dos problemas en una
   pantalla que se mira para decidir:

     · Obliga a traducir de cabeza. Nadie cobra ni paga en «kas»; el gerente
       que compara dos cifras acaba haciendo la cuenta mentalmente, y ahí es
       donde se equivoca.

     · REDONDEA, y el redondeo esconde dinero. `L 253.1k` es cualquier valor
       entre 253.050 y 253.149: cien lempiras de diferencia que alguien tiene
       que cuadrar al final de la semana. Con `L 253,087` no hay nada que
       adivinar.

   Se conserva el nombre `fmtK` porque lo llaman nueve pantallas y renombrarlo
   sería un cambio ruidoso sin ganancia; lo que cambia es lo que devuelve.
   Redondea al lempira, como `fmt`: los céntimos en un total de tablero son
   ruido, y la liquidación —que sí los necesita— usa otro camino.
*/
export function fmtK(n: number): string {
  const s = Math.round(Math.abs(n)).toLocaleString("en-US");
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

/**
 * Las tres franjas del día, en el orden en que se juegan.
 *
 * ES LA ETIQUETA DEL ENUM `hora_sorteo`, no una hora cualquiera: identifica la
 * franja en toda la base. Cambiarla aquí no basta —hay que renombrar también
 * el valor del enum, como hizo la 0059 al mover la noche de las 8 a las 9—
 * pero tenerla en un solo sitio evita que un filtro se quede ofreciendo un
 * sorteo que ya no existe.
 *
 * Estaba repetida en doce archivos. Olvidar uno no da error: da un filtro que
 * no devuelve nada y nadie sabe por qué.
 */
export const SORTEOS = ["11:00", "15:00", "21:00"] as const;

export type Sorteo = (typeof SORTEOS)[number];

/** Si una cadena cualquiera —de la URL, por ejemplo— es una franja válida. */
export function esSorteo(v: string): v is Sorteo {
  return (SORTEOS as readonly string[]).includes(v);
}

/**
 * `HH:MM` de 24 horas a «h:mm AM».
 *
 * La etiqueta del sorteo (`sorteo.hora`) es un enum de texto —`"11:00"`,
 * `"15:00"`, `"21:00"`— y NO un instante, así que no se puede formatear con
 * Intl: no hay fecha a la que aplicarle un huso. Se traduce a mano.
 *
 * El resultado es «11:00 AM» / «3:00 PM» / «9:00 PM»: sin cero a la izquierda
 * en la hora, que es como se lee en Honduras, y con el meridiano en mayúsculas
 * y sin puntos, como en el resto de la interfaz.
 */
export function hora12(etiqueta: string): string {
  const [h, m] = etiqueta.split(":");
  const hora = Number(h);
  if (!Number.isFinite(hora)) return etiqueta;

  const meridiano = hora < 12 ? "AM" : "PM";
  const doce = hora % 12 === 0 ? 12 : hora % 12;
  return `${doce}:${m ?? "00"} ${meridiano}`;
}

/**
 * Cómo llama el negocio a cada sorteo: mañana, tarde y noche.
 *
 * Vive aquí y no junto a los filtros porque los filtros son un módulo de
 * cliente, y todo lo que un componente de servidor importa de un `"use client"`
 * le llega como referencia de cliente, no como el valor: indexar ese objeto
 * devolvía `undefined` y el rótulo salía «Martes ·», sin la jornada.
 */
export function jornada(etiqueta: string): string {
  const h = Number(etiqueta.split(":")[0]);
  if (h < 12) return "Mañana";
  return h < 18 ? "Tarde" : "Noche";
}

/** `h:mm AM` en hora de Honduras, a partir de un instante. */
export function horaHonduras12(fecha: Date | string): string {
  return hora12(horaHonduras(fecha));
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
