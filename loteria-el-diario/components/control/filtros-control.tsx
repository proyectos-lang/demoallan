"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Check, Search } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";
import { hora12, iso } from "@/lib/format";

export type OpcionVendedor = {
  id: string;
  codigo: string;
  nombre: string;
  zona: string;
  color: string;
};

export type ValoresFiltro = {
  desde: string;
  hasta: string;
  vendedores: string[];
  hora: string;
};

/**
 * Filtros del control de vendedores.
 *
 * Con treinta vendedores, una fila de fichas con el código deja de servir: hay
 * que buscar por nombre, que es como se les llama. De ahí la lista con búsqueda
 * y selección múltiple en vez de las fichas de antes.
 *
 * Los atajos de rango existen porque las tres preguntas reales son «cómo va
 * hoy», «cómo va la semana» y «cómo cerró el mes»; teclear dos fechas para eso
 * es fricción pura.
 */
export function FiltrosControl({
  valores,
  vendedores,
}: {
  valores: ValoresFiltro;
  vendedores: OpcionVendedor[];
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const [desde, setDesde] = useState(valores.desde);
  const [hasta, setHasta] = useState(valores.hasta);
  const [hora, setHora] = useState(valores.hora);
  const [elegidos, setElegidos] = useState<Set<string>>(new Set(valores.vendedores));
  const [busqueda, setBusqueda] = useState("");

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return vendedores;
    return vendedores.filter(
      (v) =>
        v.nombre.toLowerCase().includes(q) ||
        v.codigo.toLowerCase().includes(q) ||
        v.zona.toLowerCase().includes(q),
    );
  }, [busqueda, vendedores]);

  const alternar = (id: string) => {
    setElegidos((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const aplicar = (extra?: Partial<ValoresFiltro>) => {
    const v: ValoresFiltro = {
      desde,
      hasta,
      hora,
      vendedores: [...elegidos],
      ...extra,
    };
    const p = new URLSearchParams();
    p.set("desde", v.desde);
    p.set("hasta", v.hasta);
    if (v.hora) p.set("hora", v.hora);
    // Ninguno elegido significa «todos», y así no hay que llevar treinta
    // identificadores en la barra de direcciones para el caso normal.
    if (v.vendedores.length) p.set("vendedores", v.vendedores.join(","));
    iniciar(() => router.push(`/control?${p.toString()}`));
  };

  const hoy = new Date();
  const atajos: { etiqueta: string; desde: string; hasta: string }[] = [
    { etiqueta: "Hoy", desde: iso(hoy), hasta: iso(hoy) },
    {
      etiqueta: "7 días",
      desde: iso(new Date(hoy.getTime() - 6 * 86_400_000)),
      hasta: iso(hoy),
    },
    {
      etiqueta: "30 días",
      desde: iso(new Date(hoy.getTime() - 29 * 86_400_000)),
      hasta: iso(hoy),
    },
    {
      etiqueta: "Este mes",
      desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)),
      hasta: iso(hoy),
    },
    {
      etiqueta: "Mes anterior",
      desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)),
      hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)),
    },
  ];

  const clasePildora = (activo: boolean) =>
    cn(
      "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
      activo
        ? "bg-tinta text-white border-tinta"
        : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
    );

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[14px] flex flex-col gap-4">
      {/* --- Rango --- */}
      <div className="flex gap-4 flex-wrap items-end">
        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">Desde</span>
          <input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => setDesde(e.target.value)}
            className="px-3 py-[7px] border border-borde-campo rounded-campo text-meta outline-none bg-superficie"
          />
        </div>
        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">Hasta</span>
          <input
            type="date"
            value={hasta}
            min={desde}
            onChange={(e) => setHasta(e.target.value)}
            className="px-3 py-[7px] border border-borde-campo rounded-campo text-meta outline-none bg-superficie"
          />
        </div>

        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">Atajos</span>
          <div className="flex gap-[6px] flex-wrap">
            {atajos.map((a) => (
              <button
                key={a.etiqueta}
                type="button"
                onClick={() => {
                  setDesde(a.desde);
                  setHasta(a.hasta);
                  aplicar({ desde: a.desde, hasta: a.hasta });
                }}
                className={clasePildora(desde === a.desde && hasta === a.hasta)}
              >
                {a.etiqueta}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">Sorteo</span>
          <div className="flex gap-[6px]">
            {[
              { v: "", e: "Todos" },
              { v: "11:00", e: hora12("11:00") },
              { v: "15:00", e: hora12("15:00") },
              { v: "20:00", e: hora12("20:00") },
            ].map((o) => (
              <button
                key={o.v || "todos"}
                type="button"
                onClick={() => {
                  setHora(o.v);
                  aplicar({ hora: o.v });
                }}
                className={clasePildora(hora === o.v)}
              >
                {o.e}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* --- Vendedores --- */}
      <div className="border-t border-riel pt-[14px]">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-[10px]">
          <span className="text-label text-secundario font-medium">
            Vendedores
            {elegidos.size > 0 && (
              <span className="text-mudo font-normal"> · {elegidos.size} elegidos</span>
            )}
            {elegidos.size === 0 && (
              <span className="text-mudo font-normal"> · todos</span>
            )}
          </span>

          <div className="flex items-center gap-[10px] flex-wrap">
            <span className="relative">
              <Search
                size={14}
                color="var(--color-mudo)"
                strokeWidth={2}
                absoluteStrokeWidth
                className="absolute left-[9px] top-1/2 -translate-y-1/2"
              />
              <input
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre o zona"
                className="w-[220px] pl-[28px] pr-3 py-[7px] border border-borde-campo rounded-campo text-meta outline-none"
              />
            </span>
            <button
              type="button"
              onClick={() => setElegidos(new Set())}
              className="text-meta text-acento font-medium"
            >
              limpiar
            </button>
            <Boton onClick={() => aplicar()} disabled={pendiente}>
              {pendiente ? "Aplicando…" : "Aplicar"}
            </Boton>
          </div>
        </div>

        <div className="grid gap-[6px] max-h-[184px] overflow-y-auto pr-1 [grid-template-columns:repeat(auto-fill,minmax(232px,1fr))]">
          {filtrados.map((v) => {
            const activo = elegidos.has(v.id);
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => alternar(v.id)}
                className={cn(
                  "flex items-center gap-[9px] rounded-campo border px-[10px] py-[7px] text-left",
                  activo
                    ? "border-acento bg-acento-suave"
                    : "border-borde-campo bg-superficie hover:bg-panel",
                )}
              >
                <span
                  className={cn(
                    "w-[18px] h-[18px] flex-none rounded-[5px] border flex items-center justify-center",
                    activo ? "border-acento bg-acento" : "border-borde-punteado",
                  )}
                >
                  {activo && <Check size={12} color="#fff" strokeWidth={3} absoluteStrokeWidth />}
                </span>
                <span
                  className="w-[3px] h-[26px] flex-none rounded-[2px]"
                  style={{ background: v.color }}
                />
                <span className="block min-w-0">
                  <span className="block text-meta font-medium truncate">{v.nombre}</span>
                  <span className="block text-label text-secundario truncate">
                    {v.codigo} · {v.zona}
                  </span>
                </span>
              </button>
            );
          })}
          {filtrados.length === 0 && (
            <p className="text-meta text-mudo m-0 py-2">Ningún vendedor coincide con «{busqueda}».</p>
          )}
        </div>
      </div>
    </div>
  );
}
