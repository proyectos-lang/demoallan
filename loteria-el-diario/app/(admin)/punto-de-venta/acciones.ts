"use server";

import { revalidatePath } from "next/cache";

import { sesionVigente } from "@/lib/sesion-vigente";
import { crearClienteServidor } from "@/lib/supabase/server";

export type LineaVenta = { numero: number; monto: number };

/** Un ticket ya registrado, con lo que hace falta para imprimirlo. */
export type TicketRegistrado = {
  folio: string;
  total: number;
  /** Hora de emisión SEGÚN LA BASE, no según el reloj del dispositivo. */
  creadoEn: string;
  lineas: LineaVenta[];
  /** EAN-13 del ticket. Se imprime como código de barras. */
  codigo?: string | null;
  /**
   * El SORTEO REAL del ticket —fecha y hora— tal como quedó guardado. La
   * tirilla imprime ESTO, no el sorteo que la pantalla tenga cargado: así el
   * papel nunca muestra un sorteo distinto al del ticket. Una venta a futuro
   * lleva su sorteo futuro, que es el correcto.
   */
  sorteoFecha?: string | null;
  sorteoHora?: string | null;
};

export type ResultadoVenta =
  | { ok: true; tickets: TicketRegistrado[]; total: number }
  | { ok: false; mensaje: string };

/** Cuántos tickets admite una tanda. El mismo tope que `fn_registrar_tanda`. */
const MAX_TICKETS = 50;

/**
 * Registra una tanda de tickets.
 *
 * Se manda siempre por aquí, aunque sea un ticket suelto: uno es una tanda de
 * uno, y así no hay dos caminos que mantener a la par. La base lo resuelve en
 * UNA transacción —`fn_registrar_tanda` es plpgsql—, de modo que el vendedor
 * que atiende una cola de cuatro personas no se queda con tres registradas y
 * una perdida sin saber cuál.
 *
 * Toda la validación de cupo ocurre dentro de `fn_registrar_ticket`, en esa
 * misma transacción y con la fila de cupo bloqueada. Lo que la pantalla muestra
 * mientras se teclea es orientativo: entre esa lectura y esta llamada el saldo
 * pudo haber cambiado, y aquí es donde se decide de verdad.
 *
 * QUIÉN VENDE A NOMBRE DE QUIÉN
 * -----------------------------
 * `vendedorId` llega del navegador, así que no se puede creer. Mientras los
 * usuarios vivían en Supabase Auth esto lo ataja la base: `fn_registrar_ticket`
 * comparaba contra el vendedor del JWT y rechazaba con «No puede registrar
 * ventas a nombre de otro vendedor». Sin JWT esa comprobación no tiene de dónde
 * leer y deja pasar, así que se hace aquí:
 *
 *   · un vendedor vende SIEMPRE como él mismo, se mande lo que se mande;
 *   · los perfiles administrativos sí pueden elegir, que es para lo que existe
 *     el selector de la pantalla de punto de venta.
 *
 * Y QUIÉN PUEDE VENDER FUERA DE HORA
 * ----------------------------------
 * `p_forzar` no viaja desde el navegador: se calcula aquí, del rol de la
 * sesión. Es la única bandera que levanta el corte por estado y por hora de
 * `fn_registrar_ticket`, así que dejarla en manos del cliente equivaldría a no
 * tener horario de cierre.
 */
export async function registrarVenta(
  sorteoId: string,
  vendedorId: string,
  tickets: LineaVenta[][],
  coordenada?: { lat: number; lng: number },
  /*
   * LA MARCA DEL ENVÍO. La genera la pantalla al empezar a componer la venta,
   * y viaja con ella. Si la misma marca llega dos veces —reintento de red,
   * recarga, dos dispositivos— la base devuelve los folios ya creados en vez
   * de registrar la venta otra vez.
   *
   * Que la genere el cliente no es un riesgo: identifica un envío, no autoriza
   * nada. Lo peor que puede hacer alguien manipulándola es impedirse a sí
   * mismo registrar una venta nueva.
   */
  envioId?: string,
): Promise<ResultadoVenta> {
  const conLineas = tickets.filter((t) => t.length > 0);

  if (conLineas.length === 0) {
    return { ok: false, mensaje: "No hay ningún ticket con líneas." };
  }

  if (conLineas.length > MAX_TICKETS) {
    return {
      ok: false,
      mensaje: `Una tanda no puede llevar más de ${MAX_TICKETS} tickets.`,
    };
  }

  // `sesionVigente` y no `sesionActual`: una acción no vuelve a renderizar el
  // layout, así que sin esto un vendedor recién dado de baja seguiría vendiendo
  // con la pantalla que ya tenía abierta.
  const sesion = await sesionVigente();
  if (!sesion) {
    return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  }

  let vendedorEfectivo = vendedorId;

  if (sesion.rol === "vendedor") {
    if (!sesion.vendedor_id) {
      return { ok: false, mensaje: "Su cuenta no está enlazada a ningún vendedor." };
    }
    vendedorEfectivo = sesion.vendedor_id;
  } else if (sesion.rol !== "administrador" && sesion.rol !== "digitador") {
    // Un auditor lee, no vende.
    return { ok: false, mensaje: "Su perfil no puede registrar ventas." };
  }

  const supabase = await crearClienteServidor();

  const argumentos = {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorEfectivo,
    p_tickets: conLineas,
    p_lat: coordenada?.lat ?? null,
    p_lng: coordenada?.lng ?? null,
    p_forzar: sesion.rol === "administrador",
    p_usuario_id: sesion.id,
  };

  let { data, error } = await supabase.rpc("fn_registrar_tanda", {
    ...argumentos,
    p_envio_id: envioId ?? null,
  });

  /*
   * LA VENTA NO PUEDE CAERSE PORQUE FALTE UNA MIGRACIÓN.
   *
   * PostgREST resuelve la función por su lista EXACTA de parámetros: si la
   * base todavía no tiene la 0056, `p_envio_id` no existe en ninguna firma y
   * devuelve PGRST202 —«no se pudo encontrar la función»—, no un error de
   * parámetro. La venta se cae entera.
   *
   * Ya ocurrió: se publicó el código antes de aplicar la migración y el
   * vendedor no pudo registrar hasta que se aplicó. El despliegue de la
   * aplicación y el de la base son dos gestos distintos y no hay forma de
   * garantizar que lleguen a la vez, así que el código tiene que aguantar el
   * intervalo.
   *
   * Aquí se reintenta sin la marca. Se pierde la protección contra duplicados
   * durante ese rato —que es lo que había ayer— pero se sigue vendiendo, que
   * es lo que no puede fallar.
   */
  if (error?.code === "PGRST202") {
    ({ data, error } = await supabase.rpc("fn_registrar_tanda", argumentos));
  }

  if (error) {
    return { ok: false, mensaje: error.message };
  }

  const filas = data ?? [];
  if (filas.length === 0) {
    return { ok: false, mensaje: "La venta no devolvió folio." };
  }

  revalidatePath("/punto-de-venta");
  revalidatePath("/mi-venta");
  revalidatePath("/mi-reporte");

  // Las filas vuelven en el mismo orden en que se mandaron los tickets —el
  // bucle de `fn_registrar_tanda` recorre el jsonb tal cual—, así que el folio
  // de la posición i corresponde a las líneas de la posición i. Se emparejan
  // aquí para que la pantalla pueda imprimir cada ticket con su detalle sin
  // volver a consultar la base.
  return {
    ok: true,
    tickets: filas.map((f, i) => ({
      folio: f.r_folio,
      total: Number(f.r_total),
      creadoEn: f.r_creado_en,
      lineas: conLineas[i] ?? [],
      codigo: f.r_codigo ?? null,
      sorteoFecha: f.r_sorteo_fecha ?? null,
      sorteoHora: f.r_sorteo_hora ?? null,
    })),
    total: filas.reduce((a, f) => a + Number(f.r_total), 0),
  };
}


/**
 * Venta a un sorteo de otra fecha, o de más tarde del mismo día.
 *
 * Se manda FECHA y FRANJA en vez del identificador del sorteo, porque el
 * sorteo puede no existir todavía: `fn_registrar_venta_futura` lo crea con su
 * cupo en ese momento. Sólo existen los días que alguien usa, y así el resto
 * del sistema sigue distinguiendo cuál es el sorteo de ahora.
 *
 * Las guardas son las mismas que la venta normal, y por la misma razón: el
 * vendedor que llega aquí vende SIEMPRE como él mismo, se mande lo que se
 * mande desde el navegador.
 *
 * Lo que NO se hereda es `p_forzar`: una venta futura nunca levanta el corte
 * de hora. Si el sorteo elegido ya cerró, se rechaza igual que cualquier venta
 * tardía —forzar es una decisión de administración, y esta puerta la usa el
 * vendedor—.
 */
export async function registrarVentaFutura(
  fecha: string,
  hora: string,
  vendedorId: string,
  tickets: LineaVenta[][],
  coordenada?: { lat: number; lng: number },
  envioId?: string,
): Promise<ResultadoVenta> {
  const conLineas = tickets.filter((t) => t.length > 0);

  if (conLineas.length === 0) {
    return { ok: false, mensaje: "No hay ningún ticket con líneas." };
  }
  if (conLineas.length > MAX_TICKETS) {
    return {
      ok: false,
      mensaje: `Una tanda no puede llevar más de ${MAX_TICKETS} tickets.`,
    };
  }

  const sesion = await sesionVigente();
  if (!sesion) {
    return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  }

  let vendedorEfectivo = vendedorId;

  if (sesion.rol === "vendedor") {
    if (!sesion.vendedor_id) {
      return { ok: false, mensaje: "Su cuenta no está enlazada a ningún vendedor." };
    }
    vendedorEfectivo = sesion.vendedor_id;
  } else if (sesion.rol !== "administrador" && sesion.rol !== "digitador") {
    return { ok: false, mensaje: "Su perfil no puede registrar ventas." };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_registrar_venta_futura", {
    p_fecha: fecha,
    p_hora: hora as "11:00" | "15:00" | "21:00",
    p_vendedor_id: vendedorEfectivo,
    p_tickets: conLineas,
    p_lat: coordenada?.lat ?? null,
    p_lng: coordenada?.lng ?? null,
    p_usuario_id: sesion.id,
    p_envio_id: envioId ?? null,
  });

  if (error) {
    return { ok: false, mensaje: error.message };
  }

  const filas = data ?? [];
  if (filas.length === 0) {
    return { ok: false, mensaje: "La venta no devolvió folio." };
  }

  revalidatePath("/mis-ventas-futuras");
  revalidatePath("/mi-dia");
  revalidatePath("/mi-reporte");

  return {
    ok: true,
    tickets: filas.map((f, i) => ({
      folio: f.r_folio,
      total: Number(f.r_total),
      creadoEn: f.r_creado_en,
      lineas: conLineas[i] ?? [],
      codigo: f.r_codigo ?? null,
      sorteoFecha: f.r_sorteo_fecha ?? null,
      sorteoHora: f.r_sorteo_hora ?? null,
    })),
    total: filas.reduce((a, f) => a + Number(f.r_total), 0),
  };
}

export type ResultadoTotales =
  | { ok: true; comision: number; saldo: number; mensaje: string }
  | { ok: false; mensaje: string };

/**
 * Registra una venta por totales: sin números, sólo venta y premio.
 *
 * Es para cuando el vendedor no pasó por el portal —trabajó en papel y al
 * final del día entrega su cuenta—. La captura entra en `allan.liquidacion`
 * como una fuente más, así que la recogen el corte semanal, el informe de
 * gerencia y el tablero sin distinguirla.
 *
 * SÓLO ADMINISTRADOR. No es una venta: es un ajuste contable que nadie puede
 * contrastar contra números, y por eso no lo toca ni el vendedor ni el
 * digitador. La comprobación va aquí y no en la base: desde la 0024 la
 * aplicación habla como `service_role` y `fn_exige` no comprueba nada.
 *
 * La comisión NO viaja desde el navegador: la toma la base del parámetro
 * vigente del vendedor y la congela en la fila. El premio sí se acepta tal
 * cual —sin números no hay con qué verificarlo— y queda auditado.
 */
export async function registrarVentaPorTotales(
  sorteoId: string,
  vendedorId: string,
  venta: number,
  premios: number,
  nota: string,
): Promise<ResultadoTotales> {
  const sesion = await sesionVigente();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede capturar por totales." };
  }

  if (!Number.isFinite(venta) || venta < 0) {
    return { ok: false, mensaje: "La venta no puede ser negativa." };
  }
  if (!Number.isFinite(premios) || premios < 0) {
    return { ok: false, mensaje: "El premio no puede ser negativo." };
  }
  if (venta === 0 && premios === 0) {
    return { ok: false, mensaje: "No hay nada que registrar: venta y premio en cero." };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_registrar_venta_total", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorId,
    p_venta: venta,
    p_premios: premios,
    p_nota: nota.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    // La restricción de una captura viva por vendedor y sorteo llega como
    // 23505, y el mensaje crudo de Postgres no le dice nada a quien captura.
    if (error.code === "23505") {
      return {
        ok: false,
        mensaje:
          "Ese vendedor ya tiene una captura en este sorteo. Anúlela antes de registrar otra.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const fila = data?.[0];
  if (!fila) return { ok: false, mensaje: "El registro no devolvió resultado." };

  revalidatePath("/punto-de-venta");
  revalidatePath("/liquidacion");

  const saldo = Number(fila.r_saldo);

  return {
    ok: true,
    comision: Number(fila.r_comision),
    saldo,
    mensaje: `Registrado: venta ${venta.toLocaleString("en-US")}, premio ${premios.toLocaleString("en-US")}. ${
      saldo >= 0 ? "El vendedor entrega" : "La empresa le entrega"
    } ${Math.abs(saldo).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
  };
}

/** Anula una captura por totales. No la borra: la marca y rehace la liquidación. */
export async function anularVentaPorTotales(id: string): Promise<ResultadoTotales> {
  const sesion = await sesionVigente();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede anular una captura." };
  }

  const supabase = await crearClienteServidor();
  const { error } = await supabase.rpc("fn_anular_venta_total", {
    p_id: id,
    p_usuario_id: sesion.id,
  });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/punto-de-venta");
  revalidatePath("/liquidacion");

  return { ok: true, comision: 0, saldo: 0, mensaje: "Captura anulada." };
}

/**
 * Corregir una captura por totales.
 *
 * Hasta ahora un dedazo —4.500 tecleado como 450— sólo se arreglaba anulando y
 * volviendo a capturar, y eso deja dos filas en el histórico para lo que fue
 * un error en un dígito.
 *
 * NO SE TOCAN el vendedor ni el sorteo: eso no es corregir, es trasladar
 * dinero de un sitio a otro, y para eso está anular y capturar donde toque,
 * que deja las dos huellas. La comisión congelada tampoco: vive en la fila
 * desde el día de la captura y no hay razón para perderla.
 *
 * SÓLO ADMINISTRADOR, decidido aquí. La base habla como `service_role` desde
 * la 0024 y sus guardas de rol no miran nada.
 */
export async function editarVentaPorTotales(
  id: string,
  venta: number,
  premios: number,
  nota: string,
): Promise<ResultadoTotales> {
  const sesion = await sesionVigente();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede corregir una captura." };
  }

  if (!Number.isFinite(venta) || venta < 0) {
    return { ok: false, mensaje: "La venta no puede ser negativa." };
  }
  if (!Number.isFinite(premios) || premios < 0) {
    return { ok: false, mensaje: "El premio no puede ser negativo." };
  }
  if (venta === 0 && premios === 0) {
    return {
      ok: false,
      mensaje: "Una captura no puede quedar en cero y cero. Para dejarla sin efecto, anúlela.",
    };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_editar_venta_total", {
    p_id: id,
    p_venta: venta,
    p_premios: premios,
    p_nota: nota.trim() || null,
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje:
          "Corregir capturas todavía no está habilitado en la base de datos. Falta aplicar la migración 0076.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const fila = data?.[0];
  if (!fila) return { ok: false, mensaje: "La corrección no devolvió resultado." };

  revalidatePath("/punto-de-venta");
  revalidatePath("/liquidacion");
  revalidatePath("/informe");

  const saldo = Number(fila.r_saldo);

  return {
    ok: true,
    comision: Number(fila.r_comision),
    saldo,
    mensaje: `Corregido: venta ${venta.toLocaleString("en-US")}, premio ${premios.toLocaleString("en-US")}. ${
      saldo >= 0 ? "El vendedor entrega" : "La empresa le entrega"
    } ${Math.abs(saldo).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
  };
}

/* ========================================================================
 * CAPTURA MASIVA: el padrón entero de un sorteo, de una vez.
 *
 * La hoja de papel de la que se copia tiene forma de tabla, y la pantalla
 * ahora también. Con 102 vendedores, capturar de uno en uno son 102 vueltas.
 * ====================================================================== */

export type FilaMatriz = {
  vendedorId: string;
  codigo: string;
  vendedor: string;
  factor: number;
  comision: number;
  /** Lo ya capturado por totales, o nulo si no hay captura. */
  venta: number | null;
  /** Lo APOSTADO, que es lo que se teclea. */
  premiado: number | null;
  /** Lo que vendió por su teléfono: capturarle además sumaría dos veces. */
  ventaPropia: number;
  tickets: number;
};

/** El padrón entero de un sorteo, con lo que ya tenga cada uno. */
export async function matrizTotales(
  sorteoId: string,
): Promise<{ ok: true; filas: FilaMatriz[] } | { ok: false; mensaje: string }> {
  const sesion = await sesionVigente();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede capturar por totales." };
  }

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("fn_matriz_totales", { p_sorteo_id: sorteoId });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "La captura en matriz todavía no está habilitada en la base de datos. Falta aplicar la migración 0087.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  return {
    ok: true,
    filas: (data ?? []).map((f) => ({
      vendedorId: f.r_vendedor_id,
      codigo: f.r_codigo,
      vendedor: f.r_vendedor,
      factor: Number(f.r_factor),
      comision: Number(f.r_comision),
      venta: f.r_venta === null ? null : Number(f.r_venta),
      premiado: f.r_premiado === null ? null : Number(f.r_premiado),
      ventaPropia: Number(f.r_venta_propia),
      tickets: f.r_tickets,
    })),
  };
}

/**
 * Guarda la matriz entera.
 *
 * Sólo toca las capturas por totales: lo que el vendedor registró por su
 * teléfono no se toca jamás desde aquí. Y es todo o nada — con 102 filas,
 * guardar la mitad y fallar sería peor que no guardar nada, porque nadie
 * sabría por dónde iba.
 */
export async function guardarMatrizTotales(
  sorteoId: string,
  filas: { vendedorId: string; venta: number; premiado: number }[],
): Promise<
  | { ok: true; creadas: number; corregidas: number; sinCambio: number; mensaje: string }
  | { ok: false; mensaje: string }
> {
  const sesion = await sesionVigente();
  if (!sesion) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };
  if (sesion.rol !== "administrador") {
    return { ok: false, mensaje: "Sólo un administrador puede capturar por totales." };
  }

  // Las filas en blanco no viajan: son «no tengo su hoja», y mandarlas sólo
  // haría al servidor recorrer cien filas para no hacer nada con ellas.
  const conCifra = filas.filter((f) => f.venta > 0 || f.premiado > 0);
  if (conCifra.length === 0) {
    return { ok: false, mensaje: "No hay ninguna cifra que guardar." };
  }

  for (const f of conCifra) {
    if (!(f.venta >= 0) || !(f.premiado >= 0)) {
      return { ok: false, mensaje: "Ni la venta ni el premiado pueden ser negativos." };
    }
  }

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("fn_capturar_totales_masivo", {
    p_sorteo_id: sorteoId,
    p_filas: conCifra.map((f) => ({
      vendedor_id: f.vendedorId,
      venta: f.venta,
      premiado: f.premiado,
    })),
    p_usuario_id: sesion.id,
  });

  if (error) {
    if (error.code === "PGRST202") {
      return {
        ok: false,
        mensaje: "La captura en matriz todavía no está habilitada en la base de datos. Falta aplicar la migración 0087.",
      };
    }
    return { ok: false, mensaje: error.message };
  }

  const r = data?.[0];
  if (!r) return { ok: false, mensaje: "El guardado no devolvió resultado." };

  revalidatePath("/punto-de-venta");
  revalidatePath("/liquidacion");
  revalidatePath("/informe");
  revalidatePath("/tablero");

  const partes: string[] = [];
  if (r.r_creadas > 0) partes.push(`${r.r_creadas} ${r.r_creadas === 1 ? "registrada" : "registradas"}`);
  if (r.r_corregidas > 0) partes.push(`${r.r_corregidas} ${r.r_corregidas === 1 ? "corregida" : "corregidas"}`);
  if (r.r_sin_cambio > 0) partes.push(`${r.r_sin_cambio} sin cambio`);

  return {
    ok: true,
    creadas: r.r_creadas,
    corregidas: r.r_corregidas,
    sinCambio: r.r_sin_cambio,
    mensaje: `Guardado: ${partes.join(", ")}. Venta ${Number(r.r_venta).toLocaleString("en-US")}.`,
  };
}
