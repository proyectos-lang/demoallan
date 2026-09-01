"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { fmtK } from "@/lib/format";

export type SemanaDelRiel = {
  inicio: string;
  fin: string;
  semana: number;
  anio: number;
  neto: number;
};

const MESES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/** `3 – 9 ago`, o `28 sep – 4 oct` cuando la semana cambia de mes. */
function rango(inicio: string, fin: string): string {
  const [, m1, d1] = inicio.split("-").map(Number);
  const [, m2, d2] = fin.split("-").map(Number);
  return m1 === m2
    ? `${d1} – ${d2} ${MESES[m1 - 1]}`
    : `${d1} ${MESES[m1 - 1]} – ${d2} ${MESES[m2 - 1]}`;
}

/**
 * El riel de semanas, a la izquierda del resumen.
 *
 * Es una lista entera y no un desplegable, a propósito: el gerente compara
 * semanas: salta de la 34 a la 31 y vuelve, y con un desplegable eso son tres
 * gestos por salto en vez de uno. Cada entrada lleva su neto porque es lo que
 * hace que la lista sirva sin abrirla — una semana en rojo se localiza de un
 * vistazo.
 *
 * El número de semana va con su rango de fechas debajo. El número solo obliga
 * a fiarse de una convención; las fechas no se discuten.
 */
export function RielSemanas({
  semanas,
  activa,
}: {
  semanas: SemanaDelRiel[];
  /** El lunes de la semana abierta. */
  activa: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  return (
    <div className="w-[186px] flex-none bg-superficie border border-borde rounded-card shadow-card overflow-hidden self-start">
      <div className="px-[14px] py-[11px] border-b border-riel bg-tinte flex items-baseline justify-between gap-2">
        <span className="text-th font-semibold tracking-th text-secundario">SEMANAS</span>
        <span className="text-th text-mudo">{semanas.length}</span>
      </div>

      {/* Alto acotado y desplazamiento propio: con un año de operación son más
          de cincuenta entradas y el riel no debe estirar la página. */}
      <div className="max-h-[560px] overflow-y-auto">
        {semanas.map((s) => {
          const abierta = s.inicio === activa;
          return (
            <button
              key={s.inicio}
              type="button"
              onClick={() =>
                iniciar(() => router.push(`/informe?vista=semanal&semana=${s.inicio}`))
              }
              aria-current={abierta ? "true" : undefined}
              className={cn(
                "w-full text-left px-[14px] py-[9px] border-b border-fondo cursor-pointer block",
                abierta ? "bg-acento-suave" : "hover:bg-tinte",
              )}
            >
              <span
                className={cn(
                  "block text-tabla font-semibold",
                  abierta ? "text-acento-fuerte" : "text-tinta",
                )}
              >
                Semana #{s.semana}
              </span>
              <span className="flex items-baseline justify-between gap-2 mt-[2px]">
                <span className="text-th text-secundario">{rango(s.inicio, s.fin)}</span>
                <span
                  className={cn(
                    "text-th font-medium",
                    s.neto < 0 ? "text-negativo" : "text-positivo",
                  )}
                >
                  {fmtK(s.neto)}
                </span>
              </span>
            </button>
          );
        })}

        {semanas.length === 0 && (
          <span className="block px-[14px] py-4 text-meta text-mudo">
            Todavía no hay ninguna semana liquidada.
          </span>
        )}
      </div>

      {pendiente && (
        <span className="block px-[14px] py-2 text-th text-secundario border-t border-riel">
          Cargando…
        </span>
      )}
    </div>
  );
}
