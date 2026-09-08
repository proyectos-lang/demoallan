"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Anular una venta desde el detalle de administración.
 *
 * QUIÉN DECIDE QUE SE PUEDE FORZAR
 * --------------------------------
 * Esta función, y no el navegador. `p_forzar` es lo que permite anular sobre
 * un sorteo ya cerrado o liquidado, así que si viniera del cliente cualquiera
 * podría mandarlo: la base no puede distinguir, porque desde la 0024 la
 * aplicación habla como `service_role` y `fn_exige` retorna sin comprobar
 * nada. Aquí sí hay una sesión firmada delante, y es el único sitio del
 * sistema donde se sabe quién está pidiendo esto.
 *
 * ANULAR NO BORRA
 * ---------------
 * El ticket se marca como anulado, con quién y cuándo; no se hace `DELETE`. Es
 * deliberado y es lo que permite responder después «¿por qué falta esta
 * venta?» — un registro borrado no deja esa respuesta en ninguna parte, y ya
 * hubo una vez en que se borraron tickets de prueba con `DELETE` y el cupo se
 * quedó sin devolver, descuadrado, sin rastro de qué había pasado.
 */

export type ResultadoAnulacion =
  | { ok: true; mensaje: string }
  | { ok: false; mensaje: string };

export async function anularVenta(
  ticketId: string,
  motivo: string,
): Promise<ResultadoAnulacion> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede anular ventas." };
  }

  const supabase = await crearClienteServidor();

  const { error } = await supabase.rpc("fn_anular_ticket", {
    p_ticket_id: ticketId,
    // El motivo es opcional. Vacío se manda nulo y no una cadena en blanco:
    // en la bitácora, «sin motivo» y «motivo vacío» tienen que verse igual.
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
    /*
     * Siempre `true`, y sólo porque ya se comprobó el rol tres líneas arriba.
     *
     * Es lo que hace que un sorteo cerrado o liquidado se pueda corregir: un
     * duplicado se descubre auditando, y para entonces el día ya terminó. Lo
     * que NO abre esto es lo ya pagado — de eso se encarga la base, que
     * rechaza si el sorteo entró en un corte.
     */
    p_forzar: true,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "La anulación todavía no está habilitada en la base de datos. Falta aplicar la migración 0067.",
      };
    }
    if (error.code === "PGRST203") {
      return {
        ok: false,
        mensaje:
          "Hay dos versiones de la función de anulación en la base. Falta aplicar la migración 0067, que quita la vieja.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  // Las dos pantallas que muestran esa venta. El informe la deja de contar y
  // el tablero rehace sus totales; sin esto seguirían mostrando la venta
  // anulada hasta la siguiente recarga completa.
  revalidatePath("/informe");
  revalidatePath("/tablero");

  return { ok: true, mensaje: "Venta anulada. El cupo se devolvió y queda registrada en auditoría." };
}
