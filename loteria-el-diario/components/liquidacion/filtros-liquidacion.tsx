"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";

export type OpcionVendedorLiq = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  eliminado: boolean;
  /** Sorteos liquidados que todavía no se le han pagado. */
  pendientes: number;
};

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta";

/**
 * Filtros del módulo de liquidación.
 *
 * Van en la URL, como los de reportes: así el informe de una semana concreta se
 * puede compartir o volver a abrir, y el botón de atrás del navegador hace lo
 * que uno espera.
 */
export function FiltrosLiquidacion({
  vendedores,
  vendedorId,
  desde,
  hasta,
  semanas,
}: {
  vendedores: OpcionVendedorLiq[];
  vendedorId: string;
  desde: string;
  hasta: string;
  /** Atajos de semana ya calculados en el servidor, en hora de Honduras. */
  semanas: { etiqueta: string; desde: string; hasta: string }[];
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambio: { vendedor?: string; desde?: string; hasta?: string }) => {
    const p = new URLSearchParams();
    p.set("vendedor", cambio.vendedor ?? vendedorId);
    p.set("desde", cambio.desde ?? desde);
    p.set("hasta", cambio.hasta ?? hasta);
    iniciar(() => router.push(`/liquidacion?${p.toString()}`));
  };

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[14px] flex flex-col gap-4">
      <div className="flex gap-[6px] flex-wrap">
        {semanas.map((s) => (
          <button
            key={s.etiqueta}
            type="button"
            onClick={() => ir({ desde: s.desde, hasta: s.hasta })}
            className={cn(
              "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
              desde === s.desde && hasta === s.hasta
                ? "bg-tinta text-white border-tinta"
                : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
            )}
          >
            {s.etiqueta}
          </button>
        ))}
      </div>

      <div className="flex gap-4 flex-wrap items-end">
        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
          <select
            value={vendedorId}
            onChange={(e) => ir({ vendedor: e.target.value })}
            className={cn(CLASE_CONTROL, "min-w-[280px]")}
          >
            <option value="">Elija un vendedor…</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.codigo} · {v.nombre}
                {v.eliminado ? " (eliminado)" : !v.activo ? " (inactivo)" : ""}
                {v.pendientes > 0 ? ` · ${v.pendientes} sin pagar` : ""}
              </option>
            ))}
          </select>
        </label>

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

        {pendiente && (
          <Boton variante="ghost" disabled>
            Cargando…
          </Boton>
        )}
      </div>
    </div>
  );
}
