"use server";

import type { TicketRegistrado } from "@/app/(admin)/punto-de-venta/acciones";
import type { SorteoPos, VendedorPos } from "@/lib/pos/use-pos";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Volver a sacar la tirilla de una venta ya registrada.
 *
 * REIMPRIMIR NO REGISTRA NADA.
 *
 * Esto sólo LEE. No crea ticket, no toca cupo, no mueve un lempira: se puede
 * llamar mil veces y la venta sigue siendo una. Se dice aquí porque es la
 * pregunta que va a hacer quien lea este archivo — un vendedor ya reportó una
 * vez que reimprimir le había duplicado una venta. Aquello resultó ser un
 * doble envío del formulario de registro, arreglado con `envio_id` en la 0056;
 * pero la conclusión vale igual: la vía que reimprime tiene que ser distinta
 * de la que registra, y ésta lo es.
 */

export type ResultadoReimpresion =
  | {
      ok: true;
      ticket: TicketRegistrado;
      sorteo: SorteoPos;
      vendedor: VendedorPos;
      /** Un ticket anulado se imprime igual, pero diciéndolo. */
      anulado: boolean;
    }
  | { ok: false; mensaje: string };

export async function reimprimirTicket(folio: string): Promise<ResultadoReimpresion> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };

  /*
   * EL VENDEDOR SALE DE LA SESIÓN, NUNCA DEL NAVEGADOR.
   *
   * Es toda la seguridad de esta acción. El folio sí llega del cliente, y con
   * él solo se podría pedir la tirilla de cualquiera: los números que juega
   * otro vendedor y cuánto le apuesta a cada uno. Atarlo al vendedor de la
   * sesión hace que un folio ajeno simplemente no aparezca.
   *
   * Administración pasa por la otra función, que no filtra por vendedor: ahí
   * la comprobación es el rol.
   */
  const supabase = await crearClienteServidor();

  const { data, error } = sesion.vendedor_id
    ? await supabase.rpc("fn_ticket_para_reimprimir", {
        p_folio: folio,
        p_vendedor_id: sesion.vendedor_id,
      })
    : sesion.rol === "administrador"
      ? await supabase.rpc("fn_ticket_para_reimprimir_admin", { p_folio: folio })
      : { data: null, error: null };

  if (error) {
    // La base todavía sin la 0066. Se dice qué falta en vez de dejar el
    // mensaje crudo de PostgREST, que no le sugiere nada a quien lo lee.
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "La reimpresión todavía no está habilitada en la base de datos. Avise a administración.",
      };
    }
    return { ok: false, mensaje: `No se pudo leer el ticket: ${error.message}` };
  }

  const t = data?.[0];
  // Mismo mensaje para «no existe» y «no es suyo», a propósito: distinguirlos
  // convertiría esto en una forma de averiguar qué folios existen.
  if (!t) return { ok: false, mensaje: "No se encontró ese ticket." };

  // `numeric` llega como cadena desde PostgREST cuando el valor tiene
  // decimales, así que el `Number` no es decorativo.
  const lineas = t.r_lineas.map((l) => ({
    numero: Number(l.numero),
    monto: Number(l.monto),
  }));

  return {
    ok: true,
    anulado: t.r_anulado,
    ticket: {
      folio: t.r_folio,
      total: Number(t.r_total),
      creadoEn: t.r_creado_en,
      lineas,
      codigo: t.r_codigo,
    },
    sorteo: {
      // La tirilla sólo usa `fecha` y `hora`; el resto va relleno porque el
      // tipo lo pide. No se consulta el estado real del sorteo: reimprimir un
      // comprobante no depende de si el sorteo sigue abierto.
      id: "",
      fecha: t.r_fecha,
      hora: t.r_hora,
      hora_cierre: "",
      estado: "cerrado",
    },
    vendedor: {
      id: "",
      codigo: t.r_codigo_v,
      nombre: t.r_vendedor,
      alias: t.r_alias,
      // La tirilla no imprime estos tres, pero el tipo los exige. Van en cero
      // en vez de inventar unos parámetros que no se han consultado: si algún
      // día la tirilla los usara, un cero se ve y un número plausible no.
      comision: 0,
      factor_pago: 0,
      tope_por_numero: 0,
    },
  };
}
