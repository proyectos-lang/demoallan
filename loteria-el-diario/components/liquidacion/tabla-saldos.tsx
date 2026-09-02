"use client";

import { Printer } from "lucide-react";
import { useRef, useState } from "react";

import { Boton } from "@/components/ui/boton";
import {
  documentoSaldos,
  type HojaSaldos,
  type Orientacion,
} from "@/components/liquidacion/imprimible-saldos";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/format";

export type FilaSaldoVendedor = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  anterior: number;
  venta: number;
  semana: number;
  liquidado: number;
  pendiente: number;
  actual: number;
};

/**
 * El cuadro de saldos del padrón para una semana.
 *
 * Tres cifras por vendedor: lo que traía de antes, lo que dejó esta semana y
 * lo que debe hoy. Es la lista con la que se sale a cobrar, así que se imprime.
 *
 * SE OCULTAN LOS QUE ESTÁN A CERO, con un interruptor para verlos. Un vendedor
 * sin movimiento y sin saldo no es noticia y sólo alarga la hoja; uno sin
 * movimiento PERO con saldo arrastrado es justo a quien hay que ir a buscar, y
 * ése nunca se oculta porque su saldo actual no es cero.
 */
export function TablaSaldos({
  filas,
  semana,
  desde,
  hasta,
}: {
  filas: FilaSaldoVendedor[];
  semana: number | null;
  desde: string;
  hasta: string;
}) {
  const [verTodos, setVerTodos] = useState(false);
  const marco = useRef<HTMLIFrameElement | null>(null);

  const enCero = filas.filter((f) => f.actual === 0 && f.venta === 0).length;
  const visibles = verTodos ? filas : filas.filter((f) => f.actual !== 0 || f.venta !== 0);

  const total = visibles.reduce(
    (a, f) => ({
      anterior: a.anterior + f.anterior,
      semana: a.semana + f.semana,
      liquidado: a.liquidado + f.liquidado,
      actual: a.actual + f.actual,
    }),
    { anterior: 0, semana: 0, liquidado: 0, actual: 0 },
  );

  // Se cobra a unos y se paga a otros: el neto de la última columna esconde
  // las dos, así que van también por separado.
  const porCobrar = visibles.reduce((a, f) => a + Math.max(f.actual, 0), 0);
  const porPagar = visibles.reduce((a, f) => a + Math.min(f.actual, 0), 0);

  const imprimir = (orientacion: Orientacion) => {
    if (!marco.current) {
      const i = document.createElement("iframe");
      // `data-impresion` para que la regla de impresión de la aplicación no lo
      // apague, y fuera de la vista sin `display:none`: un marco sin caja no
      // siempre se puede imprimir. Igual que en la hoja de liquidación.
      i.setAttribute("data-impresion", "");
      i.setAttribute("aria-hidden", "true");
      i.title = "Saldos por vendedor para imprimir";
      i.style.cssText =
        "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(i);
      marco.current = i;
    }
    const i = marco.current;
    i.onload = () => {
      i.contentWindow?.focus();
      i.contentWindow?.print();
    };
    const hoja: HojaSaldos = {
      semana,
      desde,
      hasta,
      orientacion,
      // Se imprime lo que se ve: si el interruptor oculta a los de cero, la
      // hoja tampoco los lleva.
      filas: visibles.map((f) => ({
        codigo: f.codigo,
        nombre: f.nombre,
        anterior: f.anterior,
        semana: f.semana,
        liquidado: f.liquidado,
        actual: f.actual,
      })),
    };
    i.srcdoc = documentoSaldos(hoja);
  };

  const celda = "px-3 py-[8px] border-b border-fondo text-right";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        <Kpi etiqueta="SALDO ANTERIOR" valor={total.anterior} pie="viene de semanas previas" />
        <Kpi etiqueta="SALDO DE LA SEMANA" valor={total.semana} pie="lo que dejaron estos días" />
        <Kpi etiqueta="POR COBRAR" valor={porCobrar} pie="lo entregan los vendedores" />
        <Kpi etiqueta="POR PAGAR" valor={Math.abs(porPagar)} pie="lo entrega la empresa" rojo />
      </div>

      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        <div className="px-[18px] py-[12px] border-b border-riel flex items-center gap-3 flex-wrap">
          <span className="text-meta text-secundario">
            {visibles.length} de {filas.length} vendedores
          </span>
          {enCero > 0 && (
            <button
              type="button"
              onClick={() => setVerTodos((v) => !v)}
              className="text-meta text-acento font-medium"
            >
              {verTodos ? `ocultar los ${enCero} en cero` : `ver los ${enCero} en cero`}
            </button>
          )}
          {/*
            Dos botones y no un desplegable: elegir orientación debe costar un
            solo toque. Con el padón actual el vertical cabe en una hoja y el
            horizontal se parte en dos —un A4 apaisado gana ancho pero pierde
            alto—, así que el vertical va primero.
          */}
          <span className="ml-auto flex items-center gap-2">
            <Boton variante="ghost" onClick={() => imprimir("vertical")}>
              <Printer size={15} strokeWidth={2} absoluteStrokeWidth />
              Vertical
            </Boton>
            <Boton variante="ghost" onClick={() => imprimir("horizontal")}>
              <Printer size={15} strokeWidth={2} absoluteStrokeWidth />
              Horizontal
            </Boton>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-tabla min-w-[820px]">
            <thead>
              <tr className="bg-tinte">
                {[
                  "CÓD.",
                  "VENDEDOR",
                  "SALDO ANTERIOR",
                  "SALDO DE LA SEMANA",
                  "LIQUIDADO",
                  "SALDO ACTUAL",
                ].map((th, i) => (
                  <th
                    key={th}
                    className={cn(
                      "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                      i <= 1 ? "text-left" : "text-right",
                      i === 0 ? "pl-4 pr-3" : i === 5 ? "pl-3 pr-4" : "px-3",
                      th === "SALDO ACTUAL" && "border-l border-riel",
                    )}
                  >
                    {th}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {visibles.map((f) => (
                <tr key={f.id} className={cn("hover:bg-tinte", f.actual === 0 && "text-mudo")}>
                  <td className="pl-4 pr-3 py-[8px] border-b border-fondo text-secundario">
                    {f.codigo}
                  </td>
                  <td className="px-3 py-[8px] border-b border-fondo font-medium">
                    {f.nombre}
                    {!f.activo && <span className="text-th text-mudo ml-2">de baja</span>}
                  </td>
                  <td className={cn(celda, f.anterior < 0 && "text-negativo")}>
                    {f.anterior === 0 ? "—" : fmt(f.anterior, false)}
                  </td>
                  <td className={cn(celda, f.semana < 0 && "text-negativo")}>
                    {f.venta === 0 && f.semana === 0 ? "—" : fmt(f.semana, false)}
                  </td>
                  <td className={cn(celda, "text-cuerpo")}>
                    {f.liquidado === 0 ? "—" : fmt(f.liquidado, false)}
                  </td>
                  <td
                    className={cn(
                      "pl-3 pr-4 py-[8px] border-b border-fondo border-l border-riel text-right font-semibold",
                      f.actual < 0 && "text-negativo",
                    )}
                  >
                    {fmt(f.actual, false)}
                  </td>
                </tr>
              ))}
            </tbody>

            <tfoot>
              <tr className="bg-tinte">
                <td
                  colSpan={2}
                  className="pl-4 pr-3 py-[10px] text-th font-semibold tracking-subtotal text-secundario"
                >
                  TOTALES
                </td>
                <td
                  className={cn(
                    "px-3 py-[10px] text-right text-h2 font-semibold",
                    total.anterior < 0 && "text-negativo",
                  )}
                >
                  {fmt(total.anterior, false)}
                </td>
                <td
                  className={cn(
                    "px-3 py-[10px] text-right text-h2 font-semibold",
                    total.semana < 0 && "text-negativo",
                  )}
                >
                  {fmt(total.semana, false)}
                </td>
                <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                  {fmt(total.liquidado, false)}
                </td>
                <td
                  className={cn(
                    "pl-3 pr-4 py-[10px] border-l border-riel text-right text-h2 font-semibold",
                    total.actual < 0 && "text-negativo",
                  )}
                >
                  {fmt(total.actual, false)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function Kpi({
  etiqueta,
  valor,
  pie,
  rojo,
}: {
  etiqueta: string;
  valor: number;
  pie: string;
  rojo?: boolean;
}) {
  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-4 py-[14px]">
      <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
        {etiqueta}
      </span>
      <span
        className={cn(
          "block text-kpi font-semibold tracking-titular mt-[6px]",
          (rojo || valor < 0) && valor !== 0 && "text-negativo",
        )}
      >
        {fmt(valor)}
      </span>
      <span className="block text-label text-mudo mt-[2px]">{pie}</span>
    </div>
  );
}
