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
  /**
   * La cifra que se enseña a la derecha de cada entrada. Se llama así y no
   * `neto` porque no significa lo mismo en los dos módulos: en el informe es
   * el resultado de la semana y en la liquidación es lo que falta por cobrar.
   */
  cifra: number;
  /** Una marca corta debajo, cuando hay algo que decir: «pagada». */
  nota?: string;
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
  titulo = "SEMANAS",
  plantilla = "/informe?vista=semanal&semana={semana}",
}: {
  semanas: SemanaDelRiel[];
  /** El lunes de la semana abierta. */
  activa: string;
  titulo?: string;
  /**
   * A dónde lleva cada entrada, con `{semana}` donde va el lunes.
   *
   * Una PLANTILLA y no una función: quien usa el riel es un componente de
   * servidor, y una función no cruza esa frontera —no se puede serializar—.
   * Pasarla revienta el render entero con un error que no dice de dónde viene.
   */
  plantilla?: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  return (
    /*
     * A lo ancho en el teléfono y en columna a partir de `lg`.
     *
     * Con el ancho fijo de 186 px el riel se comía media pantalla de un
     * móvil y dejaba la tabla en una rendija. El portal del vendedor se usa
     * desde un teléfono, así que ahí ocupa todo el ancho y recorta su alto:
     * la lista sigue siendo entera, sólo que se desplaza dentro de menos
     * espacio.
     */
    <div className="w-full lg:w-[186px] flex-none bg-superficie border border-borde rounded-card shadow-card overflow-hidden self-start">
      <div className="px-[14px] py-[11px] border-b border-riel bg-tinte flex items-baseline justify-between gap-2">
        <span className="text-th font-semibold tracking-th text-secundario">{titulo}</span>
        <span className="text-th text-mudo">{semanas.length}</span>
      </div>

      {/* Alto acotado y desplazamiento propio: con un año de operación son más
          de cincuenta entradas y el riel no debe estirar la página. */}
      <div className="max-h-[220px] lg:max-h-[560px] overflow-y-auto">
        {semanas.map((s) => {
          const abierta = s.inicio === activa;
          return (
            <button
              key={s.inicio}
              type="button"
              onClick={() => iniciar(() => router.push(plantilla.replace("{semana}", s.inicio)))}
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
                    s.nota ? "text-mudo" : s.cifra < 0 ? "text-negativo" : "text-positivo",
                  )}
                >
                  {s.nota ?? fmtK(s.cifra)}
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
