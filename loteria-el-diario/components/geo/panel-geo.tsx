"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import type { Punto } from "@/components/geo/mapa";
import { cn } from "@/lib/cn";
import { fmt, fmtK } from "@/lib/format";

/**
 * Leaflet toca `window` al cargarse, así que el mapa no puede renderizarse en
 * el servidor. Se carga sólo en el navegador.
 */
const Mapa = dynamic(() => import("@/components/geo/mapa"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[560px] rounded-pos bg-riel border border-borde flex items-center justify-center text-meta text-mudo">
      Cargando el mapa…
    </div>
  ),
});

export type OpcionVendedor = {
  id: string;
  nombre: string;
  codigo: string;
  color: string;
  zona: string;
};
export type Zona = { nombre: string; color: string; monto: number; puntos: number };

const CIUDADES: { etiqueta: string; centro: [number, number] }[] = [
  { etiqueta: "San Pedro Sula", centro: [15.5045, -88.025] },
  { etiqueta: "Choloma", centro: [15.6136, -87.9525] },
];

export function PanelGeo({
  puntos,
  vendedores,
  zonas,
  vendedorActivo,
  fecha,
}: {
  puntos: Punto[];
  vendedores: OpcionVendedor[];
  zonas: Zona[];
  vendedorActivo: string;
  fecha: string;
}) {
  // El filtro vive en la URL, como en el resto de pantallas: así el mapa de un
  // vendedor concreto se puede compartir por enlace.
  const router = useRouter();
  const [navegando, iniciar] = useTransition();
  const cambiarVendedor = (id: string) => {
    const p = new URLSearchParams({ fecha });
    if (id) p.set("vendedor", id);
    iniciar(() => router.push(`/geo?${p.toString()}`));
  };
  const [encuadre, setEncuadre] = useState<{ centro: [number, number]; zoom: number }>({
    centro: [15.56, -87.99],
    zoom: 11,
  });

  const montoTotal = useMemo(() => puntos.reduce((a, p) => a + p.total, 0), [puntos]);
  const maxZona = Math.max(1, ...zonas.map((z) => z.monto));
  const activo = vendedores.find((v) => v.id === vendedorActivo);

  return (
    <div className="flex gap-[18px] flex-wrap items-start">
      <div className="flex-1 min-w-[600px] bg-superficie border border-borde rounded-card shadow-card p-[14px]">
        <div className="flex items-center gap-4 flex-wrap mb-3">
          <select
            value={vendedorActivo}
            onChange={(e) => cambiarVendedor(e.target.value)}
            className="px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie min-w-[260px]"
          >
            <option value="">Todos los vendedores</option>
            {vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nombre} · {v.codigo}
              </option>
            ))}
          </select>

          <span className="flex items-center gap-2 text-meta text-secundario">
            <span
              className="w-[10px] h-[10px] rounded-full inline-block"
              style={{ background: activo?.color ?? "var(--color-acento)" }}
            />
            {navegando
              ? "actualizando…"
              : activo
                ? activo.zona
                : `red completa · ${vendedores.length} vendedores`}
          </span>

          <span className="ml-auto flex gap-[6px]">
            {CIUDADES.map((c) => (
              <button
                key={c.etiqueta}
                onClick={() => setEncuadre({ centro: c.centro, zoom: 13 })}
                className="border border-borde-campo bg-superficie text-cuerpo rounded-campo px-[13px] py-[7px] text-meta cursor-pointer hover:bg-panel"
              >
                {c.etiqueta}
              </button>
            ))}
          </span>
        </div>

        <Mapa puntos={puntos} centro={encuadre.centro} zoom={encuadre.zoom} />

        <p className="text-label text-mudo mt-2 mb-0">
          Teselas de OpenStreetMap. Cada punto es un ticket, con el tamaño según su monto.
        </p>
      </div>

      <div className="flex-1 min-w-[280px] max-w-[340px] flex flex-col gap-[14px]">
        <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
          <span className="block text-meta font-medium text-cuerpo">Puntos mostrados</span>
          <span className="block text-kpi font-semibold tracking-titular mt-1">
            {puntos.length}
          </span>
          <span className="block text-label text-secundario mt-1">
            {fmt(montoTotal)} en el filtro actual
          </span>
        </div>

        <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
          <h2 className="text-card font-semibold m-0">Venta por zona</h2>
          {zonas.length === 0 ? (
            <p className="text-meta text-mudo mt-3 mb-0">Sin ventas con coordenada este día.</p>
          ) : (
            <div className="flex flex-col gap-3 mt-3">
              {zonas.map((z) => (
                <div key={z.nombre}>
                  <div className="flex justify-between items-baseline mb-[5px]">
                    <span className="text-meta font-medium">{z.nombre}</span>
                    <span className="text-meta font-semibold" style={{ color: z.color }}>
                      {fmtK(z.monto)}
                    </span>
                  </div>
                  <span className="block h-2 rounded-barra-geo bg-chip overflow-hidden">
                    <span
                      className="block h-2 rounded-barra-geo"
                      style={{
                        width: `${Math.round((z.monto / maxZona) * 100)}%`,
                        background: z.color,
                      }}
                    />
                  </span>
                  <span className="block text-th text-mudo mt-1">
                    {z.puntos} {z.puntos === 1 ? "ticket" : "tickets"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className={cn(
            "bg-panel border border-borde rounded-card px-[17px] py-[15px]",
            "text-meta text-cuerpo leading-[1.55]",
          )}
        >
          La coordenada se toma del dispositivo al momento de la venta y sirve para detectar
          ventas fuera de la zona asignada, medir cobertura real y validar rutas antes de abrir
          nuevos puntos. Es dato operativo sensible: sólo la ven perfiles administrativos y nunca
          sale en la consulta pública.
        </div>
      </div>
    </div>
  );
}
