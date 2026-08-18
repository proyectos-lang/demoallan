"use server";

import { redirect } from "next/navigation";

import { crearClienteServidor } from "@/lib/supabase/server";

export async function entrar(_estadoPrevio: string | null, datos: FormData) {
  const correo = String(datos.get("correo") ?? "").trim();
  const contrasena = String(datos.get("contrasena") ?? "");

  if (!correo || !contrasena) {
    return "Escriba su correo y contraseña.";
  }

  const supabase = await crearClienteServidor();
  const { error } = await supabase.auth.signInWithPassword({
    email: correo,
    password: contrasena,
  });

  // No se distingue entre correo inexistente y contraseña incorrecta: decirlo
  // permitiría averiguar qué cuentas existen.
  if (error) {
    return "Correo o contraseña incorrectos.";
  }

  redirect("/tablero");
}

export async function salir() {
  const supabase = await crearClienteServidor();
  await supabase.auth.signOut();
  redirect("/login");
}
