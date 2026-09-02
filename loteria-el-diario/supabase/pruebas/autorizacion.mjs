/**
 * ¿Puede un vendedor autenticado escalar privilegios?
 *
 * Las funciones SECURITY DEFINER se saltan RLS por diseño. Esta prueba
 * comprueba que la guarda de rol de 0005 las cierra, y que a la vez sigue
 * dejando pasar lo que sí corresponde a cada rol.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const U = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(U, ANON, { db: { schema: "public" }, auth: { persistSession: false } });
const vendedor = createClient(U, ANON, { db: { schema: "public" }, auth: { persistSession: false } });
const servicio = createClient(U, SERVICE, { db: { schema: "public" }, auth: { persistSession: false } });

const CORREO_V = "rosa.padilla@eldiario.hn";
const CLAVE_V = "PruebaVendedor123";
const FECHA = "2098-03-03";

let ok = 0, fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};
/**
 * ¿La llamada fue rechazada por permisos?
 *
 * Se mira el CÓDIGO, no el texto: 42501 es insufficient_privilege y lo emiten
 * tanto las guardas de rol como el propio motor cuando falta el GRANT. Filtrar
 * por palabras del mensaje daba falsos negativos con los mensajes en español.
 */
const denegado = (error) =>
  !!error &&
  (error.code === "42501" ||
    error.code === "PGRST202" ||
    /permission denied|insufficient/i.test(error.message ?? ""));

const rest = (metodo, ruta, cuerpo) =>
  fetch(`${U}/rest/v1/${ruta}`, {
    method: metodo,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      "Accept-Profile": "public",
      "Content-Profile": "public",
      Prefer: "return=representation",
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });

let usuarioVendedorId;
let sorteoId;

try {
  // ---------------------------------------------------------------------
  console.log("\n1. La llave de servicio sigue pasando la guarda");
  const { data: vs } = await servicio.from("vendedor").select("id, codigo").order("codigo");
  const rosa = vs.find((v) => v.codigo === "V-003");
  const maria = vs.find((v) => v.codigo === "V-001");

  const { error: eServicio } = await servicio.rpc("fn_guardar_parametros", {
    p_vendedor_id: rosa.id,
    p_comision: 0.15,
    p_factor_pago: 68,
    p_tope_por_numero: 1500,
  });
  check("service_role puede guardar parámetros", !eServicio, eServicio?.message);

  // ---------------------------------------------------------------------
  console.log("\n2. Alta de usuario vendedor enlazado a V-003");
  const alta = await fetch(`${U}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: CORREO_V, password: CLAVE_V, email_confirm: true }),
  });
  const usuario = await alta.json();
  usuarioVendedorId = usuario.id;
  await rest("POST", "usuario_perfil", {
    id: usuario.id, rol: "vendedor", vendedor_id: rosa.id, nombre: "Rosa I. Padilla",
  });

  const { error: eLogin } = await vendedor.auth.signInWithPassword({ email: CORREO_V, password: CLAVE_V });
  check("el vendedor entra", !eLogin, eLogin?.message);

  // ---------------------------------------------------------------------
  console.log("\n3. Escalada de privilegios desde el rol vendedor");

  const { error: e1 } = await vendedor.rpc("fn_guardar_parametros", {
    p_vendedor_id: rosa.id, p_comision: 0.6, p_factor_pago: 68, p_tope_por_numero: 1500,
  });
  check("NO puede subirse la comisión", denegado(e1), JSON.stringify(e1));

  const { error: e2 } = await vendedor.rpc("fn_auditar", {
    p_entidad: "sorteo", p_entidad_id: rosa.id, p_accion: "falsificado",
  });
  check("NO puede escribir en auditoría", denegado(e2), JSON.stringify(e2));

  const { error: e3 } = await vendedor.rpc("fn_programar_dia", { p_fecha: FECHA });
  check("NO puede programar sorteos", denegado(e3), JSON.stringify(e3));

  const { data: comisionReal } = await servicio
    .from("parametro_vendedor")
    .select("comision")
    .eq("vendedor_id", rosa.id)
    .is("vigente_hasta", null)
    .single();
  check("la comisión siguió en 15 %", Number(comisionReal.comision) === 0.15, JSON.stringify(comisionReal));

  // ---------------------------------------------------------------------
  console.log("\n4. Lo que el administrador sí puede");
  const { error: eAdminLogin } = await admin.auth.signInWithPassword({
    email: "admin@eldiario.hn", password: process.env.PW,
  });
  check("el administrador entra", !eAdminLogin, eAdminLogin?.message);

  const { error: eProg } = await admin.rpc("fn_programar_dia", { p_fecha: FECHA });
  check("programa el día", !eProg, eProg?.message);

  const { data: sorteos } = await servicio
    .from("sorteo").select("id, hora").eq("fecha", FECHA).order("hora");
  check("crea los tres sorteos de la fecha", sorteos?.length === 3, `n=${sorteos?.length}`);
  sorteoId = sorteos?.find((s) => s.hora === "20:00")?.id;

  const { error: eAbrir } = await admin.rpc("fn_abrir_sorteo", {
    p_sorteo_id: sorteoId, p_limite_por_numero: 6000,
  });
  check("abre el sorteo de las 20:00", !eAbrir, eAbrir?.message);

  const { data: nuevo, error: eCrear } = await admin.rpc("fn_crear_vendedor", {
    p_nombre: "Prueba Alta Modal", p_telefono: "9999-1234", p_correo: "alta@eldiario.hn",
    p_identidad: "0501-2000-00001", p_ciudad: "Villanueva", p_barrio: "",
    p_lat: 15.3167, p_lng: -88.0, p_color: "#65a30d",
    p_comision: 0.12, p_factor_pago: 70, p_tope_por_numero: 500,
  });
  check("crea un vendedor (la vía del modal)", !eCrear && !!nuevo?.[0]?.vendedor_codigo, JSON.stringify(eCrear ?? nuevo));

  if (nuevo?.[0]) {
    const { data: creado } = await servicio
      .from("vendedor").select("codigo, zona").eq("id", nuevo[0].vendedor_id).single();
    check("el código sigue la secuencia", /^V-0\d\d$/.test(creado.codigo), creado?.codigo);
    check("la zona compone ciudad · barrio", creado.zona === "Villanueva · sin barrio asignado", creado?.zona);
    const { data: p } = await servicio
      .from("parametro_vendedor").select("comision").eq("vendedor_id", nuevo[0].vendedor_id).single();
    check("nace con parámetros vigentes", Number(p.comision) === 0.12, JSON.stringify(p));
  }

  const { error: eNombre } = await admin.rpc("fn_crear_vendedor", {
    p_nombre: "Ana", p_telefono: "9999-1234", p_correo: "x@y.hn", p_identidad: "",
    p_ciudad: "Choloma", p_barrio: "", p_lat: 15.6, p_lng: -87.9, p_color: "#65a30d",
    p_comision: 0.12, p_factor_pago: 70, p_tope_por_numero: 500,
  });
  check("rechaza nombre demasiado corto", !!eNombre && /nombre completo/i.test(eNombre.message), eNombre?.message);

  const { error: eTel } = await admin.rpc("fn_crear_vendedor", {
    p_nombre: "Ana María López", p_telefono: "99991234", p_correo: "x@y.hn", p_identidad: "",
    p_ciudad: "Choloma", p_barrio: "", p_lat: 15.6, p_lng: -87.9, p_color: "#65a30d",
    p_comision: 0.12, p_factor_pago: 70, p_tope_por_numero: 500,
  });
  check("rechaza teléfono mal formado", !!eTel && /9999-9999/.test(eTel.message), eTel?.message);

  // ---------------------------------------------------------------------
  console.log("\n5. El vendedor vende lo suyo, no lo ajeno");

  const { error: eAjeno } = await vendedor.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId, p_vendedor_id: maria.id, p_lineas: [{ numero: 10, monto: 50 }],
  });
  check("NO puede vender a nombre de otro vendedor", denegado(eAjeno), JSON.stringify(eAjeno));

  const { data: propio, error: ePropio } = await vendedor.rpc("fn_registrar_ticket", {
    p_sorteo_id: sorteoId, p_vendedor_id: rosa.id, p_lineas: [{ numero: 10, monto: 50 }],
  });
  check("SÍ puede vender a su propio nombre", !ePropio && !!propio?.[0]?.ticket_folio, JSON.stringify(ePropio ?? propio));

  const { data: mios } = await vendedor.from("ticket").select("id, vendedor_id");
  check(
    "sólo ve sus propios tickets (RLS)",
    (mios ?? []).every((t) => t.vendedor_id === rosa.id),
    JSON.stringify(mios),
  );

  const { error: eLiq } = await vendedor.rpc("fn_liquidar_sorteo", {
    p_sorteo_id: sorteoId, p_numero_ganador: 10,
  });
  check("NO puede liquidar el sorteo", denegado(eLiq), JSON.stringify(eLiq));
} finally {
  console.log("\n6. Limpieza");
  if (sorteoId) {
    await rest("DELETE", `linea?id=not.is.null`);
    await rest("DELETE", `ticket?sorteo_id=eq.${sorteoId}`);
  }
  await rest("DELETE", `cupo_numero?numero=gte.0`);
  await rest("DELETE", `sorteo?fecha=eq.${FECHA}`);
  const { data: sobrantes } = await servicio.from("vendedor").select("id").gte("codigo", "V-006");
  for (const v of sobrantes ?? []) {
    await rest("DELETE", `parametro_vendedor?vendedor_id=eq.${v.id}`);
    await rest("DELETE", `vendedor?id=eq.${v.id}`);
  }
  if (usuarioVendedorId) {
    await rest("DELETE", `usuario_perfil?id=eq.${usuarioVendedorId}`);
    await fetch(`${U}/auth/v1/admin/users/${usuarioVendedorId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
  }
  await rest("DELETE", "auditoria?id=gt.0");
}

console.log(`\n=== ${ok} ok · ${fallos} fallos ===`);
process.exit(fallos > 0 ? 1 : 0);
