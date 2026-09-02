import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "./tipos";

/**
 * Cliente de servicio: ignora RLS.
 *
 * Reservado para tareas que no actúan en nombre de un usuario — el cron que
 * abre y cierra sorteos, el refresco de vistas materializadas y la siembra de
 * `cupo_numero`. Nunca se usa para atender una petición del navegador: si
 * necesitas datos de un usuario, usa `crearClienteServidor()` y deja que RLS
 * haga su trabajo.
 *
 * `server-only` hace que el build falle si este módulo termina importado desde
 * un componente de cliente, que filtraría la llave de servicio al navegador.
 */
export function crearClienteServicio() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el entorno.",
    );
  }

  return createClient<Database>(url, key, {
    db: { schema: "public" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
