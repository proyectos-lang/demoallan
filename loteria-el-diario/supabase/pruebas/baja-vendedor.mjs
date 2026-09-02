/**
 * Bajas de vendedor y cierre de sesión.
 *
 * La cookie de sesión es autofirmada y no se puede revocar: poner
 * `usuario.activo = false` sólo impide el próximo ingreso, y el vendedor recién
 * dado de baja podría seguir vendiendo media jornada con la pantalla que ya
 * tenía abierta. `fn_sesion_vigente` es lo que cierra ese hueco, y aquí es
 * donde se comprueba que dice que no.
 *
 * Crea un vendedor de prueba y lo deja eliminado; no toca a los reales.
 *
 *     node supabase/pruebas/baja-vendedor.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

// El código lo genera la base, así que el vendedor de prueba se reconoce por
// el nombre. Empieza por «ZZZ» para que quede al final de cualquier listado si
// una corrida se interrumpe antes de limpiar.
const NOMBRE = "ZZZ Vendedor de prueba";
const USUARIO = "zzzpruebabaja";

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const limpiar = async () => {
  await sb.from("usuario").delete().eq("usuario", USUARIO);
  const { data: vs } = await sb.from("vendedor").select("id").eq("nombre", NOMBRE);
  for (const v of vs ?? []) {
    await sb.from("usuario").delete().eq("vendedor_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
};

try {
  await limpiar();

  // --- 1. Montaje ---------------------------------------------------------
  console.log("\n1. Montaje");
  // El código lo asigna la base; la comisión va en FRACCIÓN, no en porcentaje.
  const { error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: NOMBRE,
    p_telefono: "9999-9999",
    p_correo: "prueba@eldiario.hn",
    p_identidad: null,
    p_ciudad: "Puerto Cortés",
    p_barrio: null,
    p_lat: null,
    p_lng: null,
    p_color: "#2563eb",
    p_comision: 0.125,
    p_factor_pago: 70,
    p_tope_por_numero: 1000,
  });

  const { data: v } = await sb
    .from("vendedor")
    .select("id, codigo, activo, eliminado_en")
    .eq("nombre", NOMBRE)
    .maybeSingle();

  check("el vendedor de prueba existe", !!v, eAlta?.message ?? "");
  if (!v) throw new Error("sin vendedor de prueba no se puede seguir");

  const { data: usuarioId } = await sb.rpc("fn_crear_usuario", {
    p_usuario: USUARIO,
    p_contrasena: "clave-de-prueba-1",
    p_nombre: NOMBRE,
    p_rol: "vendedor",
    p_vendedor_id: v.id,
  });

  check("tiene cuenta de acceso", !!usuarioId);
  const { data: vigenteAlta } = await sb.rpc("fn_sesion_vigente", { p_usuario_id: usuarioId });
  check("su sesión es válida recién creado", vigenteAlta === true);

  // --- 2. Inactivar -------------------------------------------------------
  console.log("\n2. Inactivar");
  const { error: eOff } = await sb.rpc("fn_desactivar_vendedor", { p_vendedor_id: v.id });
  check("se inactiva sin error", !eOff, eOff?.message ?? "");

  const { data: trasOff } = await sb
    .from("vendedor")
    .select("activo, eliminado_en")
    .eq("id", v.id)
    .maybeSingle();
  check("queda inactivo y sin eliminar", trasOff.activo === false && trasOff.eliminado_en === null);

  const { data: cuentaOff } = await sb
    .from("usuario")
    .select("activo")
    .eq("id", usuarioId)
    .maybeSingle();
  check("su cuenta también queda inactiva", cuentaOff.activo === false);

  const { data: vigenteOff } = await sb.rpc("fn_sesion_vigente", { p_usuario_id: usuarioId });
  check("la sesión deja de ser válida", vigenteOff === false);

  const { data: login } = await sb.rpc("fn_autenticar", {
    p_usuario: USUARIO,
    p_contrasena: "clave-de-prueba-1",
  });
  check("tampoco puede volver a entrar", (login ?? []).length === 0);

  // --- 3. Restablecer la clave no lo resucita ----------------------------
  console.log("\n3. Restablecer contraseña");
  await sb.rpc("fn_restablecer_contrasena", {
    p_usuario_id: usuarioId,
    p_nueva: "otra-clave-de-prueba",
  });
  const { data: trasReset } = await sb
    .from("usuario")
    .select("activo")
    .eq("id", usuarioId)
    .maybeSingle();
  check("restablecer la clave NO reactiva la cuenta", trasReset.activo === false);

  // --- 4. Reactivar -------------------------------------------------------
  console.log("\n4. Reactivar");
  await sb.rpc("fn_activar_vendedor", { p_vendedor_id: v.id });
  const { data: vigenteOn } = await sb.rpc("fn_sesion_vigente", { p_usuario_id: usuarioId });
  check("vuelve a poder entrar", vigenteOn === true);

  // --- 5. Eliminar --------------------------------------------------------
  console.log("\n5. Eliminar");
  await sb.rpc("fn_eliminar_vendedor", { p_vendedor_id: v.id });
  const { data: trasDel } = await sb
    .from("vendedor")
    .select("activo, eliminado_en")
    .eq("id", v.id)
    .maybeSingle();

  check("la fila sigue ahí: nunca se hace DELETE", !!trasDel);
  check("queda marcado como eliminado", trasDel.eliminado_en !== null && trasDel.activo === false);

  const { error: eReactivar } = await sb.rpc("fn_activar_vendedor", { p_vendedor_id: v.id });
  check("un eliminado no se puede reactivar", !!eReactivar, "lo reactivó");

  const { data: vigenteDel } = await sb.rpc("fn_sesion_vigente", { p_usuario_id: usuarioId });
  check("su sesión sigue inválida", vigenteDel === false);
} finally {
  await limpiar();
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
