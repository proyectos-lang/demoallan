"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";

export type VistaLiq = "hoja" | "resumen";

const VISTAS: { id: VistaLiq; etiqueta: string }[] = [
  { id: "hoja", etiqueta: "Hoja del vendedor" },
  { id: "resumen", etiqueta: "Resumen por semana" },
];

/**
 * Las dos caras del módulo: cobrar y ver cómo va el cobro.
 *
 * La pestaña va en la dirección, como en el informe de gerencia. Cambiar de
 * pestaña conserva el vendedor —es lo que se está mirando en las dos— pero
 * suelta la semana: en la hoja se cobra una y en el resumen se ven todas.
 */
export function PestanasLiquidacion({
  vista,
  vendedorId,
}: {
  vista: VistaLiq;
  vendedorId: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (v: VistaLiq) => {
    const p = new URLSearchParams({ vista: v });
    if (vendedorId) p.set("vendedor", vendedorId);
    iniciar(() => router.push(`/liquidacion?${p.toString()}`));
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1 bg-riel rounded-banner p-1 self-start">
        {VISTAS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => ir(v.id)}
            aria-current={vista === v.id ? "page" : undefined}
            className={cn(
              "border-0 rounded-chip px-4 py-[9px] text-meta font-medium cursor-pointer",
              vista === v.id
                ? "bg-superficie text-tinta shadow-tab"
                : "bg-transparent text-secundario",
            )}
          >
            {v.etiqueta}
          </button>
        ))}
      </div>
      {pendiente && <span className="text-meta text-secundario">Cargando…</span>}
    </div>
  );
}
