"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { fmt } from "@/lib/format";

/**
 * Una celda de cifra que se edita en el sitio: clic → input → Enter/blur guarda,
 * Esc cancela.
 *
 * Se usa para venta y premios en la hoja del vendedor, donde el gerente corrige
 * a mano. Muestra la cifra como texto hasta que se toca; entonces se convierte
 * en un input con el valor crudo para escribir encima. No guarda si el valor no
 * cambió, para no disparar un recálculo por abrir y cerrar sin tocar nada.
 */
export function CeldaEditable({
  valor,
  onGuardar,
  guardando,
  alinear = "right",
  titulo,
}: {
  valor: number;
  /** Devuelve una promesa: mientras resuelve, la celda queda en «guardando». */
  onGuardar: (nuevo: number) => Promise<void> | void;
  guardando?: boolean;
  alinear?: "right" | "left";
  titulo?: string;
}) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState("");
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editando) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editando]);

  const abrir = () => {
    setTexto(String(valor));
    setEditando(true);
  };

  const confirmar = async () => {
    const limpio = texto.trim().replace(",", ".");
    const nuevo = Number(limpio);
    setEditando(false);
    if (limpio === "" || !Number.isFinite(nuevo) || nuevo < 0) return; // se descarta
    if (Math.round(nuevo * 100) === Math.round(valor * 100)) return; // sin cambio
    await onGuardar(nuevo);
  };

  if (editando) {
    return (
      <input
        ref={input}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onBlur={confirmar}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void confirmar();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditando(false);
          }
        }}
        inputMode="decimal"
        aria-label={titulo}
        className={cn(
          "w-[84px] rounded-celda border border-acento bg-superficie px-2 py-[2px] text-tabla",
          "outline-none [font-variant-numeric:tabular-nums]",
          alinear === "right" ? "text-right" : "text-left",
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={abrir}
      disabled={guardando}
      title={titulo ?? "Editar"}
      className={cn(
        "inline-flex items-center rounded-celda px-1.5 py-[2px] -mx-1.5 hover:bg-acento-suave",
        "hover:text-acento-fuerte transition-colors cursor-text",
        guardando && "opacity-50",
      )}
    >
      {guardando ? "…" : fmt(valor, false)}
    </button>
  );
}
