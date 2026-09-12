"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Corregir las líneas de una venta ya registrada.
 *
 * SÓLO ADMINISTRACIÓN, Y SE DECIDE AQUÍ.
 *
 * La base no puede comprobarlo: desde la 0024 la aplicación habla como
 * `service_role`, así que `fn_exige` retorna sin mirar nada. Esta acción es el
 * único sitio con una sesión firmada delante, y por eso la guarda vive en
 * estas tres líneas y no en la función.
 *
 * SIN RESTRICCIÓN DE SORTEO, a propósito. Un error se descubre auditando, y se
 * audita cuando el día ya terminó. Si el sorteo está liquidado la base rehace
 * la liquidación del vendedor; si ya se le pagó en un corte, rechaza — ahí el
 * dinero ya cambió de manos y no hay forma honesta de cuadrarlo hacia atrás.
 */

export type LineaEditada = { numero: number; monto: number };

export type ResultadoEdicion =
  | { ok: true; total: number; lineas: number; mensaje: string }
  | { ok: false; mensaje: string };

export async function editarVenta(
  ticketId: string,
  lineas: LineaEditada[],
  motivo: string,
): Promise<ResultadoEdicion> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede corregir una venta." };
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
    return { ok: false, mensaje: error.message };
  }

  const r = data?.[0];
  if (!r) return { ok: false, mensaje: "No se pudo corregir la venta." };

  // Las pantallas que muestran esa venta. La corrección cambia el cupo, así
  // que el punto de venta también tiene que volver a leerlo.
  revalidatePath("/informe");
  revalidatePath("/punto-de-venta");
  revalidatePath("/tablero");

  return {
    ok: true,
    total: Number(r.r_total),
    lineas: r.r_lineas,
    mensaje: `Venta corregida: ${r.r_lineas} ${r.r_lineas === 1 ? "número" : "números"}, total ${Number(r.r_total).toFixed(2)}.`,
  };
}
