"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./tipos";

/**
 * Cliente para componentes de cliente — sobre todo el POS, que necesita
 * suscripciones en vivo al cupo y reintentar al recuperar la conexión.
 *
 * Sujeto a RLS igual que el de servidor. El registro de ventas no se hace
 * escribiendo tablas desde aquí, sino llamando a `allan.fn_registrar_ticket`,
 * que valida el cupo dentro de la transacción.
 */
export function crearClienteNavegador() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: "public" } },
  );
}
