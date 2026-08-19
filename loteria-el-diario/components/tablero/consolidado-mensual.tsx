import { cn } from "@/lib/cn";
import { fmt, fmtK, mesNombre } from "@/lib/format";

export type MesConsolidado = {
  anio: number;
  mes: number;
  venta: number;
  comision: number;
  premios: number;
  utilidad: number;
  venta_pendiente: number;
};

/**
 * Un mosaico por mes con las cinco cifras que definen el negocio.
 *
 * El margen se calcula sobre la venta LIQUIDADA, no sobre la venta total: la
 * utilidad sólo existe para sorteos liquidados, y dividirla entre una venta que
 * incluye lo pendiente daría un margen artificialmente bajo el último mes de
 * cada rango. Cuando queda venta sin liquidar se dice, en vez de disimularlo.
 */
export function ConsolidadoMensual({ meses }: { meses: MesConsolidado[] }) {
  if (meses.length === 0) {
    return (
      <div className="border border-dashed border-borde-punteado rounded-pos py-[30px] px-[18px] text-center">
        <p className="text-base font-medium text-cuerpo m-0">Sin meses en el rango</p>
      </div>
    );
  }

  const total = meses.reduce(
    (a, m) => ({
      venta: a.venta + m.venta,
      comision: a.comision + m.comision,
      premios: a.premios + m.premios,
      utilidad: a.utilidad + m.utilidad,
      pendiente: a.pendiente + m.venta_pendiente,
    }),
    { venta: 0, comision: 0, premios: 0, utilidad: 0, pendiente: 0 },
  );

  const ventaLiquidada = total.venta - total.pendiente;
  const margenTotal = ventaLiquidada ? (total.utilidad / ventaLiquidada) * 100 : 0;

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Total del rango, con el mismo lenguaje del héroe del simulador. */}
      <div
        className="rounded-hero px-[22px] py-5 text-white"
        style={{ background: "var(--gradiente-dia)" }}
      >
        <span className="block text-th font-semibold tracking-seccion text-navy-etiqueta">
          TOTAL DEL RANGO · {meses.length} {meses.length === 1 ? "MES" : "MESES"}
        </span>

        <div className="grid gap-3 mt-4 [grid-template-columns:repeat(auto-fit,minmax(168px,1fr))]">
          {[
            { etiqueta: "Venta bruta", valor: fmtK(total.venta) },
            { etiqueta: "Comisiones", valor: fmtK(total.comision) },
            { etiqueta: "Premios", valor: fmtK(total.premios) },
            {
              etiqueta: "Utilidad neta",
              valor: fmtK(total.utilidad),
              color: total.utilidad >= 0 ? "var(--color-positivo-claro)" : "var(--color-negativo-claro)",
            },
            { etiqueta: "Margen", valor: `${margenTotal.toFixed(1)}%` },
          ].map((m) => (
            <div key={m.etiqueta} className="bg-white/[0.07] rounded-card px-[15px] py-3">
              <span className="block text-label text-navy-tenue">{m.etiqueta}</span>
              <span
                className="block text-h1 font-semibold tracking-titular mt-[3px]"
                style={m.color ? { color: m.color } : undefined}
              >
                {m.valor}
              </span>
            </div>
          ))}
        </div>

        {total.pendiente > 0 && (
          <p className="text-micro text-navy-tenue mt-3 mb-0">
            {fmtK(total.pendiente)} de venta todavía sin liquidar: no cuenta para la utilidad ni
            para el margen.
          </p>
        )}
      </div>

      {/* Un mosaico por mes. */}
      <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
        {meses.map((m) => {
          const liquidada = m.venta - m.venta_pendiente;
          const margen = liquidada ? (m.utilidad / liquidada) * 100 : 0;
          const perdida = m.utilidad < 0;

          return (
            <div
              key={`${m.anio}-${m.mes}`}
              className={cn(
                "bg-superficie border rounded-card shadow-card px-[18px] py-[15px]",
                perdida ? "border-negativo-borde" : "border-borde",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-h2 font-semibold tracking-sutil">
                  {mesNombre(m.mes)} {m.anio}
                </span>
                <span
                  className="text-meta font-semibold"
                  style={{
                    color: perdida ? "var(--color-negativo)" : "var(--color-positivo)",
                  }}
                >
                  {margen.toFixed(1)}% margen
                </span>
              </div>

              <div className="flex flex-col gap-[7px] mt-3">
                {[
                  { etiqueta: "Venta bruta", valor: fmt(m.venta) },
                  { etiqueta: "Comisiones", valor: `−${fmt(m.comision).replace("L ", "L ")}` },
                  { etiqueta: "Premios", valor: `−${fmt(m.premios).replace("L ", "L ")}` },
                ].map((f) => (
                  <div key={f.etiqueta} className="flex items-baseline justify-between gap-3">
                    <span className="text-meta text-secundario">{f.etiqueta}</span>
                    <span className="text-tabla">{f.valor}</span>
                  </div>
                ))}

                <div className="flex items-baseline justify-between gap-3 border-t border-riel pt-[9px] mt-[3px]">
                  <span className="text-meta font-medium">Utilidad neta</span>
                  <span
                    className="text-h1 font-semibold tracking-titular"
                    style={{
                      color: perdida ? "var(--color-negativo)" : "var(--color-positivo)",
                    }}
                  >
                    {fmt(m.utilidad)}
                  </span>
                </div>
              </div>

              {m.venta_pendiente > 0 && (
                <p className="text-label text-mudo mt-[10px] mb-0">
                  {fmt(m.venta_pendiente)} sin liquidar
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
