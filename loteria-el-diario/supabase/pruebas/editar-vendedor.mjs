/**
 * Edición de la ficha de un vendedor.
 *
 * Lo que se comprueba, en orden de importancia:
 *
 *   · Que la `zona` se REHAGA al cambiar ciudad o barrio. Es el punto donde
 *     una edición a medias hace más daño: la ficha diría una ciudad y el mapa
 *     y los informes seguirían agrupando por la vieja, sin que nada avise.
 *   · Que el alias se pueda BORRAR. Ponerlo es fácil; lo que se rompe siempre
 *     es vaciarlo, porque una cadena vacía que no se convierte en nulo deja el
 *     ticket imprimiendo un rótulo en blanco.
 *   · Que el código no cambie y que se apliquen las validaciones del alta.
 *   · Que cada cambio quede auditado campo a campo.
 *
 * Crea un vendedor de prueba y lo borra al final; no toca a los reales.
 *
 *     node supabase/pruebas/editar-vendedor.mjs
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

const NOMBRE = "ZZZ Vendedor para editar";

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

const ficha = async (id) =>
  (
    await sb
      .from("vendedor")
      .select("codigo, nombre, alias, telefono, correo, identidad, ciudad, barrio, zona")
      .eq("id", id)
      .single()
  ).data;

async function limpiar() {
  const { data } = await sb.from("vendedor").select("id").like("nombre", `${NOMBRE}%`);
  for (const v of data ?? []) {
    await sb.from("auditoria").delete().eq("entidad_id", v.id);
    await sb.from("parametro_vendedor").delete().eq("vendedor_id", v.id);
    await sb.from("vendedor").delete().eq("id", v.id);
  }
}

async function main() {
  await limpiar();

  const { data: alta, error: eAlta } = await sb.rpc("fn_crear_vendedor", {
    p_nombre: NOMBRE,
    p_telefono: "9999-1111",
    p_correo: "antes@ejemplo.com",
    p_identidad: "0501-1990-00001",
    p_ciudad: "Choloma",
    p_barrio: "Barrio Viejo",
    p_lat: null,
    p_lng: null,
    p_color: "#334155",
    p_comision: 0.125,
    p_factor_pago: 70,
    p_tope_por_numero: 1000,
    p_alias: "ALIAS VIEJO",
  });
  if (eAlta) {
    console.log("no se pudo crear el vendedor de prueba:", eAlta.message);
    process.exit(1);
  }

  const id = alta[0].vendedor_id;
  const codigoOriginal = alta[0].vendedor_codigo;
  const NOMBRE2 = `${NOMBRE} SA`;

  // --- Edición completa ----------------------------------------------------
  const { error: e1 } = await sb.rpc("fn_editar_vendedor", {
    p_vendedor_id: id,
    p_nombre: NOMBRE2,
    p_alias: "ALIAS NUEVO",
    p_telefono: "9999-2222",
    p_correo: "despues@ejemplo.com",
    p_identidad: "0501-1990-00002",
    p_ciudad: "La Lima",
    p_barrio: "Barrio Nuevo",
  });
  check("la edición no da error", !e1, e1?.message ?? "");

  let f = await ficha(id);
  check("el nombre cambió", f.nombre === NOMBRE2, f.nombre);
  check("el alias cambió", f.alias === "ALIAS NUEVO", f.alias);
  check("el teléfono cambió", f.telefono === "9999-2222", f.telefono);
  check("el correo cambió", f.correo === "despues@ejemplo.com", f.correo);
  check("la identidad cambió", f.identidad === "0501-1990-00002", f.identidad);
  check("la ciudad cambió", f.ciudad === "La Lima", f.ciudad);
  check("el barrio cambió", f.barrio === "Barrio Nuevo", f.barrio);
  // Lo que de verdad importa de esta prueba.
  check("la ZONA se rehízo", f.zona === "La Lima · Barrio Nuevo", f.zona);
  check("el código NO cambió", f.codigo === codigoOriginal, f.codigo);

  // --- Vaciar el alias -----------------------------------------------------
  await sb.rpc("fn_editar_vendedor", {
    p_vendedor_id: id,
    p_nombre: NOMBRE2,
    p_alias: "   ",
    p_ciudad: "La Lima",
    p_barrio: "Barrio Nuevo",
  });
  f = await ficha(id);
  check("el alias en blanco queda NULO", f.alias === null, JSON.stringify(f.alias));

  const { data: rotulo } = await sb.rpc("fn_rotulo", { p_alias: f.alias, p_nombre: f.nombre });
  check("sin alias, el ticket imprime el nombre", rotulo === f.nombre, String(rotulo));

  // --- Los opcionales se pueden borrar -------------------------------------
  await sb.rpc("fn_editar_vendedor", {
    p_vendedor_id: id,
    p_nombre: NOMBRE2,
    p_telefono: null,
    p_correo: null,
    p_ciudad: "La Lima",
  });
  f = await ficha(id);
  check("el teléfono se puede dejar en blanco", f.telefono === null, String(f.telefono));
  check("el correo se puede dejar en blanco", f.correo === null, String(f.correo));
  check("sin barrio, la zona lo dice", f.zona === "La Lima · sin barrio asignado", f.zona);

  // --- Normalización de la ciudad ------------------------------------------
  // Depende de que exista OTRO vendedor en esa ciudad: la función se excluye a
  // sí misma a propósito, para no confirmarse su propio error de escritura.
  const { data: otros } = await sb
    .from("vendedor")
    .select("ciudad")
    .ilike("ciudad", "la lima")
    .neq("id", id)
    .limit(1);

  if (otros?.length) {
    await sb.rpc("fn_editar_vendedor", {
      p_vendedor_id: id,
      p_nombre: NOMBRE2,
      p_ciudad: "LA LIMA",
    });
    f = await ficha(id);
    check("la ciudad adopta la escritura ya registrada", f.ciudad === otros[0].ciudad, f.ciudad);
  } else {
    console.log("  (se omite la normalización: ningún otro vendedor en La Lima)");
  }

  // --- Rechazos ------------------------------------------------------------
  const rechaza = async (nombre, args) => {
    const { error } = await sb.rpc("fn_editar_vendedor", {
      p_vendedor_id: id,
      p_nombre: NOMBRE2,
      p_ciudad: "La Lima",
      ...args,
    });
    check(nombre, !!error, error ? "" : "no dio error");
  };

  await rechaza("rechaza un nombre corto", { p_nombre: "ZZZ" });
  await rechaza("rechaza sin ciudad", { p_ciudad: "" });
  await rechaza("rechaza un alias de más de 30", { p_alias: "X".repeat(31) });
  await rechaza("rechaza un teléfono mal formado", { p_telefono: "99992222" });
  await rechaza("rechaza un correo mal formado", { p_correo: "arroba-no" });

  const { error: eFantasma } = await sb.rpc("fn_editar_vendedor", {
    p_vendedor_id: "00000000-0000-0000-0000-000000000000",
    p_nombre: NOMBRE2,
    p_ciudad: "La Lima",
  });
  check("rechaza un vendedor inexistente", !!eFantasma, eFantasma ? "" : "no dio error");

  // --- Auditoría -----------------------------------------------------------
  const { data: aud } = await sb
    .from("auditoria")
    .select("campo, valor_anterior, valor_nuevo, accion")
    .eq("entidad_id", id)
    .eq("accion", "editar");

  const campos = new Set((aud ?? []).map((a) => a.campo));
  check("audita el nombre", campos.has("nombre"), [...campos].join(","));
  check("audita el alias", campos.has("alias"), [...campos].join(","));
  check("audita la zona", campos.has("zona"), [...campos].join(","));

  const nom = (aud ?? []).find((a) => a.campo === "nombre");
  check("la auditoría guarda el valor anterior", nom?.valor_anterior === NOMBRE, nom?.valor_anterior ?? "");

  // --- Un vendedor eliminado no se edita -----------------------------------
  await sb.rpc("fn_eliminar_vendedor", { p_vendedor_id: id });
  const { error: eBaja } = await sb.rpc("fn_editar_vendedor", {
    p_vendedor_id: id,
    p_nombre: NOMBRE2,
    p_ciudad: "La Lima",
  });
  check("un vendedor eliminado no se edita", !!eBaja, eBaja ? "" : "no dio error");

  await limpiar();
  console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
  if (fallos) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
