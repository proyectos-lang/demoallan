"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Un vendedor corrige una venta suya.
 *
 * TRES LÍMITES, Y LOS TRES SE DECIDEN AQUÍ
 * ----------------------------------------
 * 1. SÓLO LO SUYO. El ticket llega del navegador, así que no se puede creer.
 *    Se comprueba que sea de este vendedor con el identificador de la SESIÓN,
 *    nunca con uno de la petición.
 *
 * 2. SÓLO CON EL SORTEO ABIERTO. Y esto es lo que distingue esta acción de la
 *    del administrador: `fn_editar_venta` NO mira el estado del sorteo, a
 *    propósito —un error se descubre auditando, y se audita cuando el día ya
 *    terminó—. Para el vendedor esa puerta tiene que estar cerrada, porque
 *    corregir después del cierre es corregir sabiendo el número ganador:
 *    «me equivoqué» se convertiría en «esta apuesta ya sé que perdió».
 *
 *    Como la base no lo impide, la comprobación vive aquí y hay que leerla
 *    como lo que es: la única cosa entre un vendedor y reescribir el pasado.
 *
 * 3. NI ANULADA NI VACÍA. Una venta anulada ya no existe para corregirla, y
 *    una corrección que deja el ticket sin números no es una corrección: es
 *    una anulación, y para eso está `anularMiVenta`, que devuelve el cupo y
 *    deja constancia de por qué.
 *
 * LO QUE SÍ HACE LA BASE
 * ----------------------
 * Todo lo demás, y es mucho: rehace el cupo entero —devuelve el viejo y
 * consume el nuevo—, vuelve a comprobar el tope del vendedor para que corregir
 * no sea la puerta por la que se salta el límite, congela de nuevo comisión y
 * factor, y guarda en la auditoría la jugada anterior entera. Esa última parte
 * es la que permite reconstruir después qué decía la tirilla que el cliente
 * tiene en la mano.
 */

export type LineaCorregida = { numero: number; monto: number };

export type ResultadoCorreccion =
  | { ok: true; total: number; lineas: number; folio: string; mensaje: string }
  | { ok: false; mensaje: string };

export async function corregirMiVenta(
  ticketId: string,
  lineas: LineaCorregida[],
  motivo: string,
): Promise<ResultadoCorreccion> {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) {
    return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  }

  if (lineas.length === 0) {
    return {
      ok: false,
      mensaje: "La venta tiene que quedar con al menos un número. Para dejarla sin nada, anúlela.",
    };
  }

  // Las mismas reglas que la base, para decirlo antes de ir al servidor. No la
  // sustituyen: quien decide de verdad es `fn_editar_venta`, con la fila de
  // cupo bloqueada.
  for (const l of lineas) {
    if (!Number.isInteger(l.numero) || l.numero < 0 || l.numero > 99) {
      return { ok: false, mensaje: `Número fuera de rango: ${l.numero}.` };
    }
    if (!(l.monto > 0)) {
      return {
        ok: false,
        mensaje: `El monto del número ${String(l.numero).padStart(2, "0")} tiene que ser mayor que cero.`,
      };
    }
  }

  const supabase = await crearClienteServidor();

  /*
   * ¿Es suyo, está vivo y su sorteo sigue abierto?
   *
   * Las tres en una sola consulta, ANTES de tocar nada. Bajo `service_role`
   * ninguna guarda de la base corre, así que éste es el único sitio donde se
   * sabe quién está pidiendo esto y en qué momento.
   */
  const { data: ticket } = await supabase
    .from("ticket")
    .select("id, folio, vendedor_id, anulado_en, sorteo:sorteo_id(estado, hora)")
    .eq("id", ticketId)
    .maybeSingle();

  // Mismo mensaje para «no existe» y «no es suyo»: distinguirlos convertiría
  // esto en una forma de averiguar qué tickets hay.
  if (!ticket || ticket.vendedor_id !== sesion.vendedor_id) {
    return { ok: false, mensaje: "No se encontró esa venta." };
  }

  if (ticket.anulado_en !== null) {
    return { ok: false, mensaje: "Esa venta está anulada; ya no se puede corregir." };
  }

  const sorteo = ticket.sorteo as unknown as { estado: string } | null;
  if (sorteo?.estado !== "abierto") {
    return {
      ok: false,
      mensaje:
        "Ese sorteo ya cerró, así que esta venta no se puede corregir desde aquí. Avise a administración.",
    };
  }

  const { data, error } = await supabase.rpc("fn_editar_venta", {
    p_ticket_id: ticketId,
    p_lineas: lineas.map((l) => ({ numero: l.numero, monto: l.monto })),
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "Corregir ventas todavía no está habilitado en la base de datos. Falta aplicar la migración 0075.",
      };
    }
    /*
     * El tope es el rechazo que de verdad se va a ver, porque corregir hacia
     * arriba es justo lo que lo topa. La base ya lo explica bien —dice cuánto
     * queda— así que se deja pasar su mensaje en vez de taparlo con uno
     * genérico.
     */
    return { ok: false, mensaje: error.message };
  }

  const r = data?.[0];
  if (!r) return { ok: false, mensaje: "No se pudo corregir la venta." };

  // Las pantallas del vendedor que muestran esa venta. La corrección cambia el
  // cupo, así que el punto de venta también tiene que volver a leerlo.
  revalidatePath("/mi-dia");
  revalidatePath("/mi-venta");

  return {
    ok: true,
    total: Number(r.r_total),
    lineas: r.r_lineas,
    folio: ticket.folio,
    mensaje: `Venta ${ticket.folio} corregida: ${r.r_lineas} ${r.r_lineas === 1 ? "número" : "números"}.`,
  };
}
