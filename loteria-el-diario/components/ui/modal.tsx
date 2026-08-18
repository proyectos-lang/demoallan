"use client";

import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Modal del prototipo: velo `rgba(15,23,42,.5)`, caja de 18px de radio con la
 * sombra profunda, cabecera separada por hairline y pie con la línea de error
 * de altura fija (para que el contenido no salte al aparecer el mensaje).
 */
export function Modal({
  abierto,
  onCerrar,
  eyebrow,
  titulo,
  subtitulo,
  children,
  pie,
  error,
  ancho = 620,
}: {
  abierto: boolean;
  onCerrar: () => void;
  eyebrow?: string;
  titulo: string;
  subtitulo?: string;
  children: ReactNode;
  pie: ReactNode;
  error?: string;
  ancho?: number;
}) {
  useEffect(() => {
    if (!abierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCerrar();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [abierto, onCerrar]);

  if (!abierto) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(15,23,42,.5)" }}
      onClick={onCerrar}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        className="bg-superficie rounded-modal max-w-full max-h-[92vh] overflow-auto shadow-modal"
        style={{ width: ancho }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-[26px] pt-[22px] pb-[18px] border-b border-riel">
          {eyebrow && (
            <div className="text-eyebrow font-semibold tracking-seccion text-secundario">
              {eyebrow}
            </div>
          )}
          <h2 className="text-modal font-semibold tracking-sutil mt-1 mb-0">{titulo}</h2>
          {subtitulo && <p className="text-meta text-secundario mt-[5px] mb-0">{subtitulo}</p>}
        </div>

        <div className="px-[26px] py-[22px]">{children}</div>

        <div className="px-[26px] pb-6">
          <p className={cn("text-meta text-negativo min-h-[18px] mt-0 mb-3")}>{error}</p>
          <div className="flex justify-end gap-[10px]">{pie}</div>
        </div>
      </div>
    </div>
  );
}

/** Campo de formulario dentro del modal: label 11.5px + control de 14px. */
export function CampoModal({
  etiqueta,
  anchoCompleto = false,
  children,
}: {
  etiqueta: string;
  anchoCompleto?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cn("block", anchoCompleto && "col-span-full")}>
      <span className="block text-label text-secundario font-medium mb-[6px]">
        {etiqueta}
      </span>
      {children}
    </label>
  );
}

export const CLASE_CONTROL_MODAL =
  "w-full px-3 py-[10px] border border-borde-campo rounded-boton text-card outline-none bg-superficie";
