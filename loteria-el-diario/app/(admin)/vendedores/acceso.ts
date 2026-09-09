"use server";

import { revalidatePath } from "next/cache";

import { generarContrasena } from "@/lib/clave";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

/**
 * Alta de acceso para un vendedor.
 *
 * El usuario se deriva del código (`V-006` → `v006`): es corto, no colisiona
 * porque el código ya es único, y un vendedor lo recuerda sin apuntarlo. La
 * contraseña se genera aquí y se enseña UNA vez, para que administración se la
 * dicte; queda marcada como de un solo uso, así que el vendedor la cambia antes
 * de poder hacer nada.
 */

export type ResultadoAcceso =
  | { ok: true; usuario: string; contrasena: string; mensaje: string }
  | { ok: false; mensaje: string };

async function exigeAdministrador(): Promise<string | null> {
  const s = await sesionActual();
  if (!s) return "La sesión venció. Vuelva a entrar.";
  if (s.rol !== "administrador") return "Sólo un administrador puede dar accesos.";
  return null;
}

/** Crea la cuenta de un vendedor que ya existe en el padrón. */
export async function crearAcceso(vendedorId: string): Promise<ResultadoAcceso> {
  const veto = await exigeAdministrador();
  if (veto) return { ok: false, mensaje: veto };

  const supabase = crearClienteServicio();

  const { data: v } = await supabase
    .from("vendedor")
    .select("id, codigo, nombre")
    .eq("id", vendedorId)
    .maybeSingle();

  if (!v) return { ok: false, mensaje: "Ese vendedor no existe." };

  const usuario = v.codigo.replace("-", "").toLowerCase();
  const contrasena = generarContrasena();

  const { error } = await supabase.rpc("fn_crear_usuario", {
    p_usuario: usuario,
    p_contrasena: contrasena,
    p_nombre: v.nombre,
    p_rol: "vendedor",
    p_vendedor_id: v.id,
  });

  if (error) {
    // 23505 es violación de índice único: o el usuario ya existe, o el vendedor
    // ya tiene cuenta. Las dos cosas significan lo mismo para quien lo pide.
    if (error.code === "23505" || /duplicate|unique/i.test(error.message)) {
      return { ok: false, mensaje: `${v.nombre} ya tiene un acceso creado.` };
    }
    return { ok: false, mensaje: error.message };
  }

  revalidatePath("/vendedores");
  return {
    ok: true,
    usuario,
    contrasena,
    mensaje: `Acceso creado para ${v.nombre}. Anote la contraseña: no se vuelve a mostrar.`,
  };
}

/**
 * Contraseña nueva para un vendedor que perdió la suya.
 *
 * SE PUEDE DICTAR O SE PUEDE GENERAR.
 *
 * Generada es lo de siempre y sigue siendo lo sensato cuando el vendedor está
 * delante: sale de `generarContrasena`, nadie más la ha visto nunca, y se
 * muestra una sola vez.
 *
 * Pero muchas veces esto se resuelve por teléfono, y deletrear ocho caracteres
 * aleatorios a alguien que está atendiendo acaba en tres intentos fallidos y
 * otra llamada. Poder poner una acordada —«pongámosle su nombre y el año»—
 * convierte eso en una frase.
 *
 * EN LOS DOS CASOS EL VENDEDOR LA CAMBIA AL ENTRAR. Lo hace la base, que pone
 * `debe_cambiar` en `fn_restablecer_contrasena`, y no se toca: una contraseña
 * que ha pasado por el teléfono de otra persona no puede quedarse como la
 * definitiva. La manual sirve para entrar una vez, no para siempre.
 */
export async function restablecerAcceso(
  vendedorId: string,
  /*
   * La contraseña a poner, o vacío para que se genere.
   *
   * Llega del navegador y no se valida aquí más allá del largo: lo que manda
   * es `fn_restablecer_contrasena`, que exige ocho caracteres y es la única
   * que escribe el hash. Repetir aquí la regla sirve para dar el mensaje
   * inmediato, no para sustituirla.
   */
  manual?: string,
): Promise<ResultadoAcceso> {
  const veto = await exigeAdministrador();
  if (veto) return { ok: false, mensaje: veto };

  const puesta = (manual ?? "").trim();
  if (puesta && puesta.length < 8) {
    return { ok: false, mensaje: "La contraseña debe tener al menos 8 caracteres." };
  }

  const supabase = crearClienteServicio();

  const { data: filas } = await supabase.rpc("fn_accesos_vendedor");
  const acceso = (filas ?? []).find((f) => f.r_vendedor_id === vendedorId);
  if (!acceso) return { ok: false, mensaje: "Ese vendedor todavía no tiene acceso." };

  const { data: u } = await supabase
    .from("usuario")
    .select("id")
    .eq("vendedor_id", vendedorId)
    .maybeSingle();

  if (!u) return { ok: false, mensaje: "No se encontró la cuenta." };

  const contrasena = puesta || generarContrasena();
  const { error } = await supabase.rpc("fn_restablecer_contrasena", {
    p_usuario_id: u.id,
    p_nueva: contrasena,
  });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/vendedores");
  return {
    ok: true,
    usuario: acceso.r_usuario,
    contrasena,
    // La generada no se vuelve a ver nunca; la dictada la sabe quien la puso,
    // así que el aviso cambia. Decir «anótela» de una que uno mismo eligió
    // suena a que el sistema no se entera de lo que acaba de pasar.
    mensaje: puesta
      ? "Contraseña cambiada. El vendedor tendrá que ponerse otra al entrar."
      : "Contraseña nueva. Anótela: no se vuelve a mostrar.",
  };
}
