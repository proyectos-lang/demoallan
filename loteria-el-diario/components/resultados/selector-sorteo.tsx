"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type OpcionSorteo = {
  id: string;
  hora: string;
  /** `liquidado` ya tiene número: se muestra, pero no se puede recapturar. */
  estado: "programado" | "abierto" | "cerrado" | "liquidado";
  numero: number | null;
};

/**
 * Los tres sorteos del día, para elegir cuál se captura.
 *
 * Antes la pantalla escogía sola —el cerrado más antiguo— y no había forma de
 * capturar otro. Con tres sorteos al día eso obliga a esperar a que el de la
 * mañana esté liquidado para poder tocar el de la tarde, y deja sin remedio el
 * caso de querer revisar uno concreto.
 *
 * La elección viaja en la URL, como en reportes y liquidación: así el enlace
 * se puede compartir y el botón de atrás del navegador hace lo esperable.
 *
 * Un sorteo ya liquidado NO se puede elegir. No es una limitación de pantalla:
 * la liquidación es terminal por diseño y `fn_liquidar_sorteo` sólo acepta un
 * sorteo `cerrado`. Ofrecerlo sería prometer algo que la base va a rechazar;
 * en su lugar se muestra el número que salió, que es lo que se quiere saber.
 */
export function SelectorSorteo({
  sorteos,
  elegido,
}: {
  sorteos: OpcionSorteo[];
  elegido: string;
}) {
  const router = useRouter();
  const [navegando, iniciar] = useTransition();

  return (
    <div className="flex items-center gap-2 flex-wrap mb-[18px]">
      <span className="text-label text-secundario font-medium mr-1">Sorteo de hoy</span>

      {sorteos.map((s) => {
        const activo = s.id === elegido;
        const liquidado = s.estado === "liquidado";

        return (
          <button
            key={s.id}
            type="button"
            disabled={liquidado || navegando}
            onClick={() => iniciar(() => router.push(`/resultados?sorteo=${s.id}`))}
            className={cn(
              "px-[13px] py-[9px] rounded-campo text-meta font-medium border",
              liquidado
                ? "bg-panel border-borde-campo text-mudo cursor-default"
                : activo
                  ? "bg-acento border-acento text-white cursor-pointer"
                  : "bg-superficie border-borde-campo text-cuerpo cursor-pointer",
            )}
          >
            {hora12(s.hora)}
            {/* El número ya capturado es la información útil de un liquidado:
                dice de un vistazo cuál falta y cuál no. */}
            {liquidado && s.numero !== null && (
              <span className="ml-[6px] font-semibold">
                {String(s.numero).padStart(2, "0")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
