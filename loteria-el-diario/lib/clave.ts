import "server-only";

import { randomInt } from "node:crypto";

/**
 * Alfabeto sin caracteres que se confunden al dictar: nada de l/1, o/0, i/j.
 * Una contraseña que hay que deletrear tres veces acaba escrita en un papel
 * pegado al mostrador, que es peor que una contraseña corta.
 */
const ALFABETO = "abcdefghkmnpqrstuvwxyz23456789";

/**
 * Contraseña temporal para entregar en mano.
 *
 * `randomInt` de `node:crypto` y no `Math.random()`: el segundo es predecible a
 * partir de unas pocas salidas, y estas contraseñas se generan en serie al dar
 * de alta vendedores.
 *
 * Vive fuera de los archivos `"use server"` porque allí toda exportación tiene
 * que ser una función asíncrona expuesta al cliente, y esto no debe serlo.
 */
export function generarContrasena(largo = 10): string {
  let s = "";
  for (let i = 0; i < largo; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return s;
}
