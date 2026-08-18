import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "./tipos";

/**
 * Cliente para Server Components, Route Handlers y Server Actions.
 *
 * Actúa siempre con la identidad del usuario autenticado, así que **toda**
 * consulta pasa por RLS. Es el cliente por defecto: si algo se puede hacer con
 * este, no se usa el de servicio.
 *
 * En Next 16 `cookies()` es asíncrono, de ahí el `await`.
 */
export async function crearClienteServidor() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: "allan" },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Los Server Components no pueden escribir cookies. Se ignora
            // porque el refresco de sesión lo hace `proxy.ts` en cada
            // petición; aquí sólo se leería una cookie ya renovada.
          }
        },
      },
    },
  );
}
