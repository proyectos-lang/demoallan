import { fmtK, mesNombre } from "@/lib/format";

export type PuntoMes = { mes: number; utilidad: number };

/**
 * Utilidad mes por mes: área + línea, en SVG calculado a mano.
 *
 * La geometría se porta literalmente del prototipo y conviene no «arreglarla»:
 *
 *  - `viewBox="0 0 1000 280"` con `preserveAspectRatio="none"` y alto fijo de
 *    270 px. El eje X se estira sin conservar proporción, así que los círculos
 *    de los puntos se ven como elipses. Es el aspecto aprobado.
 *  - `minU = min(0, …)`: el cero siempre entra en la escala, para que un mes en
 *    pérdida se lea como pérdida y no como «la barra más corta».
 *  - Las etiquetas de mes NO van dentro del SVG: van en una fila hermana, para
 *    que no se deformen con el estirado horizontal.
 */
export function GraficoMensual({
  meses,
  acento = "var(--color-acento)",
}: {
  meses: PuntoMes[];
  acento?: string;
}) {
  if (meses.length === 0) {
    return (
      <div className="border border-dashed border-borde-punteado rounded-pos py-[30px] px-[18px] text-center">
        <p className="text-base font-medium text-cuerpo m-0">Todavía no hay meses liquidados</p>
        <p className="text-meta text-mudo mt-1 mb-0">
          El gráfico aparece en cuanto se liquide el primer sorteo.
        </p>
      </div>
    );
  }

  const utils = meses.map((m) => m.utilidad);
  const minU = Math.min(0, ...utils);
  const maxU = Math.max(...utils);
  const spanU = maxU - minU || 1;

  const X = (i: number) => (meses.length > 1 ? (i / (meses.length - 1)) * 960 + 20 : 500);
  const Y = (u: number) => 240 - ((u - minU) / spanU) * 210;

  const puntos = meses.map((m, i) => `${X(i).toFixed(1)},${Y(m.utilidad).toFixed(1)}`);
  const linea = puntos.join(" ");
  const area = `M${X(0).toFixed(1)},${Y(minU).toFixed(1)} L${puntos.join(" L")} L${X(
    meses.length - 1,
  ).toFixed(1)},${Y(minU).toFixed(1)} Z`;

  return (
    <>
      <svg
        viewBox="0 0 1000 280"
        preserveAspectRatio="none"
        style={{ width: "100%", height: 270, display: "block", overflow: "visible" }}
      >
        {[0, 1, 2, 3].map((i) => (
          <line
            key={i}
            x1={0}
            x2={1000}
            y1={30 + i * 70}
            y2={30 + i * 70}
            stroke="var(--color-riel)"
            strokeWidth={1}
          />
        ))}
        <path d={area} fill="rgba(37,99,235,.10)" />
        <polyline
          points={linea}
          fill="none"
          stroke={acento}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {meses.map((m, i) => (
          <circle
            key={i}
            cx={X(i)}
            cy={Y(m.utilidad)}
            r={4.5}
            fill="#fff"
            stroke={m.utilidad < 0 ? "var(--color-negativo)" : acento}
            strokeWidth={2.5}
          />
        ))}
      </svg>

      <div className="flex mt-2">
        {meses.map((m) => (
          <span key={m.mes} className="flex-1 text-center">
            <span
              className="block text-meta font-semibold"
              style={{ color: m.utilidad < 0 ? "var(--color-negativo)" : "var(--color-tinta)" }}
            >
              {fmtK(m.utilidad)}
            </span>
            <span className="block text-label text-mudo">{mesNombre(m.mes)}</span>
          </span>
        ))}
      </div>
    </>
  );
}
