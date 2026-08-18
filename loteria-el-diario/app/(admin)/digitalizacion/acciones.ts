"use server";

import { revalidatePath } from "next/cache";

import { extraerHoja, MODELO } from "@/lib/ia/gemini";
import { crearClienteServicio } from "@/lib/supabase/admin";
import { crearClienteServidor } from "@/lib/supabase/server";

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
  const archivo = datos.get("hoja");
  const vendedorId = String(datos.get("vendedor") ?? "");
  const sorteoId = String(datos.get("sorteo") ?? "");
  const totalManual = String(datos.get("total") ?? "").replace(/\D/g, "");

  if (!(archivo instanceof File) || archivo.size === 0) {
    return { ok: false, mensaje: "Seleccione la fotografía de la hoja." };
  }
  if (!vendedorId || !sorteoId) {
    return { ok: false, mensaje: "Elija el vendedor y el sorteo de destino." };
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
  const supabase = await crearClienteServidor();

  const { data, error } = await supabase.rpc("fn_validar_lote_ocr", {
    p_lote_id: loteId,
    p_lineas: lineas,
  });

  if (error) return { ok: false, mensaje: error.message };
  const f = data?.[0];
  if (!f) return { ok: false, mensaje: "La validación no devolvió resultado." };

  revalidatePath("/digitalizacion");
  revalidatePath("/tablero");
  return { ok: true, folio: f.ticket_folio, lineas: Number(f.lineas) };
}

export async function rechazarLote(
  loteId: string,
  motivo: string,
): Promise<{ ok: boolean; mensaje: string }> {
  const supabase = await crearClienteServidor();
  const { error } = await supabase.rpc("fn_rechazar_lote_ocr", {
    p_lote_id: loteId,
    p_motivo: motivo || "sin motivo",
  });

  if (error) return { ok: false, mensaje: error.message };

  revalidatePath("/digitalizacion");
  return { ok: true, mensaje: "Lote rechazado. La imagen queda como respaldo." };
}
