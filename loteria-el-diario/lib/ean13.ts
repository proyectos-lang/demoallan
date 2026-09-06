/**
 * EAN-13 dibujado a mano, sin librería.
 *
 * POR QUÉ NO SE USA UNA LIBRERÍA
 * ------------------------------
 * El estándar cabe en cien líneas y no cambia nunca — lleva fijo desde 1977.
 * Una dependencia para esto añade peso al paquete que carga el vendedor en la
 * calle, y un día que deje de mantenerse habría que reemplazarla de todos
 * modos. Lo que sí hace falta es que las barras salgan exactas: un código mal
 * dibujado no lo lee la pistola, y eso se comprueba con el dígito de control.
 *
 * CÓMO SE CODIFICA
 * ----------------
 * Un EAN-13 son 95 módulos —barras y espacios de ancho 1— repartidos así:
 *
 *     101   [6 dígitos × 7]   01010   [6 dígitos × 7]   101
 *      │           │            │            │           └── guarda final
 *      │           │            │            └── mitad derecha, tabla C
 *      │           │            └── guarda central
 *      │           └── mitad izquierda, tablas A y B
 *      └── guarda inicial
 *
 * El PRIMER dígito no se dibuja: se codifica en el patrón de A y B que usan
 * los seis siguientes. Es la parte que sorprende a quien lo implementa por
 * primera vez, y la razón de que un EAN-13 tenga trece dígitos pero sólo doce
 * grupos de barras.
 */

/** Cómo se reparten A y B en la mitad izquierda, según el primer dígito. */
const PARIDAD = [
  "AAAAAA", "AABABB", "AABBAB", "AABBBA", "ABAABB",
  "ABBAAB", "ABBBAA", "ABABAB", "ABABBA", "ABBABA",
] as const;

/** Los tres alfabetos del estándar. 0 = espacio, 1 = barra. */
const A = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
] as const;

const B = [
  "0100111", "0110011", "0011011", "0100001", "0011101",
  "0111001", "0000101", "0010001", "0001001", "0010111",
] as const;

/** La tabla C es el complemento de la A: donde A tiene espacio, C tiene barra. */
const C = A.map((s) => s.replace(/[01]/g, (c) => (c === "0" ? "1" : "0")));

/**
 * El dígito de control: pesos 1 y 3 alternados desde la izquierda, y lo que
 * falte para la decena siguiente. Es el mismo cálculo que hace la base en
 * `fn_ean13_control`; se repite aquí para poder validar sin ir al servidor.
 */
export function controlEan13(doce: string): number {
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    suma += Number(doce[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (suma % 10)) % 10;
}

/** Si un código de trece dígitos es un EAN-13 válido. */
export function esEan13(codigo: string): boolean {
  if (!/^\d{13}$/.test(codigo)) return false;
  return controlEan13(codigo.slice(0, 12)) === Number(codigo[12]);
}

/**
 * Los 95 módulos del código, como cadena de ceros y unos.
 *
 * Devuelve `null` si el código no es válido en vez de dibujar algo que la
 * pistola no va a leer: un código de barras equivocado es peor que ninguno,
 * porque parece que funciona.
 */
export function modulosEan13(codigo: string): string | null {
  if (!esEan13(codigo)) return null;

  const d = codigo.split("").map(Number);
  const paridad = PARIDAD[d[0]];

  let out = "101"; // guarda inicial
  for (let i = 0; i < 6; i++) {
    out += paridad[i] === "A" ? A[d[i + 1]] : B[d[i + 1]];
  }
  out += "01010"; // guarda central
  for (let i = 0; i < 6; i++) {
    out += C[d[i + 7]];
  }
  out += "101"; // guarda final

  return out;
}

/**
 * El código como SVG, listo para meter en el ticket.
 *
 * SVG y no una imagen: se imprime nítido a cualquier resolución, que en una
 * térmica de 203 puntos por pulgada importa — un PNG escalado deja los bordes
 * de las barras difuminados y el lector falla más.
 *
 * Las guardas se dibujan más largas, como manda el estándar: es lo que le
 * dice al lector dónde empieza y acaba el código aunque lo lea torcido.
 */
export function svgEan13(
  codigo: string,
  { ancho = 180, alto = 46 }: { ancho?: number; alto?: number } = {},
): string | null {
  const modulos = modulosEan13(codigo);
  if (!modulos) return null;

  const m = ancho / 95;         // ancho de un módulo
  const altoBarra = alto - 9;   // hueco para los dígitos de abajo
  const guarda = alto - 4;      // las guardas bajan un poco más

  // Las posiciones de guarda: inicial, central y final.
  const esGuarda = (i: number) =>
    i < 3 || (i >= 45 && i < 50) || i >= 92;

  let barras = "";
  for (let i = 0; i < 95; i++) {
    if (modulos[i] !== "1") continue;
    barras += `<rect x="${(i * m).toFixed(3)}" y="0" width="${m.toFixed(3)}" height="${
      esGuarda(i) ? guarda : altoBarra
    }" fill="#000"/>`;
  }

  // Los dígitos debajo, repartidos como en un código de supermercado: el
  // primero fuera a la izquierda, seis bajo cada mitad.
  const texto = (t: string, x: number) =>
    `<text x="${x.toFixed(2)}" y="${alto - 0.5}" font-family="'Courier New',monospace" ` +
    `font-size="8" font-weight="700" fill="#000" text-anchor="middle">${t}</text>`;

  let digitos = texto(codigo[0], -3 * m);
  for (let i = 0; i < 6; i++) digitos += texto(codigo[i + 1], (7 + i * 7 + 3.5) * m);
  for (let i = 0; i < 6; i++) digitos += texto(codigo[i + 7], (50 + i * 7 + 3.5) * m);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}" ` +
    `viewBox="${-6 * m} 0 ${ancho + 8 * m} ${alto}" shape-rendering="crispEdges">` +
    barras + digitos +
    `</svg>`
  );
}
