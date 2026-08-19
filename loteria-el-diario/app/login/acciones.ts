"use server";

import { redirect } from "next/navigation";

import { abrirSesion, cerrarSesion, inicioSegunRol } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

export async function entrar(_estadoPrevio: string | null, datos: FormData) {
  const usuario = String(datos.get("usuario") ?? "").trim();
  const contrasena = String(datos.get("contrasena") ?? "");

  if (!usuario || !contrasena) {
    return "Escriba su usuario y contraseña.";
  }

  // `fn_autenticar` compara con bcrypt dentro de la base: la contraseña en
  // claro no se guarda en ninguna variable de aquí más allá de esta llamada, y
  // el hash nunca sale de la base.
  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_autenticar", {
    p_usuario: usuario,
    p_contrasena: contrasena,
  });

  if (error) {
    return "No se pudo verificar el acceso. Intente de nuevo.";
  }

  const u = data?.[0];

  // No se distingue entre usuario inexistente y contraseña incorrecta: decirlo
  // permitiría averiguar qué cuentas existen.
  if (!u) {
    return "Usuario o contraseña incorrectos.";
  }

  await abrirSesion({
    id: u.r_id,
    nombre: u.r_nombre,
    rol: u.r_rol,
    vendedor_id: u.r_vendedor_id,
  });

  // Una contraseña entregada por administración es de un solo uso: se cambia
  // antes de poder hacer nada.
  redirect(u.r_debe_cambiar ? "/clave" : inicioSegunRol(u.r_rol));
}

export async function salir() {
  await cerrarSesion();
  redirect("/login");
}
