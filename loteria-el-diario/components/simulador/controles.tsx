"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Boton, BotonIcono } from "@/components/ui/boton";

export type Valores = { desde: string; hasta: string; comision: number; factor: number };

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie";

/**
 * Los parámetros del escenario viven en la URL, como el resto de filtros del
 * sistema: un escenario concreto se puede compartir por enlace.
 *
 * El valor tecleado se guarda aparte del numérico mientras se escribe, para que
 * un «1» a medio teclear de «13» no se convierta en un escenario del 1 %.
 */
export function ControlesSimulador({
  valores,
  reales,
}: {
  valores: Valores;
  reales: { comision: number; factor: number };
}) {
  const router = useRouter();
  const [navegando, iniciar] = useTransition();
  const [comisionTxt, setComisionTxt] = useState(String(valores.comision));
  const [factorTxt, setFactorTxt] = useState(String(valores.factor));

  useEffect(() => {
    setComisionTxt(String(valores.comision));
    setFactorTxt(String(valores.factor));
  }, [valores.comision, valores.factor]);

  const aplicar = (cambios: Partial<Valores>) => {
    const v = { ...valores, ...cambios };
    const p = new URLSearchParams({
      desde: v.desde,
      hasta: v.hasta,
      comision: String(v.comision),
      factor: String(v.factor),
    });
    iniciar(() => router.push(`/simulador?${p.toString()}`));
  };

  const limpiar = (texto: string, largo: number) => {
    const s = texto.replace(/[^\d.]/g, "").slice(0, largo);
    const p = s.split(".");
    return p.length > 2 ? `${p[0]}.${p.slice(1).join("")}` : s;
  };

  const acotar = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
      <div className="flex gap-[22px] flex-wrap items-end">
        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Desde</span>
          <input
            type="date"
            value={valores.desde}
            onChange={(e) => e.target.value && aplicar({ desde: e.target.value })}
            className={CLASE_CONTROL}
          />
        </label>

        <label className="block">
          <span className="block text-label text-secundario font-medium mb-[6px]">Hasta</span>
          <input
            type="date"
            value={valores.hasta}
            onChange={(e) => e.target.value && aplicar({ hasta: e.target.value })}
            className={CLASE_CONTROL}
          />
        </label>

        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">
            Comisión (%)
          </span>
          <div className="flex items-center gap-2">
            <BotonIcono
              acento
              onClick={() => aplicar({ comision: acotar(valores.comision - 0.5, 0, 60) })}
              aria-label="Bajar la comisión medio punto"
            >
              −
            </BotonIcono>
            <input
              value={comisionTxt}
              onChange={(e) => setComisionTxt(limpiar(e.target.value, 6))}
              onBlur={() => {
                const n = parseFloat(comisionTxt);
                aplicar({ comision: Number.isNaN(n) ? valores.comision : acotar(n, 0, 60) });
              }}
              inputMode="decimal"
              className="w-[92px] text-center text-pos-xl font-semibold px-2 py-[6px] border border-borde-campo rounded-campo outline-none bg-superficie"
            />
            <BotonIcono
              acento
              onClick={() => aplicar({ comision: acotar(valores.comision + 0.5, 0, 60) })}
              aria-label="Subir la comisión medio punto"
            >
              +
            </BotonIcono>
          </div>
        </div>

        <div>
          <span className="block text-label text-secundario font-medium mb-[6px]">
            Factor de pago
          </span>
          <div className="flex items-center gap-2">
            <BotonIcono
              acento
              onClick={() => aplicar({ factor: acotar(valores.factor - 1, 1, 200) })}
              aria-label="Bajar el factor un punto"
            >
              −
            </BotonIcono>
            <input
              value={factorTxt}
              onChange={(e) => setFactorTxt(limpiar(e.target.value, 6))}
              onBlur={() => {
                const n = parseFloat(factorTxt);
                aplicar({ factor: Number.isNaN(n) ? valores.factor : acotar(n, 1, 200) });
              }}
              inputMode="decimal"
              className="w-[92px] text-center text-pos-xl font-semibold px-2 py-[6px] border border-borde-campo rounded-campo outline-none bg-superficie"
            />
            <BotonIcono
              acento
              onClick={() => aplicar({ factor: acotar(valores.factor + 1, 1, 200) })}
              aria-label="Subir el factor un punto"
            >
              +
            </BotonIcono>
          </div>
        </div>

        <p className="text-micro text-secundario leading-[1.5] max-w-[230px] mb-0">
          Real ponderado del rango: {reales.comision.toFixed(2)} % de comisión y factor{" "}
          {reales.factor.toFixed(2)}. Ponderado por venta, no promedio simple.
        </p>

        <Boton
          variante="ghost"
          onClick={() => aplicar({ comision: reales.comision, factor: reales.factor })}
          disabled={navegando}
          className="ml-auto"
        >
          {navegando ? "Calculando…" : "Restablecer"}
        </Boton>
      </div>
    </div>
  );
}
