"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { fechaLarga, hora12 } from "@/lib/format";

/** Un sorteo cerrado de un día anterior, todavía sin número. */
export type Rezagado = {
  id: string;
  fecha: string;
  hora: string;
};

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
  dia,
  hoy,
  rezagados = [],
}: {
  sorteos: OpcionSorteo[];
  elegido: string;
  /** El día que se está mirando. */
  dia: string;
  /** Hoy en Honduras: el tope del selector de fecha. */
  hoy: string;
  /** Sorteos cerrados de días anteriores, sin número. */
  rezagados?: Rezagado[];
}) {
  const router = useRouter();
  const [navegando, iniciar] = useTransition();

  const irA = (f: string, sorteoId?: string) => {
    const p = new URLSearchParams({ dia: f });
    if (sorteoId) p.set("sorteo", sorteoId);
    iniciar(() => router.push(`/resultados?${p.toString()}`));
  };

  return (
    <div className="flex flex-col gap-3 mb-[18px]">
      {/*
        LOS REZAGADOS PRIMERO.

        Un sorteo cerrado de otro día sin número bloquea la liquidación de esa
        jornada entera, y hasta ahora no había nada que lo dijera: sólo
        aparecía si el día en curso ya estaba resuelto, que casi nunca pasa.
        Se enseñan como atajos porque enterarse no basta — hay que poder ir.
      */}
      {rezagados.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap bg-ambar-fondo rounded-banner px-[13px] py-[10px]">
          <span className="text-meta text-ambar-texto font-medium">
            {rezagados.length === 1
              ? "Queda un sorteo de otro día sin número:"
              : `Quedan ${rezagados.length} sorteos de otros días sin número:`}
          </span>
          {rezagados.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={navegando}
              onClick={() => irA(r.fecha, r.id)}
              className="px-[11px] py-[6px] rounded-chip text-label font-semibold border border-ambar-texto bg-superficie text-ambar-texto cursor-pointer"
            >
              {fechaLarga(r.fecha).replace(/ de \d{4}$/, "")} · {hora12(r.hora)}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="flex items-center gap-2 mr-1">
          <span className="text-label text-secundario font-medium">Día</span>
          <input
            type="date"
            value={dia}
            /* Hacia adelante no: un sorteo que no se ha jugado no tiene número
               que capturar. */
            max={hoy}
            onChange={(e) => irA(e.target.value)}
            className="px-[11px] py-[7px] border border-borde-campo rounded-campo text-meta bg-superficie text-cuerpo"
          />
        </label>

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
    </div>
  );
}
