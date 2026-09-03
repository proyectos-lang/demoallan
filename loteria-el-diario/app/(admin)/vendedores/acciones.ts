"use server";

import { revalidatePath } from "next/cache";

import { crearClienteServidor } from "@/lib/supabase/server";
import { crearClienteServicio } from "@/lib/supabase/admin";
import { generarContrasena } from "@/lib/clave";
import { CIUDADES, type Ciudad } from "@/lib/ciudades";

export type Cambio = {
  vendedor_id: string;
  /** Porcentaje tal como se teclea (12.5), no fracción. */
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

export type Resultado = { ok: true; mensaje: string } | { ok: false; mensaje: string };

/** El alta de un vendedor devuelve además sus credenciales, una sola vez. */
export type ResultadoAlta =
  | { ok: true; mensaje: string; usuario?: string; contrasena?: string }
  | { ok: false; mensaje: string };

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

export async function crearVendedor(v: NuevoVendedor): Promise<ResultadoAlta> {
  /*
   * NADA DE AQUÍ DENTRO PUEDE DERRIBAR LA PANTALLA.
   *
   * Una acción que escribe y luego lanza deja lo peor de los dos mundos: el
   * dato guardado y el usuario convencido de que no se guardó. Además, el
   * motivo real no llega al navegador —Next sólo manda un `digest`—, así que
   * desde fuera el fallo es indistinguible de una consulta lenta.
   *
   * Envolviendo aquí, cualquier fallo vuelve como texto en la pantalla, que es
   * donde puede leerlo quien lo está sufriendo.
   */
  try {
    return await altaDeVendedor(v);
  } catch (e) {
    return {
      ok: false,
      mensaje: `No se pudo completar el alta: ${
        e instanceof Error ? e.message : String(e)
      }. Compruebe en la lista si el vendedor quedó creado antes de repetir.`,
    };
  }
}

async function altaDeVendedor(v: NuevoVendedor): Promise<ResultadoAlta> {
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
  const vendedorId = data?.[0]?.vendedor_id as string | undefined;

  // El acceso se crea en el mismo gesto. Dejarlo para un segundo paso es cómo
  // acaban existiendo vendedores dados de alta que no pueden entrar a vender.
  //
  // Si esto falla, el vendedor YA está creado: se informa y se deja el alta de
  // acceso para la propia pantalla, en vez de fingir que no se creó nada o de
  // borrar un vendedor que quizá ya tiene parámetros correctos.
  let usuario: string | undefined;
  let contrasena: string | undefined;
  let aviso = "";

  if (vendedorId) {
    /*
     * A PARTIR DE AQUÍ EL VENDEDOR YA EXISTE, y nada puede tumbar la acción.
     *
     * Antes, `crearClienteServicio()` quedaba fuera de toda protección: lanza
     * una excepción si falta `SUPABASE_SERVICE_ROLE_KEY` en el entorno, y
     * `fn_crear_usuario` puede reventar por causas que no son un `error` de
     * PostgREST —una caída de red, un tiempo de espera agotado—. Cualquiera de
     * las dos convertía el alta en un 500 DESPUÉS de haber creado al vendedor:
     * la pantalla decía que no se pudo, y el vendedor estaba creado.
     *
     * El `try` no esconde el fallo, lo degrada: el vendedor queda dado de alta
     * —que es lo caro y ya está hecho— y el acceso se ofrece desde la tabla,
     * que es lo que ya hacía cuando el error venía por el otro camino.
     */
    try {
      usuario = codigo.replace("-", "").toLowerCase();
      contrasena = generarContrasena();

      const servicio = crearClienteServicio();
      const { error: eAcceso } = await servicio.rpc("fn_crear_usuario", {
        p_usuario: usuario,
        p_contrasena: contrasena,
        p_nombre: v.nombre.trim(),
        p_rol: "vendedor",
        p_vendedor_id: vendedorId,
      });

      if (eAcceso) {
        usuario = undefined;
        contrasena = undefined;
        aviso = ` No se pudo crear su acceso (${eAcceso.message}); puede darlo de alta desde la tabla.`;
      }
    } catch (e) {
      usuario = undefined;
      contrasena = undefined;
      // El motivo va en el aviso: sin él, quien lo ve no puede distinguir un
      // usuario repetido de una variable de entorno que falta en el servidor.
      aviso = ` No se pudo crear su acceso (${
        e instanceof Error ? e.message : "error inesperado"
      }); puede darlo de alta desde la tabla.`;
    }
  }

  // Si el refresco de la pantalla falla, el alta ya se hizo: no puede
  // convertirse en un error que haga pensar que no se creó nada.
  try {
    revalidatePath("/vendedores");
  } catch {
    // Sin nada que hacer: la lista se verá al recargar.
  }

  return {
    ok: true,
    usuario,
    contrasena,
    mensaje:
      `${v.nombre.trim()} creado con código ${codigo}. Puede vender desde el próximo sorteo.` +
      aviso,
  };
}
