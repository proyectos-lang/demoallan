import { NextResponse, type NextRequest } from "next/server";

import { deserializar, inicioSegunRol, NOMBRE_COOKIE } from "@/lib/sesion";

/**
 * Portero de cada petición.
 *
 * En Next 16 este archivo se llama `proxy.ts` y la función `proxy` (antes eran
 * `middleware.ts` / `middleware`). Corre siempre en runtime Node.js, que es lo
 * que permite verificar aquí la firma HMAC de la sesión.
 *
 * Desde que los usuarios viven en `allan.usuario` y no en Supabase Auth, no hay
 * token que refrescar: la cookie la firma este mismo servidor y verificarla es
 * puro cálculo local, sin viaje de red.
 */

/**
 * Rutas que se sirven sin sesión: el acceso y la consulta pública de
 * resultados. `/r/<fecha>` ya queda fuera del matcher, pero `/r` a secas —la
 * URL que uno teclea o comparte— sí llega hasta aquí, así que la comprobación
 * vive en código y no en la regex del matcher, donde es fácil de leer mal.
 */
function esPublica(ruta: string): boolean {
  return ruta === "/r" || ruta.startsWith("/r/") || ruta.startsWith("/login");
}

/** Lo que puede tocar cada rol. Un vendedor sólo ve lo suyo. */
function permitida(ruta: string, rol: string): boolean {
  if (rol === "vendedor") {
    return ruta.startsWith("/mi-venta") || ruta.startsWith("/clave");
  }
  // El resto de perfiles no entra en la pantalla del vendedor, que está atada
  // a un vendedor concreto y para ellos no significa nada.
  return !ruta.startsWith("/mi-venta");
}

export async function proxy(request: NextRequest) {
  const ruta = request.nextUrl.pathname;
  const sesion = deserializar(request.cookies.get(NOMBRE_COOKIE)?.value);

  if (!sesion) {
    if (esPublica(ruta)) return NextResponse.next();
    const destino = request.nextUrl.clone();
    destino.pathname = "/login";
    return NextResponse.redirect(destino);
  }

  // Con sesión, el acceso no tiene sentido: se va a donde le toca a su rol.
  if (ruta.startsWith("/login")) {
    const destino = request.nextUrl.clone();
    destino.pathname = inicioSegunRol(sesion.rol);
    return NextResponse.redirect(destino);
  }

  if (!esPublica(ruta) && !permitida(ruta, sesion.rol)) {
    const destino = request.nextUrl.clone();
    destino.pathname = inicioSegunRol(sesion.rol);
    return NextResponse.redirect(destino);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Todo salvo estáticos, imágenes y `/r/<fecha>`. `/r` a secas sí entra, y
     * lo resuelve `esPublica`.
     */
    "/((?!_next/static|_next/image|favicon.ico|r/|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
