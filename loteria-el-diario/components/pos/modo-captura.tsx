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
/** Los tres modos de la pantalla. `ventas` mira lo ya registrado. */
export type Modo = "detalle" | "totales" | "ventas";

export function ModoCaptura({
  modo,
  sorteoId,
  capturas,
  fecha,
}: {
  modo: Modo;
  sorteoId: string;
  /** Cuántas capturas por totales vivas tiene este sorteo. */
  capturas: number;
  /** El día que se está mirando. Sólo viaja en el modo por totales. */
  fecha: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (m: Modo) => {
    const p = new URLSearchParams();
    if (sorteoId) p.set("sorteo", sorteoId);
    if (m === "totales") {
      p.set("modo", "totales");
      p.set("fecha", fecha);
    } else if (m === "ventas") {
      // El detalle mira un DÍA entero, no un sorteo: se lleva la fecha y
      // suelta el sorteo, que ahí no significa nada.
      p.delete("sorteo");
      p.set("modo", "ventas");
      p.set("dia", fecha);
    } else {
      p.delete("sorteo");
    }
    /*
     * Al volver a la rejilla se suelta la fecha y el sorteo: la rejilla vende
     * en vivo y sólo tiene sentido sobre los sorteos de hoy. Arrastrar ahí un
     * sorteo de la semana pasada la dejaría pidiendo cupo de un día cerrado.
     */
    iniciar(() => router.push(`/punto-de-venta?${p.toString()}`));
  };

  const clase = (activo: boolean) =>
    cn(
      "border-0 rounded-chip px-4 py-[9px] text-meta font-medium cursor-pointer flex-none whitespace-nowrap",
      activo ? "bg-superficie text-tinta shadow-tab" : "bg-transparent text-secundario",
    );

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1 bg-riel rounded-banner p-1 self-start max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button type="button" onClick={() => ir("detalle")} className={clase(modo === "detalle")}>
          Número a número
        </button>
        {/*
          Ver lo ya registrado, aquí mismo.

          Vivía sólo en el informe de gerencia, que es donde se analiza. Pero
          quien acaba de registrar mal una venta está EN ESTA pantalla, y
          mandarlo a otra sección para corregirla es el tipo de rodeo que
          termina en «que lo arregle administración».
        */}
        <button type="button" onClick={() => ir("ventas")} className={clase(modo === "ventas")}>
          Ventas registradas
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
