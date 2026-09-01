"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";

export type Vista = "diaria" | "semanal" | "vendedor" | "financiera";

const VISTAS: { id: Vista; etiqueta: string }[] = [
  { id: "diaria", etiqueta: "Captura diaria" },
  { id: "semanal", etiqueta: "Resumen semanal" },
  { id: "vendedor", etiqueta: "Análisis de vendedores" },
  { id: "financiera", etiqueta: "Análisis financiero" },
];

/**
 * Las cuatro pestañas del informe de gerencia.
 *
 * La pestaña vive en la dirección y no en el estado del componente: así una
 * vista concreta se puede compartir por chat, que es como circula esto entre
 * el gerente y la administración.
 *
 * Cambiar de pestaña BORRA los filtros de la anterior. Son informes distintos
 * con filtros distintos —un día contra una semana contra un vendedor— y
 * arrastrar un `?dia=` a la vista semanal sólo produce una dirección larga que
 * no significa nada. La misma tira de tabs del punto de venta.
 */
export function Pestanas({ vista }: { vista: Vista }) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1 bg-riel rounded-banner p-1 self-start">
        {VISTAS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => iniciar(() => router.push(`/informe?vista=${v.id}`))}
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
