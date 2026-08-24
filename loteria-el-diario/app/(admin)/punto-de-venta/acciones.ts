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

  const { data, error } = await supabase.rpc("fn_registrar_tanda", {
    p_sorteo_id: sorteoId,
    p_vendedor_id: vendedorEfectivo,
    p_tickets: conLineas,
    p_lat: coordenada?.lat ?? null,
    p_lng: coordenada?.lng ?? null,
    p_forzar: sesion.rol === "administrador",
    p_usuario_id: sesion.id,
  });

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
