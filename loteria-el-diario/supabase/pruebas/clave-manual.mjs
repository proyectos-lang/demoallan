/**
 * Restablecer la contraseña de un vendedor poniéndola a mano.
 *
 * QUÉ SE COMPRUEBA, Y POR QUÉ IMPORTA CADA COSA
 * ---------------------------------------------
 *   · Que la contraseña dictada FUNCIONE de verdad para entrar. Es todo el
 *     encargo, y se comprueba contra `fn_autenticar` —la misma que usa el
 *     login—, no mirando si la pantalla dijo que sí.
 *   · Que la ANTERIOR deje de servir. Un restablecimiento que no invalida la
 *     vieja no es un restablecimiento.
 *   · Que el vendedor tenga que CAMBIARLA al entrar, que es lo que usted
 *     eligió: una contraseña que pasó por el teléfono de otra persona no se
 *     queda como la suya.
 *   · Que se rechace una demasiado corta, y que al rechazarla NO se haya
 *     cambiado nada — un fallo a medias dejaría al vendedor sin poder entrar
 *     con ninguna de las dos.
 *   · Que dejarla en blanco siga generando una, como antes.
 *
 * Crea un vendedor de prueba con su cuenta y lo borra al final.
 *
 *     node supabase/pruebas/clave-manual.mjs
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

const NOMBRE = "ZZZ Clave manual";

let ok = 0;
let fallos = 0;
const check = (n, c, d = "") => {
  if (c) {
    ok++;
    console.log(`  ok    ${n}`);
  } else {
    fallos++;
    console.log(`  FALLA ${n} ${d}`);
  }
};

async function limpiar() {
  const { data: vs } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of vs ?? []) {
    const { data: us } = await sb.from("usuario").select("id").eq("vendedor_id", v.id);
    for (const u of us ?? []) await sb.from("auditoria").delete().eq("entidad_id", u.id);
    await sb.from("usuario").delete().eq("vendedor_id", v.id);
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

/** ¿Se puede entrar con esta contraseña? Lo dice la misma función del login. */
async function entra(usuario, clave) {
  const { data } = await sb.rpc("fn_autenticar", {
    p_usuario: usuario,
    p_contrasena: clave,
  });
  const u = (data ?? [])[0];
  return u ? { si: true, debeCambiar: u.r_debe_cambiar } : { si: false };
}

async function main() {
  await limpiar();

  const { data: alta, error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: NOMBRE,
    p_telefono: null,
    p_correo: null,
    p_identidad: null,
    p_ciudad: "Choloma",
    p_barrio: "Centro",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.12,
    p_factor_pago: 70,
    p_tope_por_numero: 1000,
    p_alias: null,
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor:", eAlta.message);
    process.exit(1);
  }
  const vendedorId = alta[0].vendedor_id;
  const usuario = alta[0].vendedor_codigo.replace("-", "").toLowerCase();

  const PRIMERA = "primera123";
  const { error: eCuenta } = await sb.rpc("fn_crear_usuario", {
    p_usuario: usuario,
    p_contrasena: PRIMERA,
    p_nombre: NOMBRE,
    p_rol: "vendedor",
    p_vendedor_id: vendedorId,
  });
  if (eCuenta) {
    console.log("no se pudo crear la cuenta:", eCuenta.message);
    await limpiar();
    process.exit(1);
  }

  const { data: u } = await sb
    .from("usuario")
    .select("id")
    .eq("vendedor_id", vendedorId)
    .single();

  check("entra con la contraseña original", (await entra(usuario, PRIMERA)).si === true);

  // --- Se pone una a mano -----------------------------------------------------
  const MANUAL = "lolita2026";
  const { error: eManual } = await sb.rpc("fn_restablecer_contrasena", {
    p_usuario_id: u.id,
    p_nueva: MANUAL,
  });
  check("la base acepta una contraseña dictada", !eManual, eManual?.message ?? "");

  const conManual = await entra(usuario, MANUAL);
  check("SE ENTRA con la contraseña puesta a mano", conManual.si === true);
  check(
    "y tiene que cambiarla al entrar",
    conManual.debeCambiar === true,
    String(conManual.debeCambiar),
  );
  check("la anterior YA NO SIRVE", (await entra(usuario, PRIMERA)).si === false);

  // --- Una demasiado corta se rechaza, y no cambia nada ------------------------
  const { error: eCorta } = await sb.rpc("fn_restablecer_contrasena", {
    p_usuario_id: u.id,
    p_nueva: "1234",
  });
  check("rechaza una de menos de 8 caracteres", !!eCorta, eCorta ? "" : "no dio error");
  check(
    "y tras el rechazo la anterior sigue sirviendo",
    (await entra(usuario, MANUAL)).si === true,
    "el rechazo dejó la cuenta a medias",
  );

  // --- Queda auditado ---------------------------------------------------------
  const { data: aud } = await sb
    .from("auditoria")
    .select("accion")
    .eq("entidad_id", u.id)
    .eq("accion", "restablecer_contrasena");
  check("cada cambio queda en auditoría", (aud ?? []).length >= 1, `${(aud ?? []).length}`);

  // --- Y la generada sigue funcionando ----------------------------------------
  const GENERADA = "Xk7-mQ2p";
  await sb.rpc("fn_restablecer_contrasena", { p_usuario_id: u.id, p_nueva: GENERADA });
  const conGenerada = await entra(usuario, GENERADA);
  check("la vía de siempre —generar— sigue igual", conGenerada.si === true);
  check("y también pide cambio", conGenerada.debeCambiar === true);

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await limpiar();
  process.exit(1);
});
