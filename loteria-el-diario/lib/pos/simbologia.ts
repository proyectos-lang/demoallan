/**
 * La simbología de los cien números.
 *
 * POR QUÉ ESTÁ EN EL SISTEMA
 * --------------------------
 * El cliente no siempre pide un número: pide «el muerto», «la vaca», «el
 * carro». El vendedor traduce de memoria y apunta el número. Esa traducción
 * es la que se equivoca cuando hay cola, y el error no se ve hasta que sale
 * el sorteo: el ticket dice 03 y el cliente quería 03, pero si el vendedor
 * oyó «muerto» y marcó 30 —«bolo»—, nadie lo nota hasta que hay que pagar.
 *
 * Al poner el símbolo junto al número, la traducción deja de estar sólo en la
 * cabeza del vendedor y se puede comprobar de un vistazo.
 *
 * LO QUE ESTA TABLA NO ES
 * -----------------------
 * No es un dato del negocio: no se guarda en la base, no viaja en el ticket y
 * no entra en ninguna cuenta. Lo que se vende, se liquida y se paga sigue
 * siendo EL NÚMERO. Esto es una ayuda para leer la pantalla, y por eso vive
 * en el cliente y no en una tabla de Postgres: cambiar un emoji no puede
 * obligar a una migración.
 *
 * SOBRE LOS EMOJI
 * ---------------
 * Se pintan con la fuente del sistema, así que se ven distinto en Windows, en
 * Android y en iPhone. Da igual: el vendedor aprende la figura de su propio
 * teléfono. Lo que NO puede pasar es que el símbolo desplace al número, y por
 * eso en la rejilla se pinta siempre más pequeño que la cifra.
 */

/** Un número y lo que representa. */
export type Simbolo = {
  /** 0 a 99. Se pinta con `pad2`. */
  numero: number;
  /** El nombre con el que lo pide el cliente. */
  nombre: string;
  /** La figura. Puede ocupar más de un punto de código (banderas, familias). */
  emoji: string;
};

/**
 * Los cien, en orden.
 *
 * El orden importa: `SIMBOLOS[n]` tiene que ser el número `n`. Se comprueba
 * en `simbologia.mjs`, porque un desplazamiento de una sola posición haría que
 * toda la rejilla mintiera sin que nada pareciera roto.
 */
export const SIMBOLOS: Simbolo[] = [
  { numero: 0, nombre: "Avión", emoji: "✈️" },
  { numero: 1, nombre: "Pies", emoji: "🦶" },
  { numero: 2, nombre: "Mujer", emoji: "👩" },
  { numero: 3, nombre: "Muerto", emoji: "💀" },
  { numero: 4, nombre: "Tigre", emoji: "🐯" },
  { numero: 5, nombre: "Embarazada", emoji: "🤰" },
  { numero: 6, nombre: "Elefante", emoji: "🐘" },
  { numero: 7, nombre: "Navaja", emoji: "🗡️" },
  { numero: 8, nombre: "Conejo", emoji: "🐰" },
  { numero: 9, nombre: "Hombre", emoji: "👨" },
  { numero: 10, nombre: "Anillo", emoji: "💍" },
  { numero: 11, nombre: "Perro", emoji: "🐶" },
  { numero: 12, nombre: "Caballo", emoji: "🐴" },
  { numero: 13, nombre: "Gato", emoji: "🐱" },
  { numero: 14, nombre: "Boda", emoji: "👰‍♀️" },
  { numero: 15, nombre: "Ratón", emoji: "🐭" },
  { numero: 16, nombre: "Niña", emoji: "👧" },
  { numero: 17, nombre: "Joven", emoji: "🧑" },
  { numero: 18, nombre: "Ángel", emoji: "😇" },
  { numero: 19, nombre: "Mariposa", emoji: "🦋" },
  { numero: 20, nombre: "Espejo", emoji: "🪞" },
  { numero: 21, nombre: "Pájaro", emoji: "🐦" },
  { numero: 22, nombre: "Ataúd", emoji: "⚰️" },
  { numero: 23, nombre: "Mono", emoji: "🐒" },
  { numero: 24, nombre: "Sapo", emoji: "🐸" },
  { numero: 25, nombre: "Balanza", emoji: "⚖️" },
  { numero: 26, nombre: "Bandera", emoji: "🇦🇷" },
  { numero: 27, nombre: "Juego", emoji: "🏃" },
  { numero: 28, nombre: "Gallo", emoji: "🐓" },
  { numero: 29, nombre: "Padre", emoji: "👨" },
  { numero: 30, nombre: "Bolo", emoji: "🍺" },
  { numero: 31, nombre: "Alacrán", emoji: "🦂" },
  { numero: 32, nombre: "Culebra", emoji: "🐍" },
  { numero: 33, nombre: "Carpintero", emoji: "🔨" },
  { numero: 34, nombre: "Música", emoji: "🎶" },
  { numero: 35, nombre: "Virgen", emoji: "🙏" },
  { numero: 36, nombre: "Viejita", emoji: "👵" },
  { numero: 37, nombre: "Suerte", emoji: "🍀" },
  { numero: 38, nombre: "Pistola", emoji: "🔫" },
  { numero: 39, nombre: "Jabón", emoji: "🧼" },
  { numero: 40, nombre: "Cielo", emoji: "🌌" },
  { numero: 41, nombre: "Novia", emoji: "👰" },
  { numero: 42, nombre: "Madre", emoji: "👩‍👧" },
  { numero: 43, nombre: "Pantera", emoji: "🐆" },
  { numero: 44, nombre: "Mesa", emoji: "🪑" },
  { numero: 45, nombre: "Iglesia", emoji: "⛪" },
  { numero: 46, nombre: "Familia", emoji: "👨‍👩‍👧‍👦" },
  { numero: 47, nombre: "Banco", emoji: "🏦" },
  { numero: 48, nombre: "Estrella", emoji: "🌟" },
  { numero: 49, nombre: "Sombra", emoji: "👤" },
  { numero: 50, nombre: "Luna Nueva", emoji: "🌙" },
  { numero: 51, nombre: "Policía", emoji: "👮" },
  { numero: 52, nombre: "Zorrillo", emoji: "🦨" },
  { numero: 53, nombre: "Llanta", emoji: "🛞" },
  { numero: 54, nombre: "Licor", emoji: "🍾" },
  { numero: 55, nombre: "Olas", emoji: "🌊" },
  { numero: 56, nombre: "Árbol", emoji: "🌳" },
  { numero: 57, nombre: "Cuchillo", emoji: "🔪" },
  { numero: 58, nombre: "Venado", emoji: "🦌" },
  { numero: 59, nombre: "Selva", emoji: "🌴" },
  { numero: 60, nombre: "Dragón", emoji: "🐉" },
  { numero: 61, nombre: "Guerra", emoji: "🪖" },
  { numero: 62, nombre: "Lagarto", emoji: "🦎" },
  { numero: 63, nombre: "Coco", emoji: "🥥" },
  { numero: 64, nombre: "Muebles", emoji: "🚪" },
  { numero: 65, nombre: "Pintura", emoji: "🖼️" },
  { numero: 66, nombre: "Diablo", emoji: "😈" },
  { numero: 67, nombre: "Vaca", emoji: "🐄" },
  { numero: 68, nombre: "Ladrón", emoji: "🏃‍♂️" },
  { numero: 69, nombre: "Soldado", emoji: "💂" },
  { numero: 70, nombre: "Oro", emoji: "🏆" },
  { numero: 71, nombre: "Zapatos", emoji: "👢" },
  { numero: 72, nombre: "Arco", emoji: "🏹" },
  { numero: 73, nombre: "Fuego", emoji: "🔥" },
  { numero: 74, nombre: "Edificio", emoji: "🏢" },
  { numero: 75, nombre: "Reina", emoji: "👸" },
  { numero: 76, nombre: "Palomas", emoji: "🕊️" },
  { numero: 77, nombre: "Humo", emoji: "🚬" },
  { numero: 78, nombre: "Tienda", emoji: "🏪" },
  { numero: 79, nombre: "Flores", emoji: "💐" },
  { numero: 80, nombre: "Café", emoji: "☕" },
  { numero: 81, nombre: "Rieles", emoji: "🛤️" },
  { numero: 82, nombre: "Escuela", emoji: "🏫" },
  { numero: 83, nombre: "Bote", emoji: "🚣" },
  { numero: 84, nombre: "Coronas", emoji: "👑" },
  { numero: 85, nombre: "Casa", emoji: "🏠" },
  { numero: 86, nombre: "Reloj", emoji: "⏳" },
  { numero: 87, nombre: "León", emoji: "🦁" },
  { numero: 88, nombre: "Platos", emoji: "🍽️" },
  { numero: 89, nombre: "Búho", emoji: "🦉" },
  { numero: 90, nombre: "Lentes", emoji: "👓" },
  { numero: 91, nombre: "Tortuga", emoji: "🐢" },
  { numero: 92, nombre: "Águila", emoji: "🦅" },
  { numero: 93, nombre: "Cartero", emoji: "📬" },
  { numero: 94, nombre: "Carro", emoji: "🚗" },
  { numero: 95, nombre: "Costurera", emoji: "🧵" },
  { numero: 96, nombre: "Dinero", emoji: "💰" },
  { numero: 97, nombre: "Viejito", emoji: "👴" },
  { numero: 98, nombre: "Bailes", emoji: "💃" },
  { numero: 99, nombre: "Aretes", emoji: "👂" },
];

/** El símbolo de un número, o `undefined` si se sale del rango. */
export function simbolo(n: number): Simbolo | undefined {
  return SIMBOLOS[n];
}

/** «03 · Muerto 💀», para títulos y lectores de pantalla. */
export function rotuloSimbolo(n: number): string {
  const s = SIMBOLOS[n];
  return s ? `${s.nombre} ${s.emoji}` : "";
}

/**
 * Las agrupaciones.
 *
 * QUÉ RESUELVEN
 * -------------
 * «Póngame cien a todos los animales» es una venta real y hoy son catorce
 * toques, uno por número, con la lista en la cabeza. Un grupo la convierte en
 * un toque y un monto.
 *
 * CÓMO SE DECIDIÓ QUÉ VA EN CADA UNO
 * ----------------------------------
 * Por lo que la figura ES, no por lo que sugiere. «Pantera» y «León» son
 * animales aunque también sean fuerza; «Dragón» va en animales aunque no
 * exista. Así el vendedor puede predecir el contenido sin abrir la lista, que
 * es lo único que hace útil a un grupo.
 *
 * UN NÚMERO PUEDE ESTAR EN VARIOS GRUPOS
 * --------------------------------------
 * «Boda» es gente y es celebración. No se fuerza una clasificación única
 * porque el vendedor no piensa en taxonomías: piensa en lo que le pidieron.
 * Lo que sí se comprueba en la prueba es que ningún grupo quede vacío y que
 * todos sus números existan.
 */
export type Grupo = {
  id: string;
  /** Lo que se lee en el botón. */
  nombre: string;
  /** Una figura que representa al grupo, para reconocerlo sin leer. */
  emoji: string;
  numeros: number[];
};

export const GRUPOS: Grupo[] = [
  /*
   * Los pares van PRIMEROS y no ordenados entre los demás, porque no son lo
   * mismo: los otros agrupan por lo que la figura representa y éste por cómo
   * es el número. Quien busca «animales» lee la figura; quien pide «todos los
   * pares» ya está pensando en cifras. Ponerlo al principio evita que se
   * busque entre temas.
   *
   * EL CERO ES PAR, y por eso el 00 entra. La duda es razonable —hay quien
   * cuenta del 1 al 99— pero aquí se decide por la cifra y no por costumbre:
   * un grupo cuya regla no se puede enunciar en una frase es un grupo en el
   * que el vendedor deja de confiar. La regla es «los que terminan en 0, 2, 4,
   * 6 y 8», y el 00 termina en 0.
   */
  {
    id: "pares",
    nombre: "Pares",
    emoji: "2️⃣",
    numeros: Array.from({ length: 50 }, (_, i) => i * 2),
  },
  {
    id: "animales",
    nombre: "Animales",
    emoji: "🐾",
    numeros: [
      4, 6, 8, 11, 12, 13, 15, 19, 21, 23, 24, 28, 31, 32, 43, 52, 58, 60, 62, 67, 76, 87, 89,
      91, 92,
    ],
  },
  {
    id: "personas",
    nombre: "Personas",
    emoji: "👥",
    numeros: [2, 5, 9, 16, 17, 29, 36, 41, 42, 46, 49, 51, 69, 75, 84, 95, 97],
  },
  {
    id: "dinero",
    nombre: "Dinero",
    emoji: "💰",
    numeros: [47, 70, 78, 96],
  },
  {
    id: "muerte",
    nombre: "Muerte y peligro",
    emoji: "💀",
    numeros: [3, 7, 22, 31, 32, 38, 57, 61, 66, 68, 73],
  },
  {
    id: "casa",
    nombre: "Casa y objetos",
    emoji: "🏠",
    numeros: [10, 20, 33, 44, 53, 64, 65, 71, 74, 82, 85, 86, 88, 90, 99],
  },
  {
    id: "naturaleza",
    nombre: "Naturaleza",
    emoji: "🌳",
    numeros: [37, 40, 48, 50, 55, 56, 59, 63, 79],
  },
  {
    id: "fe",
    nombre: "Fe",
    emoji: "🙏",
    numeros: [18, 35, 45, 66],
  },
  {
    id: "fiesta",
    nombre: "Fiesta",
    emoji: "🎶",
    numeros: [14, 27, 30, 34, 54, 80, 98],
  },
];

/** Los números de un grupo, o vacío si el id no existe. */
export function numerosDe(id: string): number[] {
  return GRUPOS.find((g) => g.id === id)?.numeros ?? [];
}
