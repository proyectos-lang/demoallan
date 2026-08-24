"use server";

import { revalidatePath } from "next/cache";

import { sesionActual } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

/**
 * Bajas y altas de vendedor.
 *
 * `allan.vendedor.activo` existía desde el primer día con el comentario «baja
 * lógica; nunca DELETE», pero nadie la escribía. Esto es lo que faltaba.
 *
 * Inactivar es reversible; eliminar no lo es, pero tampoco borra nada: marca
 * `eliminado_en` y saca al vendedor del padrón. Sus tickets, sus líneas y sus
 * liquidaciones se quedan donde están — el histórico tiene que seguir
 * reconstruyendo el pasado.
 *
 * LA GUARDA VA AQUÍ, NO EN LA BASE. Las funciones SQL llaman a `fn_exige`,
 * pero desde que la aplicación habla como `service_role` esa comprobación
 * retorna sin mirar nada. El patrón bueno es el de `acceso.ts`, no el de
 * `acciones.ts`, que no comprueba sesión.
 */

export type ResultadoEstado = { ok: true; mensaje: string } | { ok: false; mensaje: string };

async function exigeAdministrador(): Promise<string | null> {
  const s = await sesionActual();
  if (!s) return "La sesión venció. Vuelva a entrar.";
  if (s.rol !== "administrador") return "Sólo un administrador puede dar de baja a un vendedor.";
  return null;
}

async function usuarioActual(): Promise<string | null> {
  const s = await sesionActual();
  return s?.id ?? null;
}

function refrescar() {
  revalidatePath("/vendedores");
  revalidatePath("/control");
  revalidatePath("/reportes");
  revalidatePath("/punto-de-venta");
}

/** Baja temporal. El vendedor deja de vender y su cuenta deja de entrar. */
export async function inactivarVendedor(vendedorId: string): Promise<ResultadoEstado> {
  const veto = await exigeAdministrador();
  if (veto) return { ok: false, mensaje: veto };

  const supabase = crearClienteServicio();
  const { error } = await supabase.rpc("fn_desactivar_vendedor", {
    p_vendedor_id: vendedorId,
    p_usuario_id: await usuarioActual(),
  });

  if (error) return { ok: false, mensaje: error.message };

  refrescar();
  return { ok: true, mensaje: "Vendedor inactivado. Su sesión se cierra en la siguiente pantalla." };
}

export async function reactivarVendedor(vendedorId: string): Promise<ResultadoEstado> {
  const veto = await exigeAdministrador();
  if (veto) return { ok: false, mensaje: veto };

  const supabase = crearClienteServicio();
  const { error } = await supabase.rpc("fn_activar_vendedor", {
    p_vendedor_id: vendedorId,
    p_usuario_id: await usuarioActual(),
  });

  if (error) return { ok: false, mensaje: error.message };

  refrescar();
  return { ok: true, mensaje: "Vendedor reactivado. Ya puede volver a entrar y a vender." };
}

/**
 * Baja definitiva.
 *
 * Se exige redigitar el código, como en la captura del número ganador: es
 * irreversible y no debe poder dispararse con un clic descuidado. La
 * comprobación se repite en el servidor porque la del modal es del navegador.
 */
export async function eliminarVendedor(
  vendedorId: string,
  codigoConfirmado: string,
): Promise<ResultadoEstado> {
  const veto = await exigeAdministrador();
  if (veto) return { ok: false, mensaje: veto };

  const supabase = crearClienteServicio();

  const { data: v } = await supabase
    .from("vendedor")
    .select("id, codigo")
    .eq("id", vendedorId)
    .maybeSingle();

  if (!v) return { ok: false, mensaje: "Ese vendedor no existe." };

  if (codigoConfirmado.trim().toUpperCase() !== v.codigo.toUpperCase()) {
    return { ok: false, mensaje: `El código no coincide. Escriba ${v.codigo} para confirmar.` };
  }

  const { error } = await supabase.rpc("fn_eliminar_vendedor", {
    p_vendedor_id: vendedorId,
    p_usuario_id: await usuarioActual(),
  });

  if (error) return { ok: false, mensaje: error.message };

  refrescar();
  return {
    ok: true,
    mensaje: `${v.codigo} eliminado. Su historial de ventas y liquidaciones queda intacto.`,
  };
}
