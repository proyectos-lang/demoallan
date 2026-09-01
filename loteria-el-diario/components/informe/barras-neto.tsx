import { cn } from "@/lib/cn";
import { fmt, fmtK } from "@/lib/format";

export type BarraNeto = { clave: string; etiqueta: string; titulo: string; neto: number };

const ALTO = 150;

/**
 * El neto semana a semana, con las pérdidas colgando bajo la línea del cero.
 *
 * Un gráfico de barras normal —todas hacia arriba desde la base— no sirve
 * aquí: la mitad de las semanas son negativas y dibujarlas hacia arriba las
 * haría parecer buenas. La línea del cero se coloca donde le toca según la
 * mejor y la peor semana, así que las dos escalas son la misma y una barra
 * roja del doble de alto que una verde es de verdad el doble de dinero.
 *
 * Cuando todas las semanas son del mismo signo la línea queda pegada a un
 * borde, que es exactamente lo que hay que ver.
 */
export function BarrasNeto({ barras }: { barras: BarraNeto[] }) {
  if (barras.length === 0) return null;

  const techo = Math.max(0, ...barras.map((b) => b.neto));
  const suelo = Math.min(0, ...barras.map((b) => b.neto));
  const recorrido = techo - suelo || 1;

  const altoArriba = Math.round((techo / recorrido) * ALTO);
  const altoAbajo = ALTO - altoArriba;

  return (
    <div className="overflow-x-auto">
      <div className="flex items-stretch gap-[4px] min-w-max px-[2px]">
        {barras.map((b) => {
          const positivo = b.neto >= 0;
          const alto = Math.max(
            2,
            Math.round((Math.abs(b.neto) / recorrido) * ALTO),
          );
          return (
            <div key={b.clave} className="flex flex-col w-[26px] flex-none">
              {/* Mitad de arriba: la barra crece desde la línea del cero. */}
              <div className="flex flex-col justify-end items-center" style={{ height: altoArriba }}>
                {positivo && (
                  <>
                    <span className="text-[9px] leading-none text-secundario mb-[3px] whitespace-nowrap">
                      {fmtK(b.neto).replace("L ", "")}
                    </span>
                    <span
                      title={`${b.titulo} · ${fmt(b.neto)}`}
                      className="w-full rounded-[4px_4px_0_0] bg-positivo-vivo"
                      style={{ height: Math.min(alto, Math.max(0, altoArriba - 12)) }}
                    />
                  </>
                )}
              </div>

              <span className="h-px bg-borde-campo block" />

              {/* Mitad de abajo: cuelga. */}
              <div className="flex flex-col items-center" style={{ height: altoAbajo }}>
                {!positivo && (
                  <>
                    <span
                      title={`${b.titulo} · ${fmt(b.neto)}`}
                      className="w-full rounded-[0_0_4px_4px] bg-negativo"
                      style={{ height: Math.min(alto, Math.max(0, altoAbajo - 12)) }}
                    />
                    <span className="text-[9px] leading-none text-negativo mt-[3px] whitespace-nowrap">
                      {fmtK(b.neto).replace("L ", "")}
                    </span>
                  </>
                )}
              </div>

              <span
                className={cn(
                  "text-[9px] leading-none text-center mt-[6px]",
                  positivo ? "text-mudo" : "text-negativo",
                )}
              >
                {b.etiqueta}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
