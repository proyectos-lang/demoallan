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
