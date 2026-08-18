"use server";

import { revalidatePath } from "next/cache";

import { crearClienteServidor } from "@/lib/supabase/server";

export type LineaVenta = { numero: number; monto: number };

export type ResultadoVenta =
  | { ok: true; folio: string; total: number }
  | { ok: false; mensaje: string };

/**
 * Registra un ticket.
 *
 * Toda la validación de cupo ocurre dentro de `fn_registrar_ticket`, en la
 * misma transacción y con la fila de cupo bloqueada. Lo que la pantalla muestra
 * mientras se teclea es orientativo: entre esa lectura y esta llamada el saldo
 * pudo haber cambiado, y aquí es donde se decide de verdad.
 */
export async function registrarTicket(
  sorteoId: string,
  vendedorId: string,
  lineas: LineaVenta[],
  coordenada?: { lat: number; lng: number },
): Promise<ResultadoVenta> {
  if (lineas.length === 0) {
    return { ok: false, mensaje: "El ticket no tiene líneas." };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_lineas: lineas,
    p_lat: coordenada?.lat ?? null,
    p_lng: coordenada?.lng ?? null,
  });

  if (error) {
    return { ok: false, mensaje: error.message };
  }

  const fila = data?.[0];
  if (!fila) {
    return { ok: false, mensaje: "La venta no devolvió folio." };
  }

  revalidatePath("/punto-de-venta");
  return { ok: true, folio: fila.ticket_folio, total: Number(fila.ticket_total) };
}
