/**
 * Qué versión del sistema está corriendo.
 *
 * DE DÓNDE SALE
 * -------------
 * Del commit con el que Vercel construyó el paquete. Es el identificador que
 * ya existe y que cambia exactamente cuando cambia el código: no hay que
 * acordarse de subir un número a mano en cada publicación, que es la clase de
 * paso que se olvida justo el día que importa.
 *
 * `NEXT_PUBLIC_` porque tiene que llegar al navegador: es el aparato del
 * vendedor el que compara lo que tiene cargado con lo que el servidor sirve
 * ahora. Next sustituye estas variables en tiempo de compilación, así que el
 * valor queda cocido dentro del paquete —que es justo lo que se necesita: la
 * pantalla abierta desde hace tres horas sigue diciendo la versión con la que
 * se cargó, no la de ahora—.
 *
 * EN DESARROLLO NO HAY SHA
 * ------------------------
 * `npm run dev` no define nada de esto. Se devuelve `"dev"`, y el aviso queda
 * desactivado: en local se recarga a mano y un cartel de actualizar cada vez
 * que Next recompila sería puro ruido.
 */
export const VERSION: string =
  process.env.NEXT_PUBLIC_VERSION ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
  "dev";

/** Si esta compilación puede comparar versiones. En local, no. */
export const VERSION_CONOCIDA = VERSION !== "dev";
