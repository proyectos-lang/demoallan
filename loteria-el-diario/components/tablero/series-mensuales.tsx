import { fmtK, mesNombre } from "@/lib/format";

export type Mes = {
  mes: number;
  venta: number;
  comision: number;
  premios: number;
  utilidad: number;
};

type Serie = {
  clave: "venta" | "comision" | "premios" | "utilidad";
  titulo: string;
  nota: string;
  color: string;
};

/**
 * Las cuatro series se dibujan por separado y no superpuestas en un solo eje.
 *
 * Es deliberado: la venta bruta es del orden de diez millones al mes y la
 * comisión de un millón. En un eje común la comisión queda pegada al suelo y no
 * se le ve la forma, que es justo lo que uno quiere mirar. Cada gráfico tiene su
 * propia escala; lo que se compara entre ellos es la FORMA, no la altura.
 */
const SERIES: Serie[] = [
  {
    clave: "venta",
    titulo: "Venta bruta",
    nota: "Todo lo vendido, esté el sorteo liquidado o no.",
    color: "var(--color-acento)",
  },
  {
    clave: "comision",
    titulo: "Comisiones",
    nota: "Lo que se llevan los vendedores. Sube con la venta, no con el resultado.",
    color: "var(--color-v2)",
  },
  {
    clave: "premios",
    titulo: "Premios pagados",
    nota: "El azar del mes. Es la línea que decide si se gana o se pierde.",
    color: "var(--color-negativo)",
  },
  {
    clave: "utilidad",
    titulo: "Utilidad neta",
    nota: "Venta menos comisiones menos premios, sólo de sorteos liquidados.",
    color: "var(--color-positivo-vivo)",
  },
];

export function SeriesMensuales({ meses }: { meses: Mes[] }) {
  if (meses.length === 0) {
    return (
      <div className="border border-dashed border-borde-punteado rounded-pos py-[30px] px-[18px] text-center">
        <p className="text-base font-medium text-cuerpo m-0">Todavía no hay meses liquidados</p>
        <p className="text-meta text-mudo mt-1 mb-0">
          Los gráficos aparecen en cuanto se liquide el primer sorteo.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))]">
      {SERIES.map((s) => (
        <UnaSerie key={s.clave} serie={s} meses={meses} />
      ))}
    </div>
  );
}

function UnaSerie({ serie, meses }: { serie: Serie; meses: Mes[] }) {
  const valores = meses.map((m) => m[serie.clave]);

  // El cero siempre entra en la escala: un mes en pérdida tiene que leerse como
  // pérdida y no como «la barra más corta».
  const min = Math.min(0, ...valores);
  const max = Math.max(0, ...valores);
  const span = max - min || 1;

  // Misma geometría que el gráfico del prototipo: viewBox estirado sin conservar
  // proporción, y las etiquetas de mes fuera del SVG para que no se deformen.
  const X = (i: number) => (meses.length > 1 ? (i / (meses.length - 1)) * 960 + 20 : 500);
  const Y = (v: number) => 240 - ((v - min) / span) * 210;

  const puntos = meses.map((m, i) => `${X(i).toFixed(1)},${Y(m[serie.clave]).toFixed(1)}`);
  const cero = Y(0);

  const ultimo = valores[valores.length - 1];
  const primero = valores[0];
  const variacion = primero !== 0 ? ((ultimo - primero) / Math.abs(primero)) * 100 : 0;

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-h2 font-semibold tracking-sutil m-0">{serie.titulo}</h3>
          <p className="text-meta text-secundario mt-[5px] mb-0 max-w-[46ch]">{serie.nota}</p>
        </div>
        <div className="text-right">
          <span className="block text-h1 font-semibold tracking-titular">{fmtK(ultimo)}</span>
          <span
            className="block text-meta"
            style={{
              color:
                variacion >= 0 ? "var(--color-positivo)" : "var(--color-negativo)",
            }}
          >
            {variacion >= 0 ? "+" : "−"}
            {Math.abs(variacion).toFixed(0)}% desde {mesNombre(meses[0].mes)}
          </span>
        </div>
      </div>

      <svg
        viewBox="0 0 1000 280"
        preserveAspectRatio="none"
        className="w-full h-[170px] block mt-4"
        role="img"
        aria-label={`${serie.titulo} mes por mes`}
      >
        {[0, 1, 2, 3].map((i) => (
          <line
            key={i}
            x1="0"
            x2="1000"
            y1={30 + i * 70}
            y2={30 + i * 70}
            stroke="var(--color-riel)"
            strokeWidth="1"
          />
        ))}

        {/* El cero, marcado sólo cuando la serie llega a cruzarlo. */}
        {min < 0 && (
          <line
            x1="0"
            x2="1000"
            y1={cero}
            y2={cero}
            stroke="var(--color-borde-punteado)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
        )}

        <path
          d={`M${X(0).toFixed(1)},${Y(min).toFixed(1)} L${puntos.join(" L")} L${X(
            meses.length - 1,
          ).toFixed(1)},${Y(min).toFixed(1)} Z`}
          fill={serie.color}
          fillOpacity="0.10"
        />
        <polyline
          points={puntos.join(" ")}
          fill="none"
          stroke={serie.color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {meses.map((m, i) => (
          <circle
            key={m.mes}
            cx={X(i)}
            cy={Y(m[serie.clave])}
            r="4.5"
            fill="var(--color-superficie)"
            stroke={serie.color}
            strokeWidth="2.5"
          />
        ))}
      </svg>

      <div className="flex mt-[6px]">
        {meses.map((m) => (
          <span
            key={m.mes}
            className="flex-1 text-th text-mudo text-center"
          >
            {mesNombre(m.mes)}
          </span>
        ))}
      </div>
    </div>
  );
}
