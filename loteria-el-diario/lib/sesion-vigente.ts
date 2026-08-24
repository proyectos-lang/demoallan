import "server-only";

import { cerrarSesion, sesionActual, type Sesion } from "@/lib/sesion";
import { crearClienteServicio } from "@/lib/supabase/admin";

/**
 * La sesión, pero comprobando contra la base que la cuenta siga sirviendo.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * La cookie de sesión es autocontenida: lleva el rol dentro y va firmada con
 * HMAC, sin ningún registro en el servidor. Eso la hace barata —cero consultas
 * por petición— pero también **irrevocable**: dar de baja a un vendedor ponía
 * `usuario.activo = false` y con eso sólo se le impedía el PRÓXIMO ingreso. La
 * sesión que ya tuviera abierta seguía viva hasta doce horas, vendiendo.
 *
 * `fn_sesion_vigente` cierra ese hueco: mira la cuenta y, si es de vendedor,
 * también que el vendedor siga activo y sin eliminar.
 *
 * DÓNDE SE LLAMA, Y DÓNDE NO
 * --------------------------
 * Aquí y no en `proxy.ts`. El proxy corre en CADA petición —incluida cada
 * carga parcial de navegación— y meterle una consulta lo pagaría todo el
 * mundo; este proyecto ya tuvo que poner `prefetch={false}` en la barra
 * lateral por presión sobre la base. En cambio los layouts se renderizan una
 * vez por página, que es la granularidad que se necesita: la baja surte efecto
 * en la siguiente navegación.
 *
 * Los layouts no cubren las Server Actions —una acción no vuelve a renderizar
 * el layout—, así que las que escriben la llaman también. Sin eso, un vendedor
 * con la pantalla abierta podría seguir registrando ventas.
 */
export async function sesionVigente(): Promise<Sesion | null> {
  const sesion = await sesionActual();
  if (!sesion) return null;

  const supabase = crearClienteServicio();
  const { data, error } = await supabase.rpc("fn_sesion_vigente", {
    p_usuario_id: sesion.id,
  });

  // Ante un fallo de la base se deja pasar. Cortarle la sesión a toda la
  // operación porque la red parpadeó es peor que el riesgo de que un vendedor
  // dado de baja siga un minuto más: la venta la vuelve a atajar
  // `fn_registrar_ticket`, que exige `vendedor.activo`.
  if (error) return sesion;

  if (data === false) {
    await cerrarSesion();
    return null;
  }

  return sesion;
}
