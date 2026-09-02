"use client";

import { useMemo } from "react";

import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, jornada, pad2 } from "@/lib/format";

export type FilaPeriodo = {
  fecha: string;
  hora: string;
  estado: "programado" | "abierto" | "cerrado" | "liquidado";
  ganador: number | null;
  venta: number;
  /** Lo APOSTADO al número que salió. */
  premiado: number;
  comision: number;
  /** Lo que costó pagar ese número. */
  premios: number;
  pagado: boolean;
};

const ENCABEZADOS = [
  "LOTERÍA",
  "GANADOR",
  "VENTA",
  "PREMIADO",
  "F. PREM",
  "%",
  "PAGO PREMIADO",
  "COMISIÓN",
  "TOTAL BRUTO",
  // El gerente llama a esta casilla «total neto». Es el mismo número y el mismo
  // signo; lo que cambia es de qué lado del mostrador se lee, y aquí el lector
  // es el vendedor. La nota del pie lo dice para que puedan cuadrar por
  // teléfono sin discutir el nombre.
  "LE CORRESPONDE",
];

/** El factor efectivo del sorteo: lo pagado dividido entre lo apostado. */
function factor(f: FilaPeriodo): string {
  return f.premiado > 0 ? (f.premios / f.premiado).toFixed(0) : "—";
}

function porcentaje(f: FilaPeriodo): string {
  return f.venta > 0 ? `${((f.comision / f.venta) * 100).toFixed(2)}%` : "—";
}

function rotuloEstado(f: FilaPeriodo): string {
  if (f.estado === "liquidado") return f.pagado ? "pagado" : "por cobrar";
  if (f.estado === "abierto") return "en venta";
  if (f.estado === "cerrado") return "cerrado · sin número";
  return "sin abrir";
}

function Ganador({ n }: { n: number | null }) {
  if (n === null) return <span className="text-mudo">—</span>;
  return (
    <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
      {pad2(n)}
    </span>
  );
}

/** Un par etiqueta–valor de la tarjeta del teléfono. */
function Dato({ etiqueta, valor, clase }: { etiqueta: string; valor: string; clase?: string }) {
  return (
    <span className="flex items-baseline justify-between gap-2">
      <span className="text-th text-secundario">{etiqueta}</span>
      <span className={cn("text-tabla text-cuerpo", clase)}>{valor}</span>
    </span>
  );
}

/**
 * El reporte del vendedor: un bloque por día, una línea por sorteo.
 *
 * Las columnas son las de la hoja del gerente —venta, lo apostado al número
 * que salió, el factor, el porcentaje, lo que costó pagarlo, la comisión, el
 * bruto y el neto— pero con SUS filas y nada más. Así, cuando administración y
 * vendedor cuadran por teléfono, los dos están mirando las mismas casillas con
 * los mismos nombres, que es la mitad de las discusiones.
 *
 * «LE CORRESPONDE» ES EL SALDO DE LA LIQUIDACIÓN: venta − comisión − premios.
 * Es la misma fórmula que usa el módulo de liquidación para cobrar, y a
 * propósito: la cifra que el vendedor mira en su teléfono tiene que ser
 * exactamente la que administración le va a decir por teléfono. Si aquí
 * saliera otra cuenta —por buena que fuera— cada cierre empezaría discutiendo
 * cuál de las dos vale.
 *
 * EL SIGNO DICE QUIÉN DEBE. Positivo, el vendedor le debe a la empresa y va en
 * número normal; negativo, la empresa le debe a él y va en rojo. Un solo
 * criterio en todo el sistema, que es lo que permite leer una pantalla sin
 * preguntar en qué dirección está escrita.
 *
 * DOS DIBUJOS, UNO POR TAMAÑO. En un teléfono once columnas no se leen ni
 * arrastrando: debajo de `lg` cada sorteo es una tarjeta. Los dos se
 * renderizan siempre y se ocultan con CSS —nada de medir el viewport— para
 * que no haya desajuste de hidratación ni parpadeo.
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

  const sumar = (fs: FilaPeriodo[]) =>
    fs.reduce(
      (a, f) => ({
        venta: a.venta + f.venta,
        premiado: a.premiado + f.premiado,
        comision: a.comision + f.comision,
        premios: a.premios + f.premios,
      }),
      { venta: 0, premiado: 0, comision: 0, premios: 0 },
    );

  const periodo = sumar(filas);
  const suyoPeriodo = periodo.venta - periodo.comision - periodo.premios;

  if (filas.length === 0) {
    return (
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-8 text-center">
        <p className="text-base text-cuerpo m-0">No hay sorteos en este rango.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --- Las cifras del período, arriba: es lo primero que se busca --- */}
      <div
        className="rounded-card px-[18px] py-[18px] text-nav-titulo"
        style={{ background: "var(--gradiente-dia)" }}
      >
        <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
          {suyoPeriodo < 0 ? "LA EMPRESA LE DEBE" : "LE CORRESPONDE ENTREGAR"}
        </span>
        {/*
          Sobre el marino el rojo del sistema no llega al contraste mínimo, así
          que aquí va el rojo claro que ya se usa para las cifras negativas
          sobre fondo oscuro. El criterio es el mismo; cambia el tono, no la
          regla.
        */}
        <span
          className={cn(
            "block text-rapida font-semibold tracking-titular mt-1",
            suyoPeriodo < 0 && "text-negativo-claro",
          )}
        >
          {fmt(suyoPeriodo)}
        </span>

        <div className="grid gap-3 mt-4 [grid-template-columns:repeat(auto-fit,minmax(128px,1fr))]">
          {[
            { etiqueta: "VENTA", valor: periodo.venta },
            { etiqueta: "COMISIÓN", valor: periodo.comision },
            { etiqueta: "PREMIOS QUE PAGÓ", valor: periodo.premios },
          ].map((k) => (
            <div key={k.etiqueta}>
              <span className="block text-th font-semibold tracking-seccion text-navy-tenue">
                {k.etiqueta}
              </span>
              <span className="block text-pos-lg font-semibold tracking-sutil mt-[3px]">
                {fmt(k.valor, false)}
              </span>
            </div>
          ))}
        </div>

        <span className="block text-label text-navy-nota mt-3 leading-[1.5]">
          {suyoPeriodo < 0
            ? "Venta menos comisión menos premios. Sale negativo, así que en este período los premios que adelantó superaron su venta y la empresa le debe esa diferencia."
            : "Venta menos comisión menos premios. Sale positivo, así que ése es el dinero que usted le entrega a la empresa al liquidar."}
        </span>
      </div>

      {/* --- Un bloque por día --- */}
      {porDia.map(([fecha, delDia]) => {
        const t = sumar(delDia);
        const suyo = t.venta - t.comision - t.premios;
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

            {/* ---------------- Teléfono: una tarjeta por sorteo ---------------- */}
            <div className="lg:hidden flex flex-col">
              {delDia.map((f) => (
                <div key={f.hora} className="px-4 py-[13px] border-b border-fondo">
                  <div className="flex items-center justify-between gap-3">
                    <span className="block">
                      <span className="block text-cta font-semibold tracking-sutil">
                        {jornada(f.hora)}
                        <span className="text-secundario font-medium"> · {hora12(f.hora)}</span>
                      </span>
                      <span className="block text-th text-mudo mt-[1px]">{rotuloEstado(f)}</span>
                    </span>
                    <Ganador n={f.ganador} />
                  </div>

                  <div className="grid gap-x-4 gap-y-[5px] mt-[10px] [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                    <Dato etiqueta="Venta" valor={fmt(f.venta, false)} />
                    <Dato etiqueta="Premiado" valor={fmt(f.premiado, false)} />
                    <Dato etiqueta="Factor" valor={factor(f)} />
                    <Dato etiqueta="%" valor={porcentaje(f)} />
                    <Dato etiqueta="Comisión" valor={fmt(f.comision, false)} />
                    {/* Los premios de un sorteo sin número ganador todavía no
                        existen: un guion, no un cero — un cero se lee como
                        «no ganó nadie». */}
                    <Dato
                      etiqueta="Pago premiado"
                      valor={f.estado === "liquidado" ? fmt(f.premios, false) : "—"}
                    />
                    <Dato etiqueta="Total bruto" valor={fmt(f.venta - f.comision, false)} />
                  </div>

                  <div className="flex items-baseline justify-between gap-2 mt-[9px] pt-[9px] border-t border-riel">
                    <span className="text-meta font-medium">Le corresponde</span>
                    <span
                      className={cn(
                        "text-pos font-semibold tracking-sutil",
                        f.venta - f.comision - f.premios < 0 && "text-negativo",
                      )}
                    >
                      {fmt(f.venta - f.comision - f.premios, false)}
                    </span>
                  </div>
                </div>
              ))}

              <div className="px-4 py-[13px] bg-tinte flex items-baseline justify-between gap-2">
                <span className="text-eyebrow font-semibold tracking-seccion text-secundario">
                  SUBTOTAL DEL DÍA
                </span>
                <span className="text-h1 font-semibold tracking-titular">{fmt(suyo, false)}</span>
              </div>
            </div>

            {/* ---------------- Escritorio: la tabla del gerente ---------------- */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[940px]">
                <thead>
                  <tr className="bg-tinte">
                    {ENCABEZADOS.map((th, i) => (
                      <th
                        key={th}
                        className={cn(
                          "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                          i >= 2 ? "text-right" : "text-left",
                          i === 0
                            ? "pl-4 pr-3"
                            : i === ENCABEZADOS.length - 1
                              ? "pl-3 pr-4"
                              : "px-3",
                          // La última columna es la del vendedor y no la del
                          // gerente: el filete avisa de que se cambia de lado.
                          i === ENCABEZADOS.length - 1 && "border-l border-riel",
                        )}
                      >
                        {th}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {delDia.map((f) => (
                    <tr key={f.hora}>
                      <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                        <span className="block font-medium">{hora12(f.hora)}</span>
                        <span className="block text-label text-secundario">{rotuloEstado(f)}</span>
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3">
                        <Ganador n={f.ganador} />
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right font-medium">
                        {fmt(f.venta, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.premiado, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-secundario">
                        {factor(f)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-secundario">
                        {porcentaje(f)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {f.estado === "liquidado" ? (
                          fmt(f.premios, false)
                        ) : (
                          <span className="text-mudo">—</span>
                        )}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.comision, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.venta - f.comision, false)}
                      </td>
                      <td
                        className={cn(
                          "border-b border-fondo border-l border-riel py-[11px] pl-3 pr-4 text-right font-semibold",
                          f.venta - f.comision - f.premios < 0 && "text-negativo",
                        )}
                      >
                        {fmt(f.venta - f.comision - f.premios, false)}
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
                    <td className="py-[10px] px-3 text-right text-cuerpo">{fmt(t.venta, false)}</td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.premiado, false)}
                    </td>
                    <td />
                    <td />
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.premios, false)}
                    </td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.comision, false)}
                    </td>
                    <td className="py-[10px] px-3 text-right text-cuerpo">
                      {fmt(t.venta - t.comision, false)}
                    </td>
                    <td
                      className={cn(
                        "py-[10px] pl-3 pr-4 border-l border-riel text-right text-h2 font-semibold tracking-sutil",
                        suyo < 0 && "text-negativo",
                      )}
                    >
                      {fmt(suyo, false)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="bg-panel border border-borde rounded-card px-4 py-3 text-meta text-cuerpo leading-[1.55]">
        <p className="m-0">
          <strong>Le corresponde</strong> es <strong>venta − comisión − premios</strong>, la misma
          cuenta con la que se liquida. En <strong>negativo y en rojo</strong>, la empresa le debe
          a usted: los premios que adelantó superaron su venta. En número normal, usted le entrega
          esa cantidad a la empresa. Es la casilla que en la hoja de gerencia se llama{" "}
          <strong>total neto</strong> —el mismo número y el mismo signo—, así que al cuadrar por
          teléfono los dos están mirando lo mismo.
        </p>
        <p className="mt-2 mb-0">
          <strong>Premiado</strong> es lo que se apostó al número que salió y{" "}
          <strong>pago premiado</strong> lo que costó pagarlo; el <strong>factor</strong> es lo
          segundo entre lo primero. La comisión cuenta desde que vende —la tasa se congela en cada
          línea—, pero los premios de un sorteo sin número ganador todavía no existen: por eso van
          con un guion, y lo que le corresponde en esa fila puede cambiar —incluso de signo— cuando
          se capture el resultado.
        </p>
      </div>
    </div>
  );
}
