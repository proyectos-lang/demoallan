/**
 * Crea un usuario de acceso y su perfil en allan.usuario_perfil.
 *
 *     node supabase/crear-usuario.mjs <correo> <contraseña> <rol> [codigo-vendedor]
 *
 * Roles: administrador | auditor | digitador | vendedor
 * El rol `vendedor` exige el código del vendedor al que queda enlazado.
 *
 * Usa la Admin API, así que el correo queda confirmado de una vez: este sistema
 * no manda correos de verificación, las cuentas las crea administración.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  readFileSync(join(raiz, ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const [correo, contrasena, rol, codigoVendedor] = process.argv.slice(2);

if (!correo || !contrasena || !rol) {
  console.error("Uso: node supabase/crear-usuario.mjs <correo> <contraseña> <rol> [codigo-vendedor]");
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

const U = env.NEXT_PUBLIC_SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
const auth = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json" };
const rest = { ...auth, "Accept-Profile": "allan", "Content-Profile": "allan" };

let vendedorId = null;
if (codigoVendedor) {
  const r = await fetch(`${U}/rest/v1/vendedor?codigo=eq.${codigoVendedor}&select=id,nombre`, {
    headers: rest,
  });
  const v = await r.json();
  if (!v.length) {
    console.error(`No existe el vendedor ${codigoVendedor}.`);
    process.exit(1);
  }
  vendedorId = v[0].id;
}

const alta = await fetch(`${U}/auth/v1/admin/users`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ email: correo, password: contrasena, email_confirm: true }),
});
const usuario = await alta.json();

if (!alta.ok) {
  console.error("No se pudo crear el usuario:", JSON.stringify(usuario));
  process.exit(1);
}

const perfil = await fetch(`${U}/rest/v1/usuario_perfil`, {
  method: "POST",
  headers: { ...rest, Prefer: "return=representation" },
  body: JSON.stringify({
    id: usuario.id,
    rol,
    vendedor_id: vendedorId,
    nombre: correo.split("@")[0],
  }),
});

if (!perfil.ok) {
  console.error("Usuario creado pero falló el perfil:", await perfil.text());
  console.error("Borrando el usuario para no dejarlo huérfano…");
  await fetch(`${U}/auth/v1/admin/users/${usuario.id}`, { method: "DELETE", headers: auth });
  process.exit(1);
}

console.log(`Usuario creado: ${correo}  ·  rol ${rol}${codigoVendedor ? `  ·  ${codigoVendedor}` : ""}`);
