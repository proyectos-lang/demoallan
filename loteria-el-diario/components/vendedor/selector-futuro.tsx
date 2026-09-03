"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type SorteoDisponible = {
  fecha: string;
  hora: string;
  /** Admite venta: o no existe todavía, o está abierto y sin vencer. */
  vendible: boolean;
  /** Ya cerró o se liquidó. Se muestra apagado, no se oculta. */
  motivo: string | null;
};

/**
 * Elegir a qué sorteo futuro se vende.
 *
 * DOS PASOS Y NO UNO: primero el día, después la franja. Con una lista plana
 * de «todos los sorteos de los próximos treinta días» serían noventa botones,
 * y encontrar el del jueves por la tarde sería peor que teclear la fecha.
 *
 * El día se teclea en un campo de fecha normal —sin tope por arriba, que es lo
 * que pidió el negocio— y las tres franjas aparecen debajo con su estado. Un
 * sorteo que ya cerró se muestra apagado en vez de esconderse: que la tarde de
 * hoy ya no admita venta es información, y ocultarla haría pensar que el
 * sistema se equivocó.
 *
 * La elección vive en la dirección, como en el resto del sistema.
 */
export function SelectorFuturo({
  fecha,
  hora,
  sorteos,
  hoy,
}: {
  fecha: string;
  hora: string;
  sorteos: SorteoDisponible[];
  hoy: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (f: string, h: string) => {
    const p = new URLSearchParams({ dia: f });
    if (h) p.set("hora", h);
    iniciar(() => router.push(`/mis-ventas-futuras?${p.toString()}`));
  };

  const delDia = sorteos.filter((s) => s.fecha === fecha);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">Día del sorteo</span>
          <input
            type="date"
            value={fecha}
            /* Hacia atrás no se vende: un sorteo que ya pasó no admite
               apuestas, y la base lo rechaza igualmente. Mejor no ofrecerlo. */
            min={hoy}
            onChange={(e) => ir(e.target.value, "")}
            className="px-[13px] py-[11px] border border-borde-campo rounded-campo text-base bg-superficie text-cuerpo"
          />
        </label>

        {pendiente && <span className="text-meta text-secundario pb-[12px]">Cargando…</span>}
      </div>

      <div className="flex flex-col gap-[6px]">
        <span className="text-label text-secundario font-medium">Sorteo</span>
        <div className="flex gap-2 flex-wrap">
          {delDia.map((s) => (
            <button
              key={s.hora}
              type="button"
              disabled={!s.vendible || pendiente}
              onClick={() => ir(s.fecha, s.hora)}
              className={cn(
                "px-[15px] py-[11px] rounded-campo text-base font-medium border text-left",
                !s.vendible
                  ? "bg-panel border-borde-campo text-mudo cursor-default"
                  : hora === s.hora
                    ? "bg-acento border-acento text-white cursor-pointer"
                    : "bg-superficie border-borde-campo text-cuerpo cursor-pointer",
              )}
            >
              {hora12(s.hora)}
              {s.motivo && (
                <span className="block text-label text-mudo">{s.motivo}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
