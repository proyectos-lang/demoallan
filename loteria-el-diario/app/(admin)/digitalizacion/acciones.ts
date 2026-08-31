"use server";

import { revalidatePath } from "next/cache";

import { extraerHoja, MODELO } from "@/lib/ia/gemini";
import { sesionVigente } from "@/lib/sesion-vigente";
import { crearClienteServicio } from "@/lib/supabase/admin";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Quién puede digitalizar, y a nombre de quién.
 *
 * Estas tres acciones no comprobaban la sesión en absoluto. Las funciones SQL
 * llaman a `fn_exige`, pero desde la 0024 la aplicación habla como
 * `service_role` y esa guarda retorna sin mirar nada: cualquier perfil con
 * sesión podía subir una hoja a nombre de cualquier vendedor.
 *
 * Ahora un vendedor digitaliza SIEMPRE lo suyo —el id sale de la sesión y lo
 * que mande el navegador se ignora—, administración y digitación pueden
 * hacerlo por cualquiera, y el auditor no puede: lee, no captura.
 */
async function quienDigitaliza(): Promise<
  { ok: true; rol: string; vendedorPropio: string | null; usuarioId: string } | { ok: false; mensaje: string }
> {
  const s = await sesionVigente();
  if (!s) return { ok: false, mensaje: "La sesión venció. Vuelva a entrar." };

  if (s.rol === "vendedor") {
    if (!s.vendedor_id) {
      return { ok: false, mensaje: "Su cuenta no está enlazada a ningún vendedor." };
    }
    return { ok: true, rol: s.rol, vendedorPropio: s.vendedor_id, usuarioId: s.id };
  }

  if (s.rol !== "administrador" && s.rol !== "digitador") {
    return { ok: false, mensaje: "Su perfil no puede digitalizar hojas." };
  }

  return { ok: true, rol: s.rol, vendedorPropio: null, usuarioId: s.id };
}

/** Un vendedor sólo toca los lotes que subió él. */
async function loteAjeno(loteId: string, vendedorPropio: string | null): Promise<boolean> {
  if (!vendedorPropio) return false;
  const supabase = crearClienteServicio();
  const { data } = await supabase
    .from("lote_ocr")
    .select("vendedor_id")
    .eq("id", loteId)
    .maybeSingle();
  return data?.vendedor_id !== vendedorPropio;
}

export type LineaPropuesta = {
  numero: string;
  monto: string;
  /** Grado de acuerdo entre las tres lecturas, no lo que el modelo declara. */
  confianza: number;
  /** Índice del par de filas de la hoja del que salió. */
  grupo: number;
  /** Lo que leyó cada pasada, cuando no hubo unanimidad. */
  alternativas?: string[];
};

export type ResultadoExtraccion =
  | {
      ok: true;
      loteId: string;
      lineas: LineaPropuesta[];
      encabezado: { nombre: string; fecha: string; franja: string };
      totalDeclarado: number | null;
      confianzaGlobal: number;
      /** Problemas de estructura y desacuerdos entre lecturas. */
      avisos: string[];
      costoUsd: number;
      /** Ruta en Storage, para poder mostrar la hoja mientras se revisa. */
      imagenPath: string;
    }
  | { ok: false; mensaje: string };

/**
 * Sube la hoja, la lee y guarda la propuesta.
 *
 * No crea ningún ticket: esto es sólo la propuesta del modelo. Los tickets se
 * crean en `confirmarLote`, y sólo si el operador la revisó y la suma cuadra.
 */
export async function digitalizarHoja(datos: FormData): Promise<ResultadoExtraccion> {
  const quien = await quienDigitaliza();
  if (!quien.ok) return { ok: false, mensaje: quien.mensaje };

  const archivo = datos.get("hoja");
  const sorteoId = String(datos.get("sorteo") ?? "");
  const totalManual = String(datos.get("total") ?? "").replace(/\D/g, "");

  // Un vendedor digitaliza lo suyo, se mande lo que se mande desde el
  // navegador. Los demás perfiles sí eligen.
  const vendedorId = quien.vendedorPropio ?? String(datos.get("vendedor") ?? "");

  if (!(archivo instanceof File) || archivo.size === 0) {
    return { ok: false, mensaje: "Seleccione la fotografía de la hoja." };
  }
  if (!vendedorId || !sorteoId) {
    return { ok: false, mensaje: "Elija el vendedor y el sorteo de destino." };
  }
  // Al vendedor se le exige el total de su hoja, siempre. Es el único control
  // de cuadre que hay, y quien tiene el papel delante es él: dejar que lo
  // supla la lectura del modelo sería quitar el control justo donde puede
  // fallar la lectura.
  if (quien.vendedorPropio && !totalManual) {
    return {
      ok: false,
      mensaje: "Escriba el total de la hoja: sin él no se puede comprobar el cuadre.",
    };
  }
  if (archivo.size > 10 * 1024 * 1024) {
    return { ok: false, mensaje: "La imagen pesa más de 10 MB." };
  }

  const bytes = Buffer.from(await archivo.arrayBuffer());

  let extraccion;
  try {
    extraccion = await extraerHoja(bytes.toString("base64"), archivo.type || "image/jpeg");
  } catch (e) {
    return {
      ok: false,
      mensaje: `No se pudo leer la hoja: ${e instanceof Error ? e.message : "error desconocido"}`,
    };
  }

  // El total lo manda la hoja; si el modelo no lo leyó, el operador lo teclea.
  // Sin total no hay control de cuadre, y sin cuadre no se puede confirmar.
  const totalDeclarado = totalManual ? Number(totalManual) : extraccion.totalDeclarado;
  if (totalDeclarado === null) {
    return {
      ok: false,
      mensaje:
        "No se pudo leer el total al pie de la hoja. Escríbalo a mano: sin él no hay control de cuadre.",
    };
  }

  // La imagen queda como respaldo del lote. Va por el cliente de servicio
  // porque el bucket es privado y no tiene políticas de escritura.
  const servicio = crearClienteServicio();
  const extension = (archivo.name.split(".").pop() ?? "jpg").toLowerCase();
  const ruta = `${sorteoId}/${crypto.randomUUID()}.${extension}`;

  const { error: errorSubida } = await servicio.storage
    .from("hojas")
    .upload(ruta, bytes, { contentType: archivo.type || "image/jpeg", upsert: false });

  if (errorSubida) {
    return { ok: false, mensaje: `No se pudo guardar la imagen: ${errorSubida.message}` };
  }

  const supabase = await crearClienteServidor();
  const { data: loteId, error } = await supabase.rpc("fn_crear_lote_ocr", {
    p_imagen_path: ruta,
    p_vendedor_id: vendedorId,
    p_sorteo_id: sorteoId,
    p_total_declarado: totalDeclarado,
    p_confianza_global: extraccion.confianzaGlobal,
    p_modelo: MODELO,
    p_tokens_entrada: extraccion.tokensEntrada,
    p_tokens_salida: extraccion.tokensSalida,
    p_costo: extraccion.costoUsd,
  });

  if (error) {
    await servicio.storage.from("hojas").remove([ruta]);
    return { ok: false, mensaje: error.message };
  }

  revalidatePath("/digitalizacion");
  revalidatePath("/mi-digitalizacion");
  return {
    ok: true,
    loteId: loteId as unknown as string,
    lineas: extraccion.lineas,
    encabezado: extraccion.encabezado,
    totalDeclarado,
    confianzaGlobal: extraccion.confianzaGlobal,
    avisos: extraccion.avisos,
    costoUsd: extraccion.costoUsd,
    imagenPath: ruta,
  };
}

export type ResultadoConfirmacion =
  | { ok: true; folio: string; lineas: number }
  | { ok: false; mensaje: string };

/**
 * Convierte el lote en tickets. La base vuelve a comprobar el cuadre y aplica
 * las mismas validaciones de cupo que una venta móvil.
 */
export async function confirmarLote(
  loteId: string,
  lineas: { numero: number; monto: number }[],
): Promise<ResultadoConfirmacion> {
  const quien = await quienDigitaliza();
  if (!quien.ok) return { ok: false, mensaje: quien.mensaje };
  if (await loteAjeno(loteId, quien.vendedorPropio)) {
    return { ok: false, mensaje: "Esa hoja no es suya." };
  }

  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_validar_lote_ocr", {
    p_lote_id: loteId,
    p_lineas: lineas,
  });

  if (error) return { ok: false, mensaje: error.message };
  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "La validación no devolvió resultado." };

  revalidatePath("/digitalizacion");
  revalidatePath("/mi-digitalizacion");
  revalidatePath("/mi-dia");
  revalidatePath("/tablero");
  return { ok: true, folio: f.ticket_folio, lineas: Number(f.lineas) };
}

export async function rechazarLote(
  loteId: string,
  motivo: string,
): Promise<{ ok: boolean; mensaje: string }> {
  const quien = await quienDigitaliza();
  if (!quien.ok) return { ok: false, mensaje: quien.mensaje };
  if (await loteAjeno(loteId, quien.vendedorPropio)) {
    return { ok: false, mensaje: "Esa hoja no es suya." };
  }

  const supabase = await crearClienteServidor();
  const { error } = await supabase.rpc("fn_rechazar_lote_ocr", {
    p_lote_id: loteId,
    p_motivo: motivo || "sin motivo",
  });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/digitalizacion");
  return { ok: true, mensaje: "Lote rechazado. La imagen queda como respaldo." };
}
