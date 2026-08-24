"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

export type ResultadoCorte =
  | { ok: true; sorteos: number; saldo: number; mensaje: string }
  | { ok: false; mensaje: string };

/**
 * Cierra el pago de una semana —o de los días que se hayan marcado.
 *
 * Lo que viaja son IDENTIFICADORES de liquidación, no cifras: los totales los
 * recalcula `fn_registrar_corte` desde la base. Si aquí se aceptaran los
 * números del navegador, el corte guardaría una cantidad que no corresponde a
 * ningún sorteo y no habría forma de cuadrarlo después.
 *
 * Que un sorteo no se pague dos veces tampoco se decide aquí: lo impide el
 * `unique (liquidacion_id)` de `allan.corte_detalle`. Dos administradores que
 * carguen el mismo informe y confirmen a la vez producen un corte y un error,
 * nunca dos pagos.
 */
export async function registrarCorte(
  vendedorId: string,
  liquidacionIds: string[],
  desde: string,
  hasta: string,
  nota: string,
): Promise<ResultadoCorte> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede registrar un pago." };
  }

  if (liquidacionIds.length === 0) {
    return { ok: false, mensaje: "No se marcó ningún sorteo para pagar." };
  }

  const supabase = crearClienteServicio();

  const { data, error } = await supabase.rpc("fn_registrar_corte", {
    p_vendedor_id: vendedorId,
    p_liquidacion_ids: liquidacionIds,
    p_desde: desde,
    p_hasta: hasta,
    p_nota: nota.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) return { ok: false, mensaje: error.message };

  const fila = data?.[0];
  if (!fila) return { ok: false, mensaje: "El pago no devolvió resultado." };

  revalidatePath("/liquidacion");

  const sorteos = Number(fila.r_sorteos);
  const saldo = Number(fila.r_saldo);

  return {
    ok: true,
    sorteos,
    saldo,
    mensaje: `Pago registrado: ${sorteos} ${sorteos === 1 ? "sorteo" : "sorteos"}. Ya no volverán a aparecer en el informe.`,
  };
}
