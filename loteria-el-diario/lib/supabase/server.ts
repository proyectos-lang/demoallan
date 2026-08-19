import "server-only";

import { crearClienteServicio } from "./admin";

/**
 * Cliente para Server Components, Server Actions y Route Handlers.
 *
 * ANTES: hablaba con PostgREST llevando el JWT de Supabase Auth, y RLS
 * recortaba las filas según el rol que ese token declaraba. La base era la que
 * decidía quién veía qué.
 *
 * AHORA: los usuarios viven en `allan.usuario` y la sesión la firma este mismo
 * servidor, así que no hay JWT que enviar y RLS no tiene de dónde leer el rol.
 * Se habla con la base como servicio, y **el recorte por rol pasa a ser
 * responsabilidad de quien consulta**.
 *
 * Lo que hace asumible el cambio es que el navegador nunca llega a PostgREST:
 * todo pasa por componentes y acciones de servidor, y la llave de servicio no
 * sale de aquí (`server-only` hace fallar el build si alguien la arrastra a un
 * componente de cliente).
 *
 * En la práctica esto sólo afecta a las pantallas del vendedor, que son las
 * únicas que muestran un subconjunto: usan `fn_mi_dia` y `fn_mis_tickets`, que
 * reciben el `vendedor_id` de la sesión de forma explícita. Las pantallas
 * administrativas ya veían todo.
 *
 * Se mantiene el nombre y la firma `async` para no tocar las dieciséis
 * pantallas que ya lo usan; el `await` sobra pero es inofensivo.
 */
export async function crearClienteServidor() {
  return crearClienteServicio();
}
