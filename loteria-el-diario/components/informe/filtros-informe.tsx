"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";

export type Atajo = { etiqueta: string; grupo: "Día" | "Semana" | "Mes"; desde: string; hasta: string };

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta";

/**
 * Filtros del informe de gerencia.
 *
 * Los atajos van agrupados en día, semana y mes porque son las tres preguntas
 * que se hacen de verdad —«¿cómo cerró ayer?», «¿cómo va la semana?», «¿cómo
 * cerró el mes?»—, y teclear dos fechas para cualquiera de ellas es fricción
 * pura. El rango a medida se queda debajo para lo demás.
 *
 * Van en la URL, como el resto de los filtros del proyecto: un informe se
 * comparte pegando la dirección.
 */
export function FiltrosInforme({
  desde,
  hasta,
  atajos,
  ocultarSinMovimiento,
  sinMovimiento,
}: {
  desde: string;
  hasta: string;
  atajos: Atajo[];
  ocultarSinMovimiento: boolean;
  /** Cuántos vendedores quedarían fuera al ocultarlos. */
  sinMovimiento: number;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambio: { desde?: string; hasta?: string; ocultar?: boolean }) => {
    const p = new URLSearchParams({
      desde: cambio.desde ?? desde,
      hasta: cambio.hasta ?? hasta,
    });
    if (cambio.ocultar ?? ocultarSinMovimiento) p.set("conventa", "1");
    iniciar(() => router.push(`/informe?${p.toString()}`));
  };

  const grupos: Atajo["grupo"][] = ["Día", "Semana", "Mes"];

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[14px] flex flex-col gap-3">
      {grupos.map((g) => (
        <div key={g} className="flex items-center gap-3 flex-wrap">
          <span className="text-label text-secundario font-medium w-[52px] flex-none">{g}</span>
          <div className="flex gap-[6px] flex-wrap">
            {atajos
              .filter((a) => a.grupo === g)
              .map((a) => (
                <button
                  key={a.etiqueta}
                  type="button"
                  onClick={() => ir({ desde: a.desde, hasta: a.hasta })}
                  className={cn(
                    "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                    desde === a.desde && hasta === a.hasta
                      ? "bg-tinta text-white border-tinta"
                      : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                  )}
                >
                  {a.etiqueta}
                </button>
              ))}
          </div>
        </div>
      ))}

      <div className="flex gap-4 flex-wrap items-end border-t border-riel pt-3">
        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Desde</span>
          <input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => ir({ desde: e.target.value })}
            className={CLASE_CONTROL}
          />
        </label>
        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Hasta</span>
          <input
            type="date"
            value={hasta}
            min={desde}
            onChange={(e) => ir({ hasta: e.target.value })}
            className={CLASE_CONTROL}
          />
        </label>
        {/*
          Mostrar u ocultar a quien no vendió nada en el rango.

          Por omisión salen todos, como en la hoja: un vendedor en cero es una
          noticia y esconderlo por defecto la tapa. El interruptor está para
          cuando lo que se quiere es leer sólo a los que movieron.
        */}
        <label className="flex items-center gap-2 pb-[9px] cursor-pointer">
          <input
            type="checkbox"
            checked={ocultarSinMovimiento}
            onChange={(e) => ir({ ocultar: e.target.checked })}
            className="w-4 h-4 accent-[var(--color-acento)]"
          />
          <span className="text-meta text-cuerpo">
            Ocultar los que no vendieron
            {sinMovimiento > 0 && (
              <span className="text-mudo"> · {sinMovimiento} en cero</span>
            )}
          </span>
        </label>

        {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
      </div>
    </div>
  );
}
