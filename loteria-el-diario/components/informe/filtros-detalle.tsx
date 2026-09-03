"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";
import { hora12 } from "@/lib/format";

export type VendedorFiltro = {
  id: string;
  codigo: string;
  nombre: string;
  /** Cuántos tickets tiene ese día, para no ofrecer a quien no vendió. */
  tickets: number;
};

const HORAS = ["11:00", "15:00", "20:00"];

/**
 * Los filtros del detalle de venta: un día, un sorteo y varios vendedores.
 *
 * LA SELECCIÓN ES MÚLTIPLE porque la pregunta que trae aquí a alguien es
 * comparativa: «enséñame el día de estos tres». Con un solo vendedor a la vez
 * habría que abrir la pantalla una vez por cada uno y cotejar de memoria.
 *
 * Todo vive en la dirección, como en el resto del informe: así una selección
 * concreta se comparte por chat, que es como circula esto entre el gerente y
 * la administración.
 *
 * Sin ninguno marcado se muestran TODOS. Es lo contrario de lo que haría un
 * filtro de casillas normal —donde nada marcado es nada— pero aquí lo útil al
 * abrir es ver el día entero, no una pantalla vacía.
 */
export function FiltrosDetalle({
  dia,
  hora,
  vendedores,
  elegidos,
  conAnulados,
}: {
  dia: string;
  hora: string;
  vendedores: VendedorFiltro[];
  elegidos: string[];
  conAnulados: boolean;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambios: Record<string, string | null>) => {
    const p = new URLSearchParams({ vista: "detalle", dia });
    if (hora) p.set("hora", hora);
    if (elegidos.length) p.set("vs", elegidos.join(","));
    if (conAnulados) p.set("anulados", "1");

    for (const [k, v] of Object.entries(cambios)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    iniciar(() => router.push(`/informe?${p.toString()}`));
  };

  const alternar = (id: string) => {
    const siguiente = elegidos.includes(id)
      ? elegidos.filter((x) => x !== id)
      : [...elegidos, id];
    ir({ vs: siguiente.length ? siguiente.join(",") : null });
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">Fecha</span>
          <input
            type="date"
            value={dia}
            onChange={(e) => ir({ dia: e.target.value })}
            className="px-[13px] py-[9px] border border-borde-campo rounded-campo text-meta bg-superficie text-cuerpo"
          />
        </label>

        <div className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">Sorteo</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => ir({ hora: null })}
              className={cn(
                "px-[13px] py-[9px] rounded-campo text-meta font-medium border cursor-pointer",
                !hora
                  ? "bg-acento border-acento text-white"
                  : "bg-superficie border-borde-campo text-cuerpo",
              )}
            >
              Los tres
            </button>
            {HORAS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => ir({ hora: h })}
                className={cn(
                  "px-[13px] py-[9px] rounded-campo text-meta font-medium border cursor-pointer",
                  hora === h
                    ? "bg-acento border-acento text-white"
                    : "bg-superficie border-borde-campo text-cuerpo",
                )}
              >
                {hora12(h)}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => ir({ anulados: conAnulados ? null : "1" })}
          className={cn(
            "px-[13px] py-[9px] rounded-campo text-meta font-medium border cursor-pointer",
            conAnulados
              ? "bg-chip border-borde-campo text-tinta"
              : "bg-superficie border-borde-campo text-secundario",
          )}
        >
          {conAnulados ? "Ocultar anulados" : "Ver anulados"}
        </button>

        {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
      </div>

      {vendedores.length > 0 && (
        <div className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">
            Vendedores
            <span className="text-mudo font-normal">
              {" · "}
              {elegidos.length === 0
                ? "todos"
                : `${elegidos.length} de ${vendedores.length}`}
            </span>
            {elegidos.length > 0 && (
              <button
                type="button"
                onClick={() => ir({ vs: null })}
                className="ml-2 border-0 bg-transparent text-acento text-label cursor-pointer p-0"
              >
                limpiar
              </button>
            )}
          </span>
          <div className="flex gap-2 flex-wrap">
            {vendedores.map((v) => {
              const activo = elegidos.includes(v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => alternar(v.id)}
                  className={cn(
                    "px-[13px] py-[9px] rounded-campo text-meta border text-left cursor-pointer",
                    activo
                      ? "bg-acento border-acento text-white"
                      : "bg-superficie border-borde-campo text-cuerpo",
                  )}
                >
                  <span className="font-medium">{v.nombre}</span>
                  <span
                    className={cn(
                      "block text-label",
                      activo ? "text-navy-etiqueta" : "text-mudo",
                    )}
                  >
                    {v.codigo} · {v.tickets} {v.tickets === 1 ? "ticket" : "tickets"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
