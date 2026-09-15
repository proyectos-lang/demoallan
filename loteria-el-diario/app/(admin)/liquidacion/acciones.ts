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

/* ========================================================================
 * ABONOS: pagar a cuenta y seguir debiendo el resto.
 *
 * Es lo corriente en la calle. El vendedor trae 400 de los 900 que debe y el
 * lunes siguiente trae el resto. Antes eso no se podía registrar: o se cerraba
 * la deuda entera perdonándole 500, o el dinero entraba sin constancia.
 *
 * Un abono NO cierra sorteos. Sólo dice «entregó esto a cuenta», y el
 * pendiente baja. Los sorteos se cierran cuando termina de pagar, con el corte
 * de siempre — que ahora absorbe los abonos para no contarlos dos veces.
 * ====================================================================== */

export type DeudaVendedor = {
  sorteos: number;
  desde: string | null;
  hasta: string | null;
  /** Lo que suman los sorteos sin cerrar. */
  deuda: number;
  /** Lo ya entregado a cuenta y todavía sin cerrar en un corte. */
  abonado: number;
  /** Lo que falta de verdad: deuda − abonado. */
  pendiente: number;
};

export type AbonoVendedor = {
  id: string;
  monto: number;
  fechaPago: string;
  nota: string | null;
  /** Ya absorbido por un corte: su dinero está contado ahí dentro. */
  cerrado: boolean;
};

export type ResultadoAbono =
  | { ok: true; monto: number; pendiente: number; mensaje: string }
  | { ok: false; mensaje: string };

/** Lo que un vendedor debe hoy, con sus abonos ya descontados. */
export async function deudaDe(
  vendedorId: string,
): Promise<{ ok: true; deuda: DeudaVendedor; abonos: AbonoVendedor[] } | { ok: false; mensaje: string }> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede ver la cuenta de un vendedor." };
  }

  const supabase = crearClienteServicio();

  const [{ data: d, error: eD }, { data: a, error: eA }] = await Promise.all([
    supabase.rpc("fn_deuda_vendedor", { p_vendedor_id: vendedorId }),
    supabase.rpc("fn_abonos_vendedor", { p_vendedor_id: vendedorId, p_incluir_cerrados: false }),
  ]);

  const falta = eD ?? eA;
  if (falta) {
    if (falta.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "Los abonos todavía no están habilitados en la base de datos. Falta aplicar la migración 0079.",
      };
    }
    return { ok: false, mensaje: falta.message };
  }

  const f = d?.[0];
  return {
    ok: true,
    deuda: {
      sorteos: f?.r_sorteos ?? 0,
      desde: f?.r_desde ?? null,
      hasta: f?.r_hasta ?? null,
      deuda: Number(f?.r_deuda ?? 0),
      abonado: Number(f?.r_abonado ?? 0),
      pendiente: Number(f?.r_pendiente ?? 0),
    },
    abonos: (a ?? []).map((x) => ({
      id: x.r_abono_id,
      monto: Number(x.r_monto),
      fechaPago: x.r_fecha_pago,
      nota: x.r_nota,
      cerrado: x.r_cerrado,
    })),
  };
}

/**
 * Registrar dinero entregado a cuenta.
 *
 * El monto y la fecha viajan, pero la base los valida de nuevo: que no pase de
 * lo que debe y que la fecha no sea futura. Lo que esta acción decide es lo
 * único que la base no puede — que quien lo pide sea administrador.
 */
export async function registrarAbono(
  vendedorId: string,
  monto: number,
  fechaPago: string,
  nota: string,
): Promise<ResultadoAbono> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede registrar un abono." };
  }

  if (!Number.isFinite(monto) || monto <= 0) {
    return { ok: false, mensaje: "Escriba cuánto entregó el vendedor." };
  }

  const supabase = crearClienteServicio();

  const { data, error } = await supabase.rpc("fn_registrar_abono", {
    p_vendedor_id: vendedorId,
    p_monto: monto,
    p_fecha_pago: fechaPago || null,
    p_nota: nota.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "Los abonos todavía no están habilitados en la base de datos. Falta aplicar la migración 0079.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "El abono no devolvió resultado." };

  revalidatePath("/liquidacion");
  revalidatePath("/cobranza");

  const pendiente = Number(f.r_pendiente);
  return {
    ok: true,
    monto: Number(f.r_monto),
    pendiente,
    mensaje:
      pendiente > 0
        ? `Abono registrado. Le quedan ${pendiente.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por pagar.`
        : "Abono registrado. Queda al día: ya puede cerrarse el corte.",
  };
}

/** Quita un abono mal tecleado. Sólo si no entró todavía en ningún corte. */
export async function anularAbono(
  abonoId: string,
  motivo: string,
): Promise<{ ok: boolean; mensaje: string }> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede quitar un abono." };
  }

  const supabase = crearClienteServicio();
  const { error } = await supabase.rpc("fn_anular_abono", {
    p_abono_id: abonoId,
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/liquidacion");
  revalidatePath("/cobranza");
  return { ok: true, mensaje: "Abono quitado." };
}

/* ========================================================================
 * REVERSAR UNA LIQUIDACIÓN.
 *
 * Deshacer un corte para que sus sorteos vuelvan a estar pendientes, como si
 * nunca se hubiera cerrado. Para cuando se liquidó la semana equivocada, se
 * marcó un sorteo de más, o llegó una corrección después de cerrar.
 * ====================================================================== */

export type SorteoDelCorte = {
  fecha: string;
  hora: string;
  ganador: number | null;
  venta: number;
  comision: number;
  premios: number;
  saldo: number;
};

/** Qué contiene un corte, para poder ver qué se desharía antes de confirmar. */
export async function detalleCorte(
  corteId: string,
): Promise<{ ok: true; sorteos: SorteoDelCorte[] } | { ok: false; mensaje: string }> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede ver un corte." };
  }

  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_detalle_corte", { p_corte_id: corteId });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "Reversar todavía no está habilitado en la base de datos. Falta aplicar la migración 0084.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  return {
    ok: true,
    sorteos: (data ?? []).map((s) => ({
      fecha: s.r_fecha,
      hora: s.r_hora,
      ganador: s.r_ganador,
      venta: Number(s.r_venta),
      comision: Number(s.r_comision),
      premios: Number(s.r_premios),
      saldo: Number(s.r_saldo),
    })),
  };
}

/**
 * Deshace un corte.
 *
 * Los sorteos vuelven a estar pendientes y los abonos que ese corte había
 * absorbido vuelven a estar vivos — si no se liberaran, el dinero que el
 * vendedor ya entregó desaparecería de la cuenta y se le volvería a cobrar.
 *
 * El corte se borra, no se marca: uno anulado seguiría figurando en su
 * historial de pagos diciendo que se le entregó algo. La auditoría conserva
 * que existió, de cuánto era y quién lo revirtió.
 */
export async function reversarCorte(
  corteId: string,
  motivo: string,
): Promise<
  | { ok: true; sorteos: number; abonos: number; mensaje: string }
  | { ok: false; mensaje: string }
> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede reversar una liquidación." };
  }

  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_reversar_corte", {
    p_corte_id: corteId,
    p_motivo: motivo.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "Reversar todavía no está habilitado en la base de datos. Falta aplicar la migración 0084.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "La reversa no devolvió resultado." };

  revalidatePath("/liquidacion");
  revalidatePath("/informe");
  revalidatePath("/tablero");

  const sorteos = f.r_sorteos ?? 0;
  const abonos = f.r_abonos ?? 0;

  return {
    ok: true,
    sorteos,
    abonos,
    mensaje:
      `Liquidación revertida: ${sorteos} ${sorteos === 1 ? "sorteo vuelve" : "sorteos vuelven"} a estar pendientes.` +
      (abonos > 0
        ? ` ${abonos} ${abonos === 1 ? "abono vuelve" : "abonos vuelven"} a descontar del saldo.`
        : ""),
  };
}
