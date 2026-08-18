"use server";

import { revalidatePath } from "next/cache";

import { crearClienteServidor } from "@/lib/supabase/server";

export type Impacto = {
  venta: number;
  comision: number;
  tickets: number;
  lineas_ganadoras: number;
  pago: number;
  utilidad: number;
};

/** Cuánto costaría este número si saliera. No liquida nada. */
export async function calcularImpacto(
  sorteoId: string,
  numero: number,
): Promise<{ ok: true; impacto: Impacto } | { ok: false; mensaje: string }> {
  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_impacto_numero", {
    p_sorteo_id: sorteoId,
    p_numero: numero,
  });

  if (error) return { ok: false, mensaje: error.message };
  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "No se pudo calcular el impacto." };

  return {
    ok: true,
    impacto: {
      venta: Number(f.venta),
      comision: Number(f.comision),
      tickets: Number(f.tickets),
      lineas_ganadoras: Number(f.lineas_ganadoras),
      pago: Number(f.pago),
      utilidad: Number(f.utilidad),
    },
  };
}

/** Corta la venta. Es el paso previo obligatorio para poder liquidar. */
export async function cerrarVenta(
  sorteoId: string,
): Promise<{ ok: true } | { ok: false; mensaje: string }> {
  const supabase = await crearClienteServidor();
  const { error } = await supabase.rpc("fn_cerrar_sorteo", { p_sorteo_id: sorteoId });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/resultados");
  return { ok: true };
}

/**
 * Liquida. Transacción única: marca ganadoras, calcula premios con el factor
 * congelado de cada línea, genera las liquidaciones por vendedor y bloquea el
 * sorteo. Es irreversible salvo por una reversión auditada.
 */
export async function liquidar(
  sorteoId: string,
  numero: number,
): Promise<
  | { ok: true; vendedores: number; ganadoras: number; premios: number }
  | { ok: false; mensaje: string }
> {
  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: sorteoId,
    p_numero_ganador: numero,
  });

  if (error) return { ok: false, mensaje: error.message };
  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "La liquidación no devolvió resultado." };

  revalidatePath("/resultados");
  revalidatePath("/tablero");
  return {
    ok: true,
    vendedores: Number(f.total_vendedores),
    ganadoras: Number(f.total_lineas_ganadoras),
    premios: Number(f.total_premios),
  };
}
