/**
 * Siembra los cinco vendedores del prototipo con sus parámetros.
 *
 *     node supabase/sembrar.mjs
 *
 * Idempotente: si el código de vendedor ya existe, lo salta. Son datos de
 * arranque para desarrollo — se pueden borrar sin consecuencias mientras no
 * haya ventas asociadas.
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

const U = env.NEXT_PUBLIC_SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = {
  apikey: K,
  Authorization: `Bearer ${K}`,
  "Content-Type": "application/json",
  "Accept-Profile": "allan",
  "Content-Profile": "allan",
};

// comision va como FRACCIÓN: 12.5 % → 0.125
const VENDEDORES = [
  { codigo: "V-001", nombre: "María F. Cruz",    identidad: "0501-1988-04217", telefono: "9812-4407", correo: "maria.cruz@eldiario.hn",   ciudad: "San Pedro Sula", barrio: "Centro",          zona: "SPS · Centro",              color: "#2563eb", lat: 15.5045, lng: -88.0250, comision: 0.125,   factor: 70, tope: 1200 },
  { codigo: "V-002", nombre: "José A. Munguía",  identidad: "0501-1979-11884", telefono: "3345-9012", correo: "jose.munguia@eldiario.hn", ciudad: "San Pedro Sula", barrio: "Río de Piedras",  zona: "SPS · Río de Piedras",      color: "#0891b2", lat: 15.5219, lng: -88.0086, comision: 0.10,    factor: 72, tope: 900 },
  { codigo: "V-003", nombre: "Rosa I. Padilla",  identidad: "0512-1985-00932", telefono: "9455-2210", correo: "rosa.padilla@eldiario.hn", ciudad: "Choloma",        barrio: "Centro",          zona: "Choloma · Centro",          color: "#e11d48", lat: 15.6136, lng: -87.9525, comision: 0.15,    factor: 68, tope: 1500 },
  { codigo: "V-004", nombre: "Carlos E. Zelaya", identidad: "0501-1992-07551", telefono: "8877-1345", correo: "carlos.zelaya@eldiario.hn",ciudad: "San Pedro Sula", barrio: "Cofradía",        zona: "SPS · Cofradía",            color: "#7c3aed", lat: 15.4302, lng: -88.1487, comision: 0.1125,  factor: 70, tope: 800 },
  { codigo: "V-005", nombre: "Dania Y. Ramos",   identidad: "0512-1990-03108", telefono: "9601-8823", correo: "dania.ramos@eldiario.hn",  ciudad: "Choloma",        barrio: "López Arellano",  zona: "Choloma · López Arellano",  color: "#059669", lat: 15.6538, lng: -87.9312, comision: 0.13,    factor: 74, tope: 1000 },
];

async function api(ruta, opciones = {}) {
  const r = await fetch(`${U}/rest/v1/${ruta}`, {
    ...opciones,
    headers: { ...H, ...opciones.headers },
  });
  const texto = await r.text();
  return { status: r.status, cuerpo: texto ? JSON.parse(texto) : null };
}

for (const v of VENDEDORES) {
  const existe = await api(`vendedor?codigo=eq.${v.codigo}&select=id`);
  if (existe.cuerpo?.length) {
    console.log(`  ya existe  ${v.codigo}  ${v.nombre}`);
    continue;
  }

  const alta = await api("vendedor", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      codigo: v.codigo,
      nombre: v.nombre,
      identidad: v.identidad,
      telefono: v.telefono,
      correo: v.correo,
      ciudad: v.ciudad,
      barrio: v.barrio,
      zona: v.zona,
      color: v.color,
      lat: v.lat,
      lng: v.lng,
    }),
  });

  if (alta.status !== 201) {
    console.error(`  ERROR      ${v.codigo}`, JSON.stringify(alta.cuerpo));
    continue;
  }

  const param = await api("rpc/fn_guardar_parametros", {
    method: "POST",
    body: JSON.stringify({
      p_vendedor_id: alta.cuerpo[0].id,
      p_comision: v.comision,
      p_factor_pago: v.factor,
      p_tope_por_numero: v.tope,
    }),
  });

  console.log(
    param.status === 200
      ? `  creado     ${v.codigo}  ${v.nombre}  ·  ${(v.comision * 100).toFixed(2)} %  ·  factor ${v.factor}  ·  tope L ${v.tope}`
      : `  ERROR parámetros ${v.codigo} ${JSON.stringify(param.cuerpo)}`,
  );
}

const total = await api("vendedor?select=id");
console.log(`\n${total.cuerpo.length} vendedores en la base.`);
