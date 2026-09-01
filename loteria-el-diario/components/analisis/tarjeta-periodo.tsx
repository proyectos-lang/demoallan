import { Tarjeta } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fmt, fmtK, pad2 } from "@/lib/format";

export type Periodo = {
  /** Título de la tarjeta: «agosto 2026», «lunes», «T1 — sem. 1 a 13». */
  titulo: string;
  /** A la derecha del título: «7 días», «26 semanas», la lotería. */
  meta?: string;
  venta: number;
  comision: number;
  premios: number;
  neto: number;
  /** Sólo cuando la tarjeta ES un sorteo: entonces hay un número y explica los premios. */
  ganador?: number | null;
};

/**
 * La tarjeta de resultado de un período.
 *
 * Es la hoja mes por mes del simulador, que es la forma en que este negocio
 * lee un resultado: las tres cifras que lo componen, el neto destacado debajo
 * de un filete y el margen al pie. Vive aquí y no dentro de una pantalla
 * porque la usan el análisis de resultados y el análisis financiero del
 * informe, y dos copias de esto se separan a la primera corrección.
 *
 * El neto es la única cifra que cambia de color. Si se colorearan también los
 * premios —rojo porque salen— la tarjeta tendría tres semáforos y ninguno
 * diría nada.
 */
export function TarjetaPeriodo({
  p,
  anterior,
  etiquetaAnterior = "Contra el anterior",
}: {
  p: Periodo;
  /**
   * El neto del período anterior de la misma serie. `null` lo dibuja como
   * primero del rango; omitirlo quita el pie entero, que es lo que hace falta
   * en series sin orden —los días de la semana no tienen «anterior».
   */
  anterior?: number | null;
  etiquetaAnterior?: string;
}) {
  const margen = p.venta ? (p.neto / p.venta) * 100 : 0;
  const dif = anterior === null || anterior === undefined ? null : p.neto - anterior;
  const conPie = anterior !== undefined;

  const filas: [string, string][] = [
    ["Venta bruta", fmt(p.venta, false)],
    ["Comisiones", fmt(p.comision, false)],
    ["Premios", fmt(p.premios, false)],
  ];

  return (
    <Tarjeta padding="16px 18px">
      <div className="flex justify-between items-baseline border-b border-riel pb-3 gap-3">
        <span className="text-cta font-semibold tracking-sutil">{p.titulo}</span>
        {p.meta && <span className="text-micro text-secundario flex-none">{p.meta}</span>}
      </div>

      <div className="grid [grid-template-columns:1fr_auto] gap-x-3 gap-y-[7px] mt-3">
        {/* A grano de sorteo la tarjeta es un sorteo, así que hay un número y
            es el que explica los premios de abajo. La misma píldora que en el
            reporte del vendedor: un número ganador se ve igual en todo el
            sistema. */}
        {p.ganador !== null && p.ganador !== undefined && (
          <>
            <span className="text-tabla text-secundario">Número ganador</span>
            <span className="text-right">
              <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
                {pad2(p.ganador)}
              </span>
            </span>
          </>
        )}

        {filas.map(([etiqueta, valor]) => (
          <Fila key={etiqueta} etiqueta={etiqueta} valor={valor} />
        ))}

        <span className="text-tabla font-medium border-t border-riel pt-2">Utilidad neta</span>
        <span
          className={cn(
            "text-card font-semibold text-right border-t border-riel pt-2",
            p.neto < 0 ? "text-negativo" : "text-tinta",
          )}
        >
          {fmt(p.neto, false)}
        </span>

        <span className="text-tabla text-secundario">Margen</span>
        <span className={cn("text-tabla text-right", margen < 0 ? "text-negativo" : "text-cuerpo")}>
          {margen.toFixed(2)}%
        </span>
      </div>

      {conPie && (
        <div className="flex justify-between border-t border-riel mt-3 pt-3">
          <span className="text-tabla text-secundario">
            {dif === null ? "Primero del rango" : etiquetaAnterior}
          </span>
          <strong
            className={cn(
              "text-card font-semibold",
              dif === null ? "text-mudo" : dif < 0 ? "text-negativo" : "text-positivo",
            )}
          >
            {dif === null ? "—" : `${dif > 0 ? "+" : ""}${fmtK(dif)}`}
          </strong>
        </div>
      )}
    </Tarjeta>
  );
}

/** Una fila etiqueta–valor de la tarjeta. */
function Fila({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <>
      <span className="text-tabla text-secundario">{etiqueta}</span>
      <span className="text-tabla text-right text-cuerpo">{valor}</span>
    </>
  );
}
