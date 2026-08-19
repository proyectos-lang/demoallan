"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
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
 *
 * QUIÉN VENDE A NOMBRE DE QUIÉN
 * -----------------------------
 * `p_vendedor_id` llega del navegador, así que no se puede creer. Mientras los
 * usuarios vivían en Supabase Auth esto lo ataja la base: `fn_registrar_ticket`
 * comparaba contra el vendedor del JWT y rechazaba con «No puede registrar
 * ventas a nombre de otro vendedor». Sin JWT esa comprobación no tiene de dónde
 * leer y deja pasar, así que se hace aquí:
 *
 *   · un vendedor vende SIEMPRE como él mismo, se mande lo que se mande;
 *   · los perfiles administrativos sí pueden elegir, que es para lo que existe
 *     el selector de la pantalla de punto de venta.
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

  const sesion = await sesionActual();
  if (!sesion) {
    return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  }

  let vendedorEfectivo = vendedorId;

  if (sesion.rol === "vendedor") {
    if (!sesion.vendedor_id) {
      return { ok: false, mensaje: "Su cuenta no está enlazada a ningún vendedor." };
    }
    vendedorEfectivo = sesion.vendedor_id;
  } else if (sesion.rol !== "administrador" && sesion.rol !== "digitador") {
    // Un auditor lee, no vende.
    return { ok: false, mensaje: "Su perfil no puede registrar ventas." };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorEfectivo,
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
  revalidatePath("/mi-venta");
  return { ok: true, folio: fila.ticket_folio, total: Number(fila.ticket_total) };
}
