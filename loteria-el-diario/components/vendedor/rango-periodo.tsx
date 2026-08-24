"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

export type Atajo = { etiqueta: string; desde: string; hasta: string };

/**
 * Selector de rango del reporte del vendedor.
 *
 * Va en la URL, como el resto de filtros del proyecto, para que el reporte de
 * una semana concreta se pueda volver a abrir y el botón de atrás del
 * navegador haga lo que uno espera.
 *
 * Las flechas mueven de semana en semana. En un teléfono son el gesto natural
 * —«y la semana pasada?»— y evitan tener que teclear dos fechas con el pulgar;
 * los campos de fecha se quedan debajo para el caso raro del rango a medida.
 */
export function RangoPeriodo({
  desde,
  hasta,
  atajos,
  anterior,
  siguiente,
}: {
  desde: string;
  hasta: string;
  atajos: Atajo[];
  anterior: { desde: string; hasta: string };
  siguiente: { desde: string; hasta: string } | null;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (d: string, h: string) => {
    const p = new URLSearchParams({ desde: d, hasta: h });
    iniciar(() => router.push(`/mi-reporte?${p.toString()}`));
  };

  const flecha =
    "w-11 h-11 flex-none rounded-campo border border-borde-campo bg-superficie flex items-center justify-center disabled:bg-riel";

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-4 py-3 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => ir(anterior.desde, anterior.hasta)}
          disabled={pendiente}
          className={flecha}
          aria-label="Semana anterior"
        >
          <ChevronLeft size={18} color="var(--color-cuerpo)" strokeWidth={2} absoluteStrokeWidth />
        </button>

        <span className="flex-1 text-center text-tabla font-medium">
          {pendiente ? "cargando…" : `${desde} — ${hasta}`}
        </span>

        <button
          type="button"
          onClick={() => siguiente && ir(siguiente.desde, siguiente.hasta)}
          // Sin semana siguiente cuando ya se está en la actual: no hay nada
          // que enseñar de un futuro que todavía no se ha vendido.
          disabled={pendiente || !siguiente}
          className={flecha}
          aria-label="Semana siguiente"
        >
          <ChevronRight size={18} color="var(--color-cuerpo)" strokeWidth={2} absoluteStrokeWidth />
        </button>
      </div>

      <div className="flex gap-[6px] flex-wrap">
        {atajos.map((a) => (
          <button
            key={a.etiqueta}
            type="button"
            onClick={() => ir(a.desde, a.hasta)}
            className={cn(
              "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
              desde === a.desde && hasta === a.hasta
                ? "bg-tinta text-white border-tinta"
                : "bg-superficie text-cuerpo border-borde-campo",
            )}
          >
            {a.etiqueta}
          </button>
        ))}
      </div>

      <div className="flex gap-3 flex-wrap">
        <label className="block flex-1 min-w-[130px]">
          <span className="block text-label text-secundario font-medium mb-[5px]">Desde</span>
          <input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => ir(e.target.value, hasta)}
            className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
          />
        </label>
        <label className="block flex-1 min-w-[130px]">
          <span className="block text-label text-secundario font-medium mb-[5px]">Hasta</span>
          <input
            type="date"
            value={hasta}
            min={desde}
            onChange={(e) => ir(desde, e.target.value)}
            className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
          />
        </label>
      </div>
    </div>
  );
}
