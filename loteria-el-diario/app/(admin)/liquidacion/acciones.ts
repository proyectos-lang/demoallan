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


/* =========================================================================
 * Saldar lo que un vendedor arrastra de semanas anteriores.
 * ========================================================================= */

export type ResultadoArrastre =
  | { ok: true; sorteos: number; saldo: number; entrega: number; ajuste: number; mensaje: string }
  | { ok: false; mensaje: string };

/** Un sorteo del arrastre, para enseñar qué se va a saldar antes de hacerlo. */
export type SorteoArrastre = {
  fecha: string;
  hora: string;
  saldo: number;
};

/**
 * Qué compone el arrastre de un vendedor.
 *
 * Se consulta al abrir el modal: el arrastre es una suma, y quien va a
 * cerrarlo tiene derecho a ver de qué sorteos sale antes de confirmar.
 */
export async function detalleArrastre(
  vendedorId: string,
  desde: string,
): Promise<{ ok: true; sorteos: SorteoArrastre[]; saldo: number } | { ok: false; mensaje: string }> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede ver esto." };
  }

  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_arrastre_pendiente", {
    p_vendedor_id: vendedorId,
    p_desde: desde,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "Saldar el arrastre todavía no está habilitado en la base de datos. Falta aplicar la migración 0069.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const sorteos = (data ?? []).map((s) => ({
    fecha: s.r_fecha,
    hora: s.r_hora,
    saldo: Number(s.r_saldo),
  }));

  return { ok: true, sorteos, saldo: sorteos.reduce((a, s) => a + s.saldo, 0) };
}

/**
 * Cierra el arrastre entero.
 *
 * SE SALDA TODO, sea cual sea el valor entregado. El arrastre no es un número
 * suelto sino un conjunto de sorteos viejos sin pagar: se meten todos en un
 * corte y dejan de contar. Lo que se entregó puede diferir del cálculo —un
 * redondeo, un resto perdonado—, y esa diferencia se guarda como ajuste con su
 * motivo en vez de repartirse entre los sorteos, que dejaría liquidaciones con
 * cifras que no corresponden a ninguna venta real.
 *
 * Los totales los recalcula la base. Lo que va de aquí es el vendedor, la
 * fecha de corte, lo entregado y el motivo: nada que el navegador pueda
 * inflar para cerrar una deuda por menos de lo que es.
 */
export async function saldarArrastre(
  vendedorId: string,
  desde: string,
  entrega: number,
  fechaPago: string,
  motivo: string,
): Promise<ResultadoArrastre> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede saldar el arrastre." };
  }

  if (!Number.isFinite(entrega)) {
    return { ok: false, mensaje: "Escriba cuánto entregó el vendedor." };
  }

  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_saldar_arrastre", {
    p_vendedor_id: vendedorId,
    p_desde: desde,
    p_entrega: entrega,
    p_fecha_pago: fechaPago || null,
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "Saldar el arrastre todavía no está habilitado en la base de datos. Falta aplicar la migración 0069.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const r = data?.[0];
  if (!r) return { ok: false, mensaje: "No se pudo registrar el pago." };

  revalidatePath("/liquidacion");

  const ajuste = Number(r.r_ajuste);
  return {
    ok: true,
    sorteos: r.r_sorteos,
    saldo: Number(r.r_saldo),
    entrega: Number(r.r_entrega),
    ajuste,
    mensaje:
      ajuste === 0
        ? `Arrastre saldado: ${r.r_sorteos} ${r.r_sorteos === 1 ? "sorteo" : "sorteos"} quedan pagados.`
        : `Arrastre saldado con un ajuste de ${ajuste.toFixed(2)}. Queda registrado con su motivo.`,
  };
}
