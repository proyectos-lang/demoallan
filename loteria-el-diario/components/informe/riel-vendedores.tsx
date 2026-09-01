"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { cn } from "@/lib/cn";

export type VendedorDelRiel = {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
};

/**
 * El riel de vendedores del análisis.
 *
 * Misma forma que el riel de semanas —lista entera, no desplegable— por la
 * misma razón: se compara saltando de uno a otro. Con treinta caben todos;
 * el buscador está para cuando sean ciento doce, que es el padrón que maneja
 * la gerencia en su hoja.
 *
 * El filtro es local, sin ir al servidor: el padrón ya está en la página y
 * teclear no debería costar un viaje.
 */
export function RielVendedores({
  vendedores,
  activo,
}: {
  vendedores: VendedorDelRiel[];
  activo: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [busca, setBusca] = useState("");

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return vendedores;
    return vendedores.filter(
      (v) => v.nombre.toLowerCase().includes(q) || v.codigo.toLowerCase().includes(q),
    );
  }, [busca, vendedores]);

  return (
    <div className="w-[204px] flex-none bg-superficie border border-borde rounded-card shadow-card overflow-hidden self-start">
      <div className="px-[10px] py-[10px] border-b border-riel bg-tinte">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar vendedor…"
          aria-label="Buscar vendedor"
          className="w-full px-[10px] py-[7px] border border-borde-campo rounded-campo text-meta outline-none bg-superficie text-tinta"
        />
      </div>

      <div className="max-h-[560px] overflow-y-auto">
        {filtrados.map((v) => {
          const abierto = v.id === activo;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() =>
                iniciar(() => router.push(`/informe?vista=vendedor&vendedor=${v.id}`))
              }
              aria-current={abierto ? "true" : undefined}
              className={cn(
                "w-full text-left px-[14px] py-[9px] border-b border-fondo cursor-pointer flex items-baseline gap-2",
                abierto ? "bg-acento-suave" : "hover:bg-tinte",
              )}
            >
              <span
                className={cn(
                  "text-th font-semibold flex-none",
                  abierto ? "text-acento-fuerte" : "text-mudo",
                )}
              >
                {v.codigo}
              </span>
              <span
                className={cn(
                  "text-tabla truncate",
                  abierto ? "text-acento-fuerte font-semibold" : "text-cuerpo",
                )}
              >
                {v.nombre}
              </span>
              {/* Un vendedor dado de baja sigue teniendo historia que mirar,
                  así que aparece; pero se dice que está de baja. */}
              {!v.activo && <span className="text-th text-mudo flex-none ml-auto">baja</span>}
            </button>
          );
        })}

        {filtrados.length === 0 && (
          <span className="block px-[14px] py-4 text-meta text-mudo">
            Ningún vendedor con «{busca}».
          </span>
        )}
      </div>

      {pendiente && (
        <span className="block px-[14px] py-2 text-th text-secundario border-t border-riel">
          Cargando…
        </span>
      )}
    </div>
  );
}
