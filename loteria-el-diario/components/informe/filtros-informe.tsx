"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type Atajo = { etiqueta: string; grupo: "Día" | "Semana" | "Mes"; desde: string; hasta: string };

/** Un día del rango, ya con su etiqueta armada en el servidor. */
export type DiaDelRango = { fecha: string; etiqueta: string };

const LOTERIAS = ["11:00", "15:00", "20:00"];

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
  dias,
  dia,
  hora,
}: {
  desde: string;
  hasta: string;
  atajos: Atajo[];
  ocultarSinMovimiento: boolean;
  /** Cuántos vendedores quedarían fuera al ocultarlos. */
  sinMovimiento: number;
  /** Los días del rango. Vacío cuando el rango es demasiado largo para listarlos. */
  dias: DiaDelRango[];
  /** Día concreto elegido dentro del rango, o cadena vacía para todos. */
  dia: string;
  /** Lotería elegida, o cadena vacía para las tres. */
  hora: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambio: {
    desde?: string;
    hasta?: string;
    ocultar?: boolean;
    dia?: string;
    hora?: string;
  }) => {
    const nuevoDesde = cambio.desde ?? desde;
    const nuevoHasta = cambio.hasta ?? hasta;
    const p = new URLSearchParams({ desde: nuevoDesde, hasta: nuevoHasta });

    // Cambiar de rango suelta el día elegido: un martes del rango anterior no
    // tiene por qué estar en el nuevo, y dejarlo puesto daría una tabla vacía
    // sin decir por qué.
    const cambioElRango = nuevoDesde !== desde || nuevoHasta !== hasta;
    const d = cambio.dia ?? (cambioElRango ? "" : dia);
    const h = cambio.hora ?? hora;

    if (d) p.set("dia", d);
    if (h) p.set("hora", h);
    if (cambio.ocultar ?? ocultarSinMovimiento) p.set("conventa", "1");
    iniciar(() => router.push(`/informe?${p.toString()}`));
  };

  const desglosado = Boolean(dia || hora);

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

      {/*
        El desglose dentro del rango.

        El gerente mira la semana y enseguida quiere bajar: «¿y el martes?»,
        «¿y sólo la de las once?». Las dos tiras son de un toque y se combinan,
        así que el martes a las once son dos toques desde el total.

        Van debajo del rango y separadas por un filete: el rango dice QUÉ
        período se está mirando y esto dice POR DÓNDE se está cortando.
      */}
      {dias.length > 0 && (
        <div className="border-t border-riel pt-3 flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-label text-secundario font-medium w-[52px] flex-none">Día</span>
            <div className="flex gap-[6px] flex-wrap">
              <button
                type="button"
                onClick={() => ir({ dia: "" })}
                className={cn(
                  "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                  dia === ""
                    ? "bg-acento text-white border-acento"
                    : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                )}
              >
                Todos
              </button>
              {dias.map((d) => (
                <button
                  key={d.fecha}
                  type="button"
                  onClick={() => ir({ dia: d.fecha })}
                  className={cn(
                    "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                    dia === d.fecha
                      ? "bg-acento text-white border-acento"
                      : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                  )}
                >
                  {d.etiqueta}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-label text-secundario font-medium w-[52px] flex-none">
              Lotería
            </span>
            <div className="flex gap-[6px] flex-wrap">
              <button
                type="button"
                onClick={() => ir({ hora: "" })}
                className={cn(
                  "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                  hora === ""
                    ? "bg-acento text-white border-acento"
                    : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                )}
              >
                Las tres
              </button>
              {LOTERIAS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => ir({ hora: h })}
                  className={cn(
                    "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                    hora === h
                      ? "bg-acento text-white border-acento"
                      : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                  )}
                >
                  {hora12(h)}
                </button>
              ))}
            </div>

            {/* Sólo aparece cuando hay algo que deshacer: un botón que no hace
                nada la mitad del tiempo se deja de mirar. */}
            {desglosado && (
              <button
                type="button"
                onClick={() => ir({ dia: "", hora: "" })}
                className="ml-auto flex items-center gap-2 rounded-campo px-[13px] py-[7px] text-meta font-medium border border-borde-campo bg-superficie text-acento-fuerte hover:bg-panel"
              >
                <RotateCcw size={14} strokeWidth={2} absoluteStrokeWidth />
                Ver el total del rango
              </button>
            )}
          </div>
        </div>
      )}

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
