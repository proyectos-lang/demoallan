/**
 * La simbología dice lo que tiene que decir.
 *
 * POR QUÉ ESTO NECESITA UNA PRUEBA
 * --------------------------------
 * Una tabla de cien filas escritas a mano tiene un modo de fallar que no se
 * ve: si una fila se cuela o se pierde, TODO lo que va detrás se desplaza una
 * posición. La rejilla seguiría pintándose perfecta, cada número con un
 * símbolo bonito al lado, y estaría mintiendo de la fila 34 en adelante. El
 * vendedor vendería «vaca» y saldría el 68.
 *
 * Por eso aquí se comprueba el contenido contra la lista que dio el cliente,
 * fila por fila, y no sólo que haya cien.
 *
 * Esta prueba no toca la base: la simbología vive en el cliente a propósito
 * —cambiar un emoji no puede obligar a una migración—.
 *
 *     node supabase/pruebas/simbologia.mjs
 */
import { readFileSync } from "node:fs";

let ok = 0;
let fallos = 0;
const check = (n, c, d = "") => {
  if (c) {
    ok++;
    console.log(`  ok    ${n}`);
  } else {
    fallos++;
    console.log(`  FALLA ${n} ${d}`);
  }
};

// El archivo es TypeScript, así que no se puede importar sin compilar. Se lee
// y se extrae con expresiones regulares: basta para comprobar el contenido, y
// evita meter un paso de compilación en una prueba.
const fuente = readFileSync(new URL("../../lib/pos/simbologia.ts", import.meta.url), "utf8");

const filas = [
  ...fuente.matchAll(
    /\{\s*numero:\s*([0-9]+),\s*nombre:\s*"([^"]+)",\s*emoji:\s*"([^"]+)"\s*\}/g,
  ),
].map((m) => ({ numero: Number(m[1]), nombre: m[2], emoji: m[3] }));

console.log(`Leídas ${filas.length} filas de lib/pos/simbologia.ts\n`);

// ---------------------------------------------------------------------------
// 1. Los cien, en su sitio.
// ---------------------------------------------------------------------------
console.log("--- Los cien números ---");

check("hay exactamente cien símbolos", filas.length === 100, `${filas.length}`);

const desordenadas = filas.filter((f, i) => f.numero !== i);
check(
  "cada fila está en la posición de su número",
  desordenadas.length === 0,
  desordenadas.length ? `primera en desorden: ${JSON.stringify(desordenadas[0])}` : "",
);

const numeros = new Set(filas.map((f) => f.numero));
check("no falta ningún número del 0 al 99", numeros.size === 100, `${numeros.size} distintos`);

const sinNombre = filas.filter((f) => !f.nombre.trim());
check("ninguno se quedó sin nombre", sinNombre.length === 0, `${sinNombre.length}`);

const sinEmoji = filas.filter((f) => !f.emoji.trim());
check("ninguno se quedó sin figura", sinEmoji.length === 0, `${sinEmoji.length}`);

// ---------------------------------------------------------------------------
// 2. Contra la lista que dio el cliente. Es la comprobación que importa.
// ---------------------------------------------------------------------------
console.log("\n--- Contra la lista original ---");

// Transcrita del mensaje del cliente. Si alguien cambia la tabla, esto lo ve.
const ESPERADO = `00 Avión|01 Pies|02 Mujer|03 Muerto|04 Tigre|05 Embarazada|06 Elefante|
07 Navaja|08 Conejo|09 Hombre|10 Anillo|11 Perro|12 Caballo|13 Gato|14 Boda|15 Ratón|
16 Niña|17 Joven|18 Ángel|19 Mariposa|20 Espejo|21 Pájaro|22 Ataúd|23 Mono|24 Sapo|
25 Balanza|26 Bandera|27 Juego|28 Gallo|29 Padre|30 Bolo|31 Alacrán|32 Culebra|
33 Carpintero|34 Música|35 Virgen|36 Viejita|37 Suerte|38 Pistola|39 Jabón|40 Cielo|
41 Novia|42 Madre|43 Pantera|44 Mesa|45 Iglesia|46 Familia|47 Banco|48 Estrella|
49 Sombra|50 Luna Nueva|51 Policía|52 Zorrillo|53 Llanta|54 Licor|55 Olas|56 Árbol|
57 Cuchillo|58 Venado|59 Selva|60 Dragón|61 Guerra|62 Lagarto|63 Coco|64 Muebles|
65 Pintura|66 Diablo|67 Vaca|68 Ladrón|69 Soldado|70 Oro|71 Zapatos|72 Arco|73 Fuego|
74 Edificio|75 Reina|76 Palomas|77 Humo|78 Tienda|79 Flores|80 Café|81 Rieles|
82 Escuela|83 Bote|84 Coronas|85 Casa|86 Reloj|87 León|88 Platos|89 Búho|90 Lentes|
91 Tortuga|92 Águila|93 Cartero|94 Carro|95 Costurera|96 Dinero|97 Viejito|98 Bailes|
99 Aretes`
  .replace(/\n/g, "")
  .split("|")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(" ");
    return { numero: Number(s.slice(0, i)), nombre: s.slice(i + 1) };
  });

check("la lista de referencia tiene cien entradas", ESPERADO.length === 100, `${ESPERADO.length}`);

const discrepancias = [];
for (const e of ESPERADO) {
  const f = filas[e.numero];
  if (!f || f.nombre !== e.nombre)
    discrepancias.push(`${String(e.numero).padStart(2, "0")}: esperado «${e.nombre}», dice «${f?.nombre ?? "—"}»`);
}
check(
  "cada número tiene el nombre que dio el cliente",
  discrepancias.length === 0,
  discrepancias.slice(0, 5).join(" · "),
);

// Los que más duelen si se desplazan: se nombran uno por uno para que el
// fallo diga cuál, no «algo cambió».
for (const [n, nombre] of [
  [3, "Muerto"],
  [30, "Bolo"],
  [67, "Vaca"],
  [94, "Carro"],
  [96, "Dinero"],
  [99, "Aretes"],
])
  check(`el ${String(n).padStart(2, "0")} es «${nombre}»`, filas[n]?.nombre === nombre, filas[n]?.nombre);

// ---------------------------------------------------------------------------
// 3. Las agrupaciones.
// ---------------------------------------------------------------------------
console.log("\n--- Las agrupaciones ---");

const bloque = fuente.slice(fuente.indexOf("export const GRUPOS"));

/*
 * Los números de un grupo pueden venir de dos formas, y las dos hay que
 * entenderlas: una lista escrita a mano —`[4, 6, 8, …]`— o una expresión que
 * los genera, como hacen los pares. Escribir cincuenta pares a mano sería
 * pedir una errata; leerlos aquí obliga a evaluar la expresión.
 *
 * `Function` y no `eval` para que no vea el ámbito de esta prueba: lo que se
 * evalúa es un trozo del código fuente del proyecto, y conviene que no pueda
 * tocar nada de aquí.
 */
const grupos = [
  ...bloque.matchAll(
    /id:\s*"([a-z]+)",\s*\n\s*nombre:\s*"([^"]+)",\s*\n\s*emoji:\s*"([^"]+)",\s*\n\s*numeros:\s*([^\n]*(?:\n(?!\s*\})[^\n]*)*)/g,
  ),
].map((m) => {
  const crudo = m[4].trim().replace(/,\s*$/, "");
  let numeros = [];
  try {
    numeros = Function(`"use strict"; return (${crudo});`)();
  } catch {
    numeros = [];
  }
  return { id: m[1], nombre: m[2], numeros: Array.isArray(numeros) ? numeros : [] };
});

console.log(`  (${grupos.length} grupos: ${grupos.map((g) => g.id).join(", ")})`);

check("hay agrupaciones definidas", grupos.length > 0, `${grupos.length}`);

const vacios = grupos.filter((g) => g.numeros.length === 0);
check("ningún grupo está vacío", vacios.length === 0, vacios.map((g) => g.id).join(", "));

const fueraDeRango = grupos.flatMap((g) =>
  g.numeros.filter((x) => x < 0 || x > 99).map((x) => `${g.id}:${x}`),
);
check(
  "ningún grupo apunta a un número que no existe",
  fueraDeRango.length === 0,
  fueraDeRango.join(", "),
);

const conRepetidos = grupos.filter((g) => new Set(g.numeros).size !== g.numeros.length);
check(
  "ningún grupo repite un número dentro de sí mismo",
  conRepetidos.length === 0,
  conRepetidos.map((g) => g.id).join(", "),
);

const ids = grupos.map((g) => g.id);
check("los identificadores no se repiten", new Set(ids).size === ids.length, ids.join(", "));

// Un grupo que prometa «animales» y traiga el 96 —Dinero— sería peor que no
// tenerlo: el vendedor confía en él y le cobra de más al cliente.
const animales = grupos.find((g) => g.id === "animales");
if (animales) {
  const deberian = [4, 11, 13, 24, 67, 87, 92];
  const faltan = deberian.filter((x) => !animales.numeros.includes(x));
  check(
    "«animales» trae tigre, perro, gato, sapo, vaca, león y águila",
    faltan.length === 0,
    `faltan ${faltan.join(", ")}`,
  );
  const intrusos = [96, 85, 3].filter((x) => animales.numeros.includes(x));
  check(
    "y no trae dinero, casa ni muerto",
    intrusos.length === 0,
    `cuela ${intrusos.join(", ")}`,
  );
}

/*
 * Los pares. Son los DOBLES: las dos cifras iguales —00, 11, 22, … 99—, diez
 * numeros. Es el unico grupo cuya regla se puede comprobar entera, asi que se
 * comprueba entera. Si alguien toca esa linea, aqui se ve.
 */
const pares = grupos.find((g) => g.id === "pares");
if (pares) {
  check("«pares» trae diez numeros", pares.numeros.length === 10, `${pares.numeros.length}`);
  check(
    "todos son dobles (las dos cifras iguales)",
    pares.numeros.every((x) => {
      const [a, b] = String(x).padStart(2, "0");
      return a === b;
    }),
    pares.numeros.join(", "),
  );
  check(
    "son exactamente 00,11,…,99",
    [0, 11, 22, 33, 44, 55, 66, 77, 88, 99].every((x) => pares.numeros.includes(x)),
    pares.numeros.join(", "),
  );
  check(
    "no se cuela ningun no-doble",
    ![2, 10, 50, 98].some((x) => pares.numeros.includes(x)),
    "",
  );
  // El 00 entra (es el doble del cero) y el 99 es el ultimo. Se fija aqui para
  // que el dia que alguien lo cambie sea una decision y no un descuido.
  check("el 00 esta dentro", pares.numeros.includes(0), "");
  check("y el 99 tambien, que es el ultimo", pares.numeros.includes(99), "");
} else {
  check("existe el grupo de pares", false, "no esta definido");
}

const dinero = grupos.find((g) => g.id === "dinero");
if (dinero)
  check("«dinero» incluye el 96, que es Dinero", dinero.numeros.includes(96), dinero.numeros.join(","));

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
