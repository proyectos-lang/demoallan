"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Un vendedor anula una venta suya.
 *
 * DOS LÍMITES, Y NINGUNO VIVE EN LA PANTALLA
 * ------------------------------------------
 * 1. SÓLO LO SUYO. El ticket llega del navegador, así que no se puede creer.
 *    Se comprueba aquí que sea de este vendedor —con el identificador de la
 *    SESIÓN, no de la petición— antes de tocar nada.
 *
 * 2. SÓLO CON EL SORTEO ABIERTO. Eso no se comprueba aquí: lo hace
 *    `fn_anular_ticket`, que rechaza fuera de un sorteo abierto salvo que se
 *    le pase `p_forzar`. Esta acción NO la pasa nunca — es la bandera que
 *    administración usa para corregir un duplicado descubierto tarde, y darle
 *    acceso desde aquí convertiría «me equivoqué» en «esta apuesta ya sé que
 *    perdió».
 *
 * Que el botón sólo aparezca en las filas de sorteos abiertos es comodidad de
 * la pantalla, no la regla. La regla está en la base.
 */

export type ResultadoAnulacion =
  | { ok: true; mensaje: string }
  | { ok: false; mensaje: string };

export async function anularMiVenta(
  ticketId: string,
  motivo: string,
): Promise<ResultadoAnulacion> {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) {
    return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  }

  const supabase = await crearClienteServidor();

  /*
   * ¿Es suyo? Se pregunta ANTES de intentar la anulación.
   *
   * La base también lo comprobaría —`fn_anular_ticket` compara el vendedor—
   * pero bajo `service_role` esa guarda no corre: `fn_es_servicio()` es cierto
   * y el bloque se salta entero. Aquí es el único sitio donde se sabe quién
   * está pidiendo esto.
   */
  const { data: ticket } = await supabase
    .from("ticket")
    .select("id, folio, vendedor_id, anulado_en")
    .eq("id", ticketId)
    .maybeSingle();

  // Mismo mensaje para «no existe» y «no es suyo»: distinguirlos convertiría
  // esto en una forma de averiguar qué tickets hay.
  if (!ticket || ticket.vendedor_id !== sesion.vendedor_id) {
    return { ok: false, mensaje: "No se encontró esa venta." };
  }

  if (ticket.anulado_en !== null) {
    return { ok: false, mensaje: "Esa venta ya estaba anulada." };
  }

  const { error } = await supabase.rpc("fn_anular_ticket", {
    p_ticket_id: ticketId,
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
    // Nunca. Es lo que mantiene la anulación del vendedor dentro del sorteo
    // abierto, sin depender de que la pantalla oculte el botón.
    p_forzar: false,
  });

  if (error) {
    if (error.code === "PGRST203") {
      return {
        ok: false,
        mensaje:
          "Hay dos versiones de la función de anulación en la base. Falta aplicar la migración 0067.",
      };
    }
    // El rechazo por sorteo cerrado llega como excepción de la base. Se
    // traduce a algo que el vendedor pueda entender sin saber qué es un
    // «estado»: la venta se queda, y sabe a quién pedirle que la quite.
    if (/sorteo abierto|está cerrado|está liquidado/i.test(error.message)) {
      return {
        ok: false,
        mensaje:
          "Ese sorteo ya cerró, así que esta venta no se puede quitar desde aquí. Avise a administración.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  // Las dos pantallas del vendedor que muestran esa venta.
  revalidatePath("/mi-dia");
  revalidatePath("/mi-venta");

  return {
    ok: true,
    mensaje: `Venta ${ticket.folio} anulada. Los números vuelven a estar disponibles.`,
  };
}
