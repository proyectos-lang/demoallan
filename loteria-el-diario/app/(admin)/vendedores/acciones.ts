"use server";

import { revalidatePath } from "next/cache";

import { crearClienteServidor } from "@/lib/supabase/server";

export type Cambio = {
  vendedor_id: string;
  /** Porcentaje tal como se teclea (12.5), no fracción. */
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

export type Resultado = { ok: true; mensaje: string } | { ok: false; mensaje: string };

/**
 * Guarda los parámetros modificados. Cada uno va por `fn_guardar_parametros`,
 * que versiona en vez de actualizar: las ventas ya registradas conservan lo
 * que se les prometió.
 *
 * Las validaciones se repiten aquí sólo para dar un mensaje inmediato con el
 * nombre del vendedor; las que mandan son las de la base.
 */
export async function guardarParametros(cambios: Cambio[]): Promise<Resultado> {
  if (cambios.length === 0) {
    return { ok: false, mensaje: "No hay cambios sin guardar." };
  }

  const supabase = await crearClienteServidor();

  const { data: vendedores } = await supabase
    .from("vendedor")
    .select("id, nombre")
    .in(
      "id",
      cambios.map((c) => c.vendedor_id),
    );

  const nombrePorId = new Map((vendedores ?? []).map((v) => [v.id, v.nombre]));
  const nombre = (id: string) => nombrePorId.get(id) ?? "Vendedor";

  for (const c of cambios) {
    if (!(c.comision >= 0 && c.comision <= 60)) {
      return { ok: false, mensaje: `${nombre(c.vendedor_id)}: la comisión debe estar entre 0 y 60%.` };
    }
    if (!(c.factor_pago >= 1 && c.factor_pago <= 200)) {
      return { ok: false, mensaje: `${nombre(c.vendedor_id)}: el factor de pago debe estar entre 1 y 200.` };
    }
    if (!(c.tope_por_numero >= 10)) {
      return { ok: false, mensaje: `${nombre(c.vendedor_id)}: el tope por número debe ser al menos L 10.` };
    }
  }

  for (const c of cambios) {
    const { error } = await supabase.rpc("fn_guardar_parametros", {
      p_vendedor_id: c.vendedor_id,
      // La base guarda fracción; la interfaz muestra porcentaje.
      p_comision: c.comision / 100,
      p_factor_pago: c.factor_pago,
      p_tope_por_numero: c.tope_por_numero,
    });

    if (error) {
      return { ok: false, mensaje: `${nombre(c.vendedor_id)}: ${error.message}` };
    }
  }

  revalidatePath("/vendedores");
  return {
    ok: true,
    mensaje: "Cambios guardados y registrados en auditoría. Aplican a ventas futuras.",
  };
}

/** Ciudades del departamento con su coordenada de referencia. */
export const CIUDADES = {
  "San Pedro Sula": { lat: 15.5045, lng: -88.025 },
  Choloma: { lat: 15.6136, lng: -87.9525 },
  Villanueva: { lat: 15.3167, lng: -88.0 },
  "La Lima": { lat: 15.4386, lng: -87.9161 },
} as const;

export type Ciudad = keyof typeof CIUDADES;

/** Colores para los vendedores nuevos, distintos de los cinco de arranque. */
const PALETA = ["#d97706", "#4f46e5", "#0d9488", "#be185d", "#65a30d"];

export type NuevoVendedor = {
  nombre: string;
  telefono: string;
  correo: string;
  identidad: string;
  ciudad: Ciudad;
  barrio: string;
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

export async function crearVendedor(v: NuevoVendedor): Promise<Resultado> {
  // Mismo orden de validación y mismos mensajes que el prototipo.
  if (v.nombre.trim().length < 5) {
    return { ok: false, mensaje: "Escriba el nombre completo del vendedor." };
  }
  if (!/^\d{4}-\d{4}$/.test(v.telefono.trim())) {
    return { ok: false, mensaje: "Teléfono en formato 9999-9999." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.correo.trim())) {
    return { ok: false, mensaje: "Correo electrónico no válido." };
  }
  if (!(v.comision >= 0 && v.comision <= 60)) {
    return { ok: false, mensaje: "Comisión entre 0 y 60%." };
  }
  if (!(v.factor_pago >= 1)) {
    return { ok: false, mensaje: "El factor de pago debe ser mayor que 1." };
  }
  if (!(v.tope_por_numero >= 10)) {
    return { ok: false, mensaje: "El tope por número debe ser al menos L 10." };
  }
  if (!(v.ciudad in CIUDADES)) {
    return { ok: false, mensaje: "Seleccione una ciudad válida." };
  }

  const supabase = await crearClienteServidor();
  const { lat, lng } = CIUDADES[v.ciudad];

  // Un INSERT directo aquí no funcionaría: `vendedor` no tiene política de
  // escritura en RLS, a propósito. La función genera el código con la tabla
  // bloqueada y crea vendedor y parámetros en una sola transacción, para que
  // no pueda quedar un vendedor sin parámetros vigentes (y por tanto incapaz
  // de vender).
  const { data, error } = await supabase.rpc("fn_crear_vendedor", {
    p_nombre: v.nombre,
    p_telefono: v.telefono,
    p_correo: v.correo,
    p_identidad: v.identidad,
    p_ciudad: v.ciudad,
    p_barrio: v.barrio,
    p_lat: lat,
    p_lng: lng,
    p_color: PALETA[Math.floor(Math.random() * PALETA.length)],
    p_comision: v.comision / 100,
    p_factor_pago: v.factor_pago,
    p_tope_por_numero: v.tope_por_numero,
  });

  if (error) {
    return { ok: false, mensaje: error.message };
  }

  const codigo = data?.[0]?.vendedor_codigo ?? "";

  revalidatePath("/vendedores");
  return {
    ok: true,
    mensaje: `${v.nombre.trim()} creado con código ${codigo}. Puede vender desde el próximo sorteo.`,
  };
}
