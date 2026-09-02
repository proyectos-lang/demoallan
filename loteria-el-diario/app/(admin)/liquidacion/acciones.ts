"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

export type ResultadoCorte =
  | { ok: true; sorteos: number; saldo: number; mensaje: string }
  | { ok: false; mensaje: string };

/**
 * Liquida una semana —o los días que se hayan marcado.
 *
 * LIQUIDAR ES UN SOLO GESTO en las dos direcciones. El saldo puede salir a
 * favor de la casa o del vendedor, y en los dos casos lo que se registra es lo
 * mismo: que esos sorteos quedaron cerrados. El signo se guarda en
 * `corte_vendedor.saldo` y lo lee cada pantalla para decir quién entrega.
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
    return { ok: false, mensaje: "Sólo un administrador puede liquidar." };
  }

  if (liquidacionIds.length === 0) {
    return { ok: false, mensaje: "No se marcó ningún sorteo para liquidar." };
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
  if (!fila) return { ok: false, mensaje: "La liquidación no devolvió resultado." };

  revalidatePath("/liquidacion");

  const sorteos = Number(fila.r_sorteos);
  const saldo = Number(fila.r_saldo);

  return {
    ok: true,
    sorteos,
    saldo,
    // El mensaje dice la dirección porque es lo primero que se comprueba
    // después de cerrar: si dice «entregó» y el dinero salió de la caja, hay
    // algo mal y conviene verlo en ese momento y no en el arqueo.
    mensaje: `Liquidados ${sorteos} ${sorteos === 1 ? "sorteo" : "sorteos"}: ${
      saldo >= 0 ? "el vendedor entregó" : "la casa le entregó"
    } ${Math.abs(saldo).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Ya no vuelven a aparecer.`,
  };
}
