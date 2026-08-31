"use client";

import { useEffect } from "react";

import { cn } from "@/lib/cn";
import { fmt, pad2 } from "@/lib/format";
import { MONTOS_RAPIDOS, TECLAS, type Pos } from "@/lib/pos/use-pos";

/**
 * La hoja del monto: se abre al tocar un número o una línea.
 *
 * POR QUÉ EXISTE
 * --------------
 * El monto vivía debajo de la rejilla. Con veinte líneas de cinco eso son
 * ochocientos píxeles entre tocar el número y decir cuánto, y otros ochocientos
 * para volver — en cada venta, con una cola delante. La hoja trae el teclado
 * consigo y aparece donde ya está el pulgar.
 *
 * POR QUÉ SUBE DESDE ABAJO Y NO SE CENTRA
 * ---------------------------------------
 * Porque abajo es donde alcanza el pulgar. Un diálogo centrado obliga a
 * recolocar la mano en un teléfono grande, y aquí se abre y se cierra una vez
 * por venta.
 */
export function HojaMonto({ pos }: { pos: Pos }) {
  const abierta = pos.montoAbierto && pos.seleccion.length > 0;

  // Escape cierra, como en el resto de los diálogos del proyecto.
  useEffect(() => {
    if (!abierta) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") pos.cerrarMonto();
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [abierta, pos]);

  if (!abierta) return null;

  const varios = pos.seleccion.length > 1;
  const titulo = varios
    ? `${pos.seleccion.length} números`
    : `Número ${pad2(pos.seleccion[0])}`;

  return (
    <div className="lg:hidden fixed inset-0 z-30 flex flex-col justify-end">
      {/* El velo cierra sin agregar nada: tocar fuera es cancelar. */}
      <button
        aria-label="Cancelar"
        onClick={pos.cerrarMonto}
        className="absolute inset-0 bg-tinta/45 border-0"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Monto para ${titulo}`}
        className="relative bg-superficie rounded-t-modal border-t border-borde px-4 pt-4"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="block">
            <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
              CUÁNTO JUEGA
            </span>
            <span className="block text-h2 font-semibold tracking-sutil mt-[2px]">{titulo}</span>
          </span>
          <button
            onClick={pos.cerrarMonto}
            className="text-meta text-secundario font-medium px-2 py-1"
          >
            Cancelar
          </button>
        </div>

        {/* Qué números van, para que no haya que fiarse de la memoria. */}
        {varios && (
          <div className="flex flex-wrap gap-1 mt-2">
            {pos.seleccion.map((n) => (
              <span
                key={n}
                className="px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte text-th font-semibold"
              >
                {pad2(n)}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 bg-panel rounded-pos px-[14px] py-[10px]">
          <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
            MONTO (L) {varios && "· A CADA NÚMERO"}
          </span>
          <span className="block text-display font-semibold">{pos.monto || "0"}</span>
        </div>

        <div
          className={cn(
            "rounded-banner px-[13px] py-[9px] text-tabla font-medium leading-[1.35] mt-2",
            pos.banner.clase,
          )}
        >
          {pos.banner.texto}
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3">
          {MONTOS_RAPIDOS.map((m) => (
            <button
              key={m}
              onClick={() => pos.setMonto(String(m))}
              className={cn(
                "rounded-pos py-[10px] text-tabla font-semibold border",
                String(m) === pos.monto
                  ? "bg-acento text-white border-acento"
                  : "bg-superficie text-tinta border-borde-pos",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 mt-2">
          {TECLAS.map((k) => (
            <button
              key={k}
              onClick={() => pos.tecla(k)}
              className={cn(
                "border border-borde-campo rounded-pos py-3 text-tecla font-semibold bg-superficie active:bg-acento-suave",
                (k === "C" || k === "←") && "text-negativo",
              )}
            >
              {k}
            </button>
          ))}
        </div>

        <button
          disabled={!pos.puedeAgregar}
          onClick={pos.agregarSeleccion}
          className={cn(
            "w-full mt-3 rounded-pos py-4 text-pos font-semibold border-0",
            pos.puedeAgregar
              ? "bg-tinta text-white"
              : "bg-riel text-mudo cursor-not-allowed",
          )}
        >
          {varios
            ? `Agregar ${pos.seleccion.length} números · ${fmt(pos.montoNum * pos.seleccion.length)}`
            : "Agregar al ticket"}
        </button>
      </div>
    </div>
  );
}
