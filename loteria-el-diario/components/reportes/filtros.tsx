"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type OpcionVendedor = { id: string; nombre: string; codigo: string };

export type ValoresFiltro = {
  desde: string;
  hasta: string;
  vendedor: string;
  hora: string;
  numero: string;
  preset: string;
};

export type Preset = { id: string; etiqueta: string; desde: string; hasta: string };

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie";

/**
 * Los filtros viven en la URL, no en estado de cliente: así un reporte se
 * puede compartir por enlace y el botón de atrás del navegador funciona.
 */
export function FiltrosReporte({
  valores,
  vendedores,
  presets,
  conteo,
}: {
  valores: ValoresFiltro;
  vendedores: OpcionVendedor[];
  presets: Preset[];
  conteo: string;
}) {
  const router = useRouter();
  const [navegando, iniciar] = useTransition();

  const aplicar = (cambios: Partial<ValoresFiltro>) => {
    const siguiente = { ...valores, ...cambios };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(siguiente)) if (v) p.set(k, v);
    iniciar(() => router.push(`/reportes?${p.toString()}`));
  };

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
      <div className="flex gap-[6px] flex-wrap">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => aplicar({ preset: p.id, desde: p.desde, hasta: p.hasta })}
            className={cn(
              "rounded-campo px-[13px] py-[7px] text-meta font-medium border cursor-pointer",
              valores.preset === p.id
                ? "bg-tinta text-white border-tinta"
                : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
            )}
          >
            {p.etiqueta}
          </button>
        ))}
      </div>

      <div className="flex gap-4 flex-wrap items-end mt-4">
        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Desde</span>
          <input
            type="date"
            value={valores.desde}
            // Tocar una fecha a mano deja de ser un preset.
            onChange={(e) => e.target.value && aplicar({ desde: e.target.value, preset: "" })}
            className={CLASE_CONTROL}
          />
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Hasta</span>
          <input
            type="date"
            value={valores.hasta}
            onChange={(e) => e.target.value && aplicar({ hasta: e.target.value, preset: "" })}
            className={CLASE_CONTROL}
          />
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
          <select
            value={valores.vendedor}
            onChange={(e) => aplicar({ vendedor: e.target.value })}
            className={cn(CLASE_CONTROL, "min-w-[210px]")}
          >
            <option value="">Todos</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nombre} · {v.codigo}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Sorteo</span>
          <select
            value={valores.hora}
            onChange={(e) => aplicar({ hora: e.target.value })}
            className={CLASE_CONTROL}
          >
            <option value="">Todos</option>
            {/* El value sigue siendo la etiqueta del enum: sólo cambia lo que se lee. */}
            {["11:00", "15:00", "20:00"].map((h) => (
              <option key={h} value={h}>
                {hora12(h)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">
            Número ganador
          </span>
          <input
            value={valores.numero}
            placeholder="cualquiera"
            inputMode="numeric"
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "").slice(0, 2);
              // Se aplica sólo con dos dígitos o al borrarlo: con uno solo el
              // filtro no significa nada todavía.
              if (v.length === 2 || v.length === 0) aplicar({ numero: v });
            }}
            className={cn(CLASE_CONTROL, "w-[120px]")}
          />
        </label>

        <button
          onClick={() =>
            aplicar({ vendedor: "", hora: "", numero: "", preset: "mes", ...presetPorId(presets, "mes") })
          }
          className="border border-borde-campo bg-superficie text-cuerpo rounded-campo px-[13px] py-[7px] text-meta cursor-pointer hover:bg-panel"
        >
          Limpiar filtros
        </button>

        <span className="ml-auto text-meta text-secundario">
          {navegando ? "Actualizando…" : conteo}
        </span>
      </div>
    </div>
  );
}

function presetPorId(presets: Preset[], id: string) {
  const p = presets.find((x) => x.id === id);
  return p ? { desde: p.desde, hasta: p.hasta } : {};
}
