"use server";

import { redirect } from "next/navigation";

import { inicioSegunRol, sesionActual } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

export async function cambiarClave(_previo: string | null, datos: FormData) {
  const sesion = await sesionActual();
  if (!sesion) redirect("/login");

  const actual = String(datos.get("actual") ?? "");
  const nueva = String(datos.get("nueva") ?? "");
  const repetida = String(datos.get("repetida") ?? "");

  if (!actual || !nueva) return "Complete los dos campos.";
  if (nueva.length < 8) return "La contraseña nueva debe tener al menos 8 caracteres.";
  if (nueva !== repetida) return "Las dos contraseñas nuevas no coinciden.";
  if (nueva === actual) return "La contraseña nueva tiene que ser distinta de la actual.";

  // La actual se exige aunque ya haya sesión: si alguien se hiciera con la
  // cookie, sin la contraseña no puede quedarse con la cuenta.
  const supabase = crearClienteServicio();
  const { error } = await supabase.rpc("fn_cambiar_contrasena", {
    p_usuario_id: sesion.id,
    p_actual: actual,
    p_nueva: nueva,
  });

  if (error) {
    return error.message.includes("actual no es correcta")
      ? "La contraseña actual no es correcta."
      : error.message;
  }

  redirect(inicioSegunRol(sesion.rol));
}
