"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";

/**
 * Elige cómo se captura: número a número o por totales.
 *
 * Van en la dirección y no en estado local para que un enlace lleve al modo
 * que toca, y para que el botón de atrás haga lo que uno espera. El sorteo
 * elegido viaja con el modo: cambiar de forma de capturar no debería mover el
 * sorteo que se está mirando.
 *
 * Sólo lo ve administración. Un vendedor no puede capturar por totales —no
 * habría nada que le impidiera anotarse la venta que quisiera— y el digitador
 * tampoco: para eso está la digitalización de la hoja, que sí deja rastro de
 * lo que había escrito.
 */
export function ModoCaptura({
  modo,
  sorteoId,
  capturas,
}: {
  modo: "detalle" | "totales";
  sorteoId: string;
  /** Cuántas capturas por totales vivas tiene este sorteo. */
  capturas: number;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (m: "detalle" | "totales") => {
    const p = new URLSearchParams({ sorteo: sorteoId });
    if (m === "totales") p.set("modo", "totales");
    iniciar(() => router.push(`/punto-de-venta?${p.toString()}`));
  };

  const clase = (activo: boolean) =>
    cn(
      "border-0 rounded-chip px-4 py-[9px] text-meta font-medium cursor-pointer",
      activo ? "bg-superficie text-tinta shadow-tab" : "bg-transparent text-secundario",
    );

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1 bg-riel rounded-banner p-1 self-start">
        <button type="button" onClick={() => ir("detalle")} className={clase(modo === "detalle")}>
          Número a número
        </button>
        <button type="button" onClick={() => ir("totales")} className={clase(modo === "totales")}>
          Por totales
          {capturas > 0 && (
            <span
              className={cn(
                "ml-[6px] inline-block min-w-[18px] text-center px-[5px] rounded-pildora text-th font-semibold",
                modo === "totales" ? "bg-acento-suave text-acento-fuerte" : "bg-chip text-cuerpo",
              )}
            >
              {capturas}
            </span>
          )}
        </button>
      </div>
      {pendiente && <span className="text-meta text-secundario">Cargando…</span>}
    </div>
  );
}
