import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Refresco de sesión en cada petición.
 *
 * En Next 16 este archivo se llama `proxy.ts` y la función se llama `proxy`
 * (antes eran `middleware.ts` / `middleware`). Corre siempre en runtime
 * Node.js; el runtime edge no está soportado aquí.
 *
 * `getUser()` no es opcional ni decorativo: es lo que revalida el token contra
 * Supabase. Leer la sesión de la cookie sin más confiaría en un dato que el
 * navegador puede manipular.
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

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: "allan" },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          // Estas cabeceras impiden que un CDN cachee una respuesta que
          // establece cookies de sesión: sin ellas, el token de un usuario
          // puede acabar servido a otro.
          for (const [clave, valor] of Object.entries(headers)) {
            response.headers.set(clave, valor);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Sin sesión sólo se llega al acceso y a la consulta pública de resultados.
  if (!user && !esPublica(request.nextUrl.pathname)) {
    const destino = request.nextUrl.clone();
    destino.pathname = "/login";
    return NextResponse.redirect(destino);
  }

  // Con sesión, el login no tiene sentido.
  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const destino = request.nextUrl.clone();
    destino.pathname = "/tablero";
    return NextResponse.redirect(destino);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Todo salvo estáticos, imágenes y `/r/<fecha>`. Excluir aquí las páginas
     * de resultados les ahorra la llamada a `getUser()`, que es un viaje de
     * red por petición. `/r` a secas sí entra, y lo resuelve `esPublica`.
     */
    "/((?!_next/static|_next/image|favicon.ico|r/|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
