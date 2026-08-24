"use client";

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, pad2 } from "@/lib/format";

export type FilaPeriodo = {
  fecha: string;
  hora: string;
  estado: "programado" | "abierto" | "cerrado" | "liquidado";
  ganador: number | null;
  venta: number;
  comision: number;
  premios: number;
  pagado: boolean;
};

/**
 * El reporte del vendedor: un bloque por día, una fila por lotería.
 *
 * EL TOTAL ES COMISIÓN MÁS PREMIOS, no la venta. El vendedor cobra la venta en
 * la calle y paga los premios de su bolsillo, así que su dinero es la comisión
 * que le corresponde más lo que adelantó en premios. La venta bruta se muestra
 * porque es la referencia del movimiento, pero no es lo suyo.
 *
 * Es la otra cara del módulo de liquidación del administrador, que enseña el
 * SALDO (venta − comisión − premios, lo que el vendedor entrega). Mismas
 * cuentas, dos direcciones, y cada pantalla lo dice con todas sus letras para
 * que nadie sume dos cifras que no se suman.
 *
 * UN BLOQUE POR DÍA Y NO UNA TABLA CORRIDA: en un teléfono, doce filas
 * seguidas de números sin nada que las separe no se leen. El día es la unidad
 * con la que se piensa la cuenta, así que es la unidad que se dibuja.
 */
export function HojaPeriodo({ filas }: { filas: FilaPeriodo[] }) {
  const porDia = useMemo(() => {
    const mapa = new Map<string, FilaPeriodo[]>();
    for (const f of filas) {
      const lista = mapa.get(f.fecha) ?? [];
      lista.push(f);
      mapa.set(f.fecha, lista);
    }
    return [...mapa.entries()];
  }, [filas]);

  const total = (fs: FilaPeriodo[]) =>
    fs.reduce(
      (a, f) => ({
        venta: a.venta + f.venta,
        comision: a.comision + f.comision,
        premios: a.premios + f.premios,
      }),
      { venta: 0, comision: 0, premios: 0 },
    );

  const periodo = total(filas);

  if (filas.length === 0) {
    return (
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-8 text-center">
        <p className="text-base text-cuerpo m-0">No hay sorteos en este rango.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --- Total del período, arriba: es lo primero que se busca --- */}
      <div
        className="rounded-card px-[22px] py-5 text-nav-titulo"
        style={{ background: "var(--gradiente-dia)" }}
      >
        <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
          TOTAL DEL PERÍODO
        </span>
        <span className="block text-tile font-semibold tracking-titular mt-1">
          {fmt(periodo.comision + periodo.premios)}
        </span>
        <span className="block text-meta text-navy-pie mt-2">
          comisión {fmt(periodo.comision, false)} · premios que pagó{" "}
          {fmt(periodo.premios, false)}
        </span>
        <span className="block text-label text-navy-nota mt-3 leading-[1.5]">
          Venta del período {fmt(periodo.venta)}. La venta no es suyo: es lo que movió.
        </span>
      </div>

      {/* --- Un bloque por día --- */}
      {porDia.map(([fecha, delDia]) => {
        const t = total(delDia);
        const suyo = t.comision + t.premios;
        const todoPagado = delDia.every((f) => f.pagado);
        const algoPagado = delDia.some((f) => f.pagado);

        return (
          <div
            key={fecha}
            className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-riel flex items-center justify-between gap-3 flex-wrap">
              <span className="text-h2 font-semibold tracking-sutil">{fechaLarga(fecha)}</span>
              {todoPagado ? (
                <span className="px-[9px] py-[2px] rounded-chip text-th font-semibold bg-positivo-fondo text-positivo-texto">
                  PAGADO
                </span>
              ) : algoPagado ? (
                <span className="px-[9px] py-[2px] rounded-chip text-th font-semibold bg-ambar-fondo text-ambar-texto">
                  PAGADO EN PARTE
                </span>
              ) : (
                <span className="px-[9px] py-[2px] rounded-chip text-th font-semibold bg-chip text-cuerpo">
                  PENDIENTE
                </span>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[520px]">
                <thead>
                  <tr className="bg-tinte">
                    {["LOTERÍA", "GANADOR", "VENTA", "COMISIÓN", "PREMIOS", "TOTAL"].map(
                      (th, i) => (
                        <th
                          key={th}
                          className={cn(
                            "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                            i >= 2 ? "text-right" : "text-left",
                            i === 0 ? "pl-4 pr-3" : i === 5 ? "pl-3 pr-4" : "px-3",
                          )}
                        >
                          {th}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {delDia.map((f) => (
                    <tr key={f.hora}>
                      <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                        <span className="block font-medium">{hora12(f.hora)}</span>
                        <span className="block text-label text-secundario">
                          {f.estado === "liquidado"
                            ? f.pagado
                              ? "pagado"
                              : "por cobrar"
                            : f.estado === "abierto"
                              ? "en venta"
                              : f.estado === "cerrado"
                                ? "cerrado · sin número"
                                : "sin abrir"}
                        </span>
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3">
                        {f.ganador === null ? (
                          <span className="text-mudo">—</span>
                        ) : (
                          <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
                            {pad2(f.ganador)}
                          </span>
                        )}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.venta, false)}
                      </td>
                      {/* La comisión SÍ es firme desde la venta: la tasa se
                          congela en cada línea. Los premios no existen hasta
                          que se captura el número, y ahí va un guion en vez de
                          un cero — un cero se lee como «no ganó nadie». */}
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.comision, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {f.estado === "liquidado" ? (
                          fmt(f.premios, false)
                        ) : (
                          <span className="text-mudo">—</span>
                        )}
                      </td>
                      <td className="border-b border-fondo py-[11px] pl-3 pr-4 text-right font-semibold">
                        {fmt(f.comision + f.premios, false)}
                      </td>
                    </tr>
                  ))}

                  <tr className="bg-tinte">
                    <td
                      colSpan={2}
                      className="py-[10px] pl-4 pr-3 text-eyebrow font-semibold tracking-seccion text-secundario"
                    >
                      SUBTOTAL DEL DÍA
                    </td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.venta, false)}
                    </td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.comision, false)}
                    </td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.premios, false)}
                    </td>
                    <td className="py-[10px] pl-3 pr-4 text-right text-h2 font-semibold tracking-sutil">
                      {fmt(suyo, false)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <p className="text-meta text-secundario leading-[1.55] m-0 bg-panel border border-borde rounded-card px-4 py-3">
        El <strong>total</strong> es su comisión más los premios que pagó de su bolsillo: es
        lo que la casa le devuelve. La venta es el movimiento del día, no su dinero. La
        comisión cuenta desde que vende —la tasa se congela en cada línea—, pero los premios
        de un sorteo sin número ganador todavía no existen: por eso aparecen con un guion y
        el total de esa fila puede subir cuando se capture el resultado.
      </p>
    </div>
  );
}
