"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { SORTEOS, hora12, jornada } from "@/lib/format";

export type SorteoDelDia = {
  hora: string;
  /** `liquidado` es el único estado con número ganador y con cifras que mirar. */
  estado: string;
  ganador: number | null;
};


const HORAS = SORTEOS;

function ruta(dia: string, hora: string, sinMovimiento: boolean): string {
  const p = new URLSearchParams({ vista: "diaria", dia });
  if (hora) p.set("hora", hora);
  if (sinMovimiento) p.set("conventa", "1");
  return `/informe?${p.toString()}`;
}

/**
 * Los filtros de la captura diaria: una fecha y un sorteo.
 *
 * Antes esto era un rango con atajos, una tira de días y una de loterías. Para
 * un rango ya están las otras pestañas; aquí la pregunta es siempre la misma
 * —qué pasó en este sorteo— y el filtro tenía más piezas que respuestas.
 *
 * Un sorteo sin liquidar se puede elegir igual y se dice que aún no tiene
 * resultado: que un sorteo no esté cerrado es información, y esconderlo haría
 * pensar que no existe.
 */
export function FiltrosDia({
  dia,
  hora,
  sorteos,
  soloConVenta,
  sinMovimiento,
}: {
  dia: string;
  hora: string;
  sorteos: SorteoDelDia[];
  soloConVenta: boolean;
  /** Cuántos vendedores están en cero, para rotular el interruptor. */
  sinMovimiento: number;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const ir = (destino: string) => iniciar(() => router.push(destino));

  const porHora = new Map(sorteos.map((s) => [s.hora, s]));

  return (
    <div className="flex items-end gap-3 flex-wrap">
      <label className="block">
        <span className="block text-label text-secundario font-medium mb-[6px]">Fecha</span>
        <input
          type="date"
          value={dia}
          onChange={(e) => e.target.value && ir(ruta(e.target.value, hora, soloConVenta))}
          className="px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
        />
      </label>

      <div className="flex gap-[6px] flex-wrap">
        {HORAS.map((h) => {
          const s = porHora.get(h);
          const activo = hora === h;
          return (
            <button
              key={h}
              type="button"
              onClick={() => ir(ruta(dia, h, soloConVenta))}
              aria-current={activo ? "true" : undefined}
              className={cn(
                "rounded-campo px-[13px] py-[6px] border text-left",
                activo
                  ? "bg-tinta text-white border-tinta"
                  : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
              )}
            >
              <span className="block text-meta font-medium leading-tight">{jornada(h)}</span>
              <span
                className={cn(
                  "block text-th leading-tight mt-[1px]",
                  activo ? "text-navy-suave" : "text-mudo",
                )}
              >
                {s && s.estado !== "liquidado" ? "sin resultado" : hora12(h)}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          /*
           * «todos» y no una hora vacía: sin parámetro, el servidor abre el
           * último sorteo con resultado, así que quitar la hora haría que esta
           * ficha nunca se quedara puesta. El valor dice «los tres a
           * propósito», que no es lo mismo que «no elegí».
           */
          onClick={() => ir(ruta(dia, "todos", soloConVenta))}
          aria-current={hora === "" ? "true" : undefined}
          className={cn(
            "rounded-campo px-[13px] py-[6px] border text-left",
            hora === ""
              ? "bg-tinta text-white border-tinta"
              : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
          )}
        >
          <span className="block text-meta font-medium leading-tight">Día completo</span>
          <span
            className={cn(
              "block text-th leading-tight mt-[1px]",
              hora === "" ? "text-navy-suave" : "text-mudo",
            )}
          >
            los tres
          </span>
        </button>
      </div>

      {sinMovimiento > 0 && (
        <button
          type="button"
          onClick={() => ir(ruta(dia, hora, !soloConVenta))}
          className="text-meta text-acento font-medium pb-[10px]"
        >
          {soloConVenta
            ? `mostrar los ${sinMovimiento} sin movimiento`
            : `ocultar los ${sinMovimiento} sin movimiento`}
        </button>
      )}

      {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
    </div>
  );
}
