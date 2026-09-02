"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";

export type OpcionVendedorLiq = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  eliminado: boolean;
  /** Sorteos liquidados que todavía no se le han pagado. */
  pendientes: number;
};

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta";

/**
 * Filtros del módulo de liquidación.
 *
 * Van en la URL, como los de reportes: así el informe de una semana concreta se
 * puede compartir o volver a abrir, y el botón de atrás del navegador hace lo
 * que uno espera.
 */
/**
 * El selector de vendedor.
 *
 * Antes esto llevaba además atajos de semana y dos campos de fecha. El período
 * lo elige ahora el riel de la izquierda, que enseña de una vez qué semanas
 * hay y cuál tiene saldo: dos formas de elegir lo mismo son una de más, y la
 * que se quedó dice además dónde hay que mirar.
 *
 * La cuenta se cierra con un vendedor a la vez porque el pago es un gesto por
 * persona, no un total del padrón.
 */
export function FiltrosLiquidacion({
  vendedores,
  vendedorId,
  vista,
}: {
  vendedores: OpcionVendedorLiq[];
  vendedorId: string;
  vista: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (id: string) => {
    const p = new URLSearchParams({ vista });
    if (id) p.set("vendedor", id);
    iniciar(() => router.push(`/liquidacion?${p.toString()}`));
  };

  const conSaldo = vendedores.filter((v) => v.pendientes > 0).length;

  return (
    <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[14px] flex items-end gap-4 flex-wrap">
      <label className="block">
        <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
        <select
          value={vendedorId}
          onChange={(e) => ir(e.target.value)}
          className={cn(CLASE_CONTROL, "min-w-[280px]")}
        >
          <option value="">Elija un vendedor…</option>
          {vendedores.map((v) => (
            <option key={v.id} value={v.id}>
              {v.codigo} · {v.nombre}
              {v.eliminado ? " (eliminado)" : v.activo ? "" : " (inactivo)"}
              {v.pendientes > 0 ? ` — ${v.pendientes} sin pagar` : ""}
            </option>
          ))}
        </select>
      </label>

      {vendedorId && (
        <Boton variante="ghost" onClick={() => ir("")}>
          Cambiar de vendedor
        </Boton>
      )}

      <span className="text-meta text-secundario pb-[10px]">
        {conSaldo === 0
          ? "Nadie tiene sorteos sin pagar."
          : `${conSaldo} de ${vendedores.length} ${conSaldo === 1 ? "tiene" : "tienen"} sorteos sin pagar.`}
      </span>

      {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
    </div>
  );
}
