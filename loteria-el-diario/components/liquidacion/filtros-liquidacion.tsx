"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { BuscadorVendedor } from "@/components/ui/buscador-vendedor";
import { cn } from "@/lib/cn";

export type OpcionVendedorLiq = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  eliminado: boolean;
  /** Sorteos liquidados que todavía no se le han cerrado. */
  pendientes: number;
  /** Nombre comercial: es por lo que se le busca. */
  alias?: string | null;
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
 * La cuenta se cierra con un vendedor a la vez porque liquidar es un gesto por
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
      {/*
        Buscador y no desplegable: aquí se cierra un pago con una persona
        concreta, y encontrarla entre sesenta ordenadas por código era recorrer
        la lista con la vista.

        `permitirTodos` va en falso: este módulo trabaja SOBRE un vendedor, no
        sobre el padrón. «Todos» no significaría nada.
      */}
      <BuscadorVendedor
        className="w-full sm:w-auto sm:min-w-[300px]"
        vendedores={vendedores.map((v) => ({
          id: v.id,
          codigo: v.codigo,
          nombre: v.nombre,
          alias: v.alias,
          apagado: v.eliminado ? "(eliminado)" : v.activo ? undefined : "(inactivo)",
          detalle: v.pendientes > 0 ? `${v.pendientes} sin liquidar` : undefined,
        }))}
        valor={vendedorId}
        onElegir={ir}
        permitirTodos={false}
        placeholder="Escriba el alias, el nombre o el código"
        textoTodos="Elija un vendedor…"
      />

      {vendedorId && (
        <Boton variante="ghost" onClick={() => ir("")}>
          Cambiar de vendedor
        </Boton>
      )}

      <span className="text-meta text-secundario pb-[10px]">
        {conSaldo === 0
          ? "Nadie tiene sorteos sin liquidar."
          : `${conSaldo} de ${vendedores.length} ${conSaldo === 1 ? "tiene" : "tienen"} sorteos sin liquidar.`}
      </span>

      {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
    </div>
  );
}
