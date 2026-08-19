import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Sesión propia, firmada por el servidor.
 *
 * Sustituye a la de Supabase Auth. La cookie lleva los datos en claro y una
 * firma HMAC: no se cifra nada porque no hay nada secreto ahí dentro —el
 * identificador y el rol del usuario ya los conoce quien tiene la sesión—, pero
 * sin la firma cualquiera podría editarla y ascenderse a administrador.
 *
 * `httpOnly` impide que un script del navegador la lea; `sameSite: lax` corta
 * el envío desde otro sitio, que es lo que hace posible un CSRF.
 */

const COOKIE = "diario_sesion";
const DURACION = 60 * 60 * 12; // doce horas: una jornada larga, no más

export type Sesion = {
  id: string;
  nombre: string;
  rol: "administrador" | "auditor" | "digitador" | "vendedor";
  vendedor_id: string | null;
  /** Vencimiento en segundos desde época. */
  exp: number;
};

function secreto(): string {
  const s = process.env.SESION_SECRETO;
  if (!s || s.length < 32) {
    throw new Error(
      "Falta SESION_SECRETO en el entorno (32 caracteres o más). Sin él las sesiones no se pueden firmar.",
    );
  }
  return s;
}

function firmar(cuerpo: string): string {
  return createHmac("sha256", secreto()).update(cuerpo).digest("base64url");
}

/**
 * Comparación en tiempo constante. Una comparación normal se detiene en el
 * primer byte distinto, y ese tiempo revela cuántos bytes se acertaron: basta
 * para reconstruir una firma válida byte a byte.
 */
function firmaValida(cuerpo: string, firma: string): boolean {
  const esperada = Buffer.from(firmar(cuerpo));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(esperada, recibida);
}

export function serializar(s: Sesion): string {
  const cuerpo = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${cuerpo}.${firmar(cuerpo)}`;
}

export function deserializar(valor: string | undefined): Sesion | null {
  if (!valor) return null;
  const corte = valor.lastIndexOf(".");
  if (corte < 1) return null;

  const cuerpo = valor.slice(0, corte);
  const firma = valor.slice(corte + 1);
  if (!firmaValida(cuerpo, firma)) return null;

  try {
    const s = JSON.parse(Buffer.from(cuerpo, "base64url").toString()) as Sesion;
    // El vencimiento se comprueba aquí y no sólo con `maxAge`: la cookie la
    // manda el navegador y podría reenviarse pasada su fecha.
    if (typeof s.exp !== "number" || s.exp * 1000 < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

/** Abre la sesión. Se llama desde una acción de servidor, nunca desde una página. */
export async function abrirSesion(datos: Omit<Sesion, "exp">) {
  const s: Sesion = { ...datos, exp: Math.floor(Date.now() / 1000) + DURACION };
  const almacen = await cookies();
  almacen.set(COOKIE, serializar(s), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DURACION,
  });
}

export async function cerrarSesion() {
  const almacen = await cookies();
  almacen.delete(COOKIE);
}

/** La sesión de la petición en curso, o `null`. */
export async function sesionActual(): Promise<Sesion | null> {
  const almacen = await cookies();
  return deserializar(almacen.get(COOKIE)?.value);
}

/** Nombre de la cookie, para que el proxy la lea sin importar este módulo entero. */
export const NOMBRE_COOKIE = COOKIE;

/** A dónde entra cada rol. Un vendedor no tiene nada que hacer en el tablero. */
export function inicioSegunRol(rol: Sesion["rol"]): string {
  return rol === "vendedor" ? "/mi-venta" : "/tablero";
}
