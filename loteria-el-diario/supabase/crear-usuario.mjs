/**
 * Crea una cuenta de acceso en allan.usuario.
 *
 *     node supabase/crear-usuario.mjs <usuario> <contraseña> <rol> [codigo-vendedor]
 *
 * Roles: administrador | auditor | digitador | vendedor
 * El rol `vendedor` exige el código del vendedor al que queda enlazado.
 *
 * Las cuentas de vendedor normalmente NO se crean con esto: se crean solas al
 * dar de alta al vendedor desde la pantalla de vendedores. Este guion es para
 * el primer administrador —cuando todavía no hay nadie que pueda entrar— y para
 * los perfiles de auditor y digitador.
 *
 * La contraseña se pasa por argumento a propósito y no se guarda en ningún
 * archivo: así no acaba en el repositorio.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  readFileSync(join(raiz, ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const [usuario, contrasena, rol, codigoVendedor] = process.argv.slice(2);

if (!usuario || !contrasena || !rol) {
  console.error(
    "Uso: node supabase/crear-usuario.mjs <usuario> <contraseña> <rol> [codigo-vendedor]",
  );
  process.exit(1);
}

const ROLES = ["administrador", "auditor", "digitador", "vendedor"];
if (!ROLES.includes(rol)) {
  console.error(`Rol no válido: ${rol}. Opciones: ${ROLES.join(", ")}`);
  process.exit(1);
}
if (rol === "vendedor" && !codigoVendedor) {
  console.error("El rol vendedor necesita el código del vendedor (por ejemplo V-003).");
  process.exit(1);
}
if (contrasena.length < 8) {
  console.error("La contraseña debe tener al menos 8 caracteres.");
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

let vendedorId = null;
let nombre = usuario;

if (codigoVendedor) {
  const { data } = await sb
    .from("vendedor")
    .select("id, nombre")
    .eq("codigo", codigoVendedor)
    .maybeSingle();

  if (!data) {
    console.error(`No existe el vendedor ${codigoVendedor}.`);
    process.exit(1);
  }
  vendedorId = data.id;
  nombre = data.nombre;
}

const { error } = await sb.rpc("fn_crear_usuario", {
  p_usuario: usuario,
  p_contrasena: contrasena,
  p_nombre: nombre,
  p_rol: rol,
  p_vendedor_id: vendedorId,
});

if (error) {
  console.error("No se pudo crear:", error.message);
  process.exit(1);
}

console.log(`Usuario creado: ${usuario}  ·  rol ${rol}${codigoVendedor ? `  ·  ${codigoVendedor}` : ""}`);
console.log("Tendrá que cambiar la contraseña la primera vez que entre.");
