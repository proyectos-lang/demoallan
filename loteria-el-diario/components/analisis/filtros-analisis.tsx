"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type Grano = "dia" | "semana" | "mes" | "anio";
export type OpcionVendedor = { id: string; codigo: string; nombre: string };
export type Vista = { etiqueta: string; desde: string; hasta: string; grano: Grano };

const GRANOS: { id: Grano; etiqueta: string }[] = [
  { id: "dia", etiqueta: "Día a día" },
  { id: "semana", etiqueta: "Semana a semana" },
  { id: "mes", etiqueta: "Mes a mes" },
  { id: "anio", etiqueta: "Año a año" },
];

const LOTERIAS = ["11:00", "15:00", "20:00"];

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta";

const clasePildora = (activo: boolean) =>
  cn(
    "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
    activo
      ? "bg-tinta text-white border-tinta"
      : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
  );

/**
 * Los filtros del análisis.
 *
 * Rango y grano son dos cosas distintas y por eso van separados: el rango dice
 * QUÉ período se mira y el grano CÓMO se parte. La misma semana se puede leer
 * día a día o entera, y el mismo año mes a mes o de una.
 *
 * Las vistas de arriba son las combinaciones que se piden de verdad —una
 * semana día por día, un mes semana por semana, un año mes por mes— y ponen
 * las dos cosas de un toque. Debajo quedan sueltas para lo demás.
 */
export function FiltrosAnalisis({
  desde,
  hasta,
  grano,
  vendedorId,
  hora,
  vistas,
  vendedores,
}: {
  desde: string;
  hasta: string;
  grano: Grano;
  vendedorId: string;
  hora: string;
  vistas: Vista[];
  vendedores: OpcionVendedor[];
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambio: Partial<{ desde: string; hasta: string; grano: Grano; vendedor: string; hora: string }>) => {
    const p = new URLSearchParams({
      desde: cambio.desde ?? desde,
      hasta: cambio.hasta ?? hasta,
      grano: cambio.grano ?? grano,
    });
    const v = cambio.vendedor ?? vendedorId;
    const h = cambio.hora ?? hora;
    if (v) p.set("vendedor", v);
    if (h) p.set("hora", h);
    iniciar(() => router.push(`/analisis?${p.toString()}`));
  };

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[14px] flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-label text-secundario font-medium w-[62px] flex-none">Vistas</span>
        <div className="flex gap-[6px] flex-wrap">
          {vistas.map((v) => (
            <button
              key={v.etiqueta}
              type="button"
              onClick={() => ir({ desde: v.desde, hasta: v.hasta, grano: v.grano })}
              className={clasePildora(
                desde === v.desde && hasta === v.hasta && grano === v.grano,
              )}
            >
              {v.etiqueta}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap border-t border-riel pt-3">
        <span className="text-label text-secundario font-medium w-[62px] flex-none">Partir en</span>
        <div className="flex gap-[6px] flex-wrap">
          {GRANOS.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => ir({ grano: g.id })}
              className={clasePildora(grano === g.id)}
            >
              {g.etiqueta}
            </button>
          ))}
        </div>
      </div>

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

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
          <select
            value={vendedorId}
            onChange={(e) => ir({ vendedor: e.target.value })}
            className={cn(CLASE_CONTROL, "min-w-[220px]")}
          >
            <option value="">Todos</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.codigo} · {v.nombre}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Lotería</span>
          <select
            value={hora}
            onChange={(e) => ir({ hora: e.target.value })}
            className={CLASE_CONTROL}
          >
            <option value="">Las tres</option>
            {/* El value sigue siendo la etiqueta del enum: sólo cambia lo que se lee. */}
            {LOTERIAS.map((h) => (
              <option key={h} value={h}>
                {hora12(h)}
              </option>
            ))}
          </select>
        </label>

        {(vendedorId || hora) && (
          <button
            type="button"
            onClick={() => ir({ vendedor: "", hora: "" })}
            className="text-meta text-acento font-medium pb-[10px]"
          >
            quitar filtros
          </button>
        )}

        {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
      </div>
    </div>
  );
}
