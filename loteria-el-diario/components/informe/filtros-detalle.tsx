"use client";

import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { X } from "lucide-react";

import { BuscadorVendedor } from "@/components/ui/buscador-vendedor";
import { cn } from "@/lib/cn";
import { SORTEOS, hora12 } from "@/lib/format";

export type VendedorFiltro = {
  id: string;
  codigo: string;
  /** El rótulo: el alias si lo tiene, si no el nombre. Lo resuelve la base. */
  nombre: string;
  /** Cuántos tickets tiene ese día, para no ofrecer a quien no vendió. */
  tickets: number;
};

const HORAS = SORTEOS;

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
  destino = "/informe",
  fijos,
}: {
  dia: string;
  hora: string;
  vendedores: VendedorFiltro[];
  elegidos: string[];
  conAnulados: boolean;
  /**
   * A qué pantalla vuelve al tocar un filtro.
   *
   * Esta vista vive en dos sitios —el informe de gerencia y la pestaña de
   * ventas del punto de venta— y la dirección la tenía escrita a mano. El
   * resultado: elegir un vendedor desde el punto de venta te sacaba al
   * informe, que no es donde estabas trabajando.
   */
  destino?: string;
  /**
   * Parámetros que identifican la pantalla y tienen que sobrevivir a cada
   * filtro. En el punto de venta es `modo=ventas`: sin él la dirección deja
   * de apuntar a esa pestaña y se cae a la rejilla de captura.
   */
  fijos?: Record<string, string>;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambios: Record<string, string | null>) => {
    const p = new URLSearchParams({ ...fijos, dia });
    if (hora) p.set("hora", hora);
    if (elegidos.length) p.set("vs", elegidos.join(","));
    if (conAnulados) p.set("anulados", "1");

    for (const [k, v] of Object.entries(cambios)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    iniciar(() => router.push(`${destino}?${p.toString()}`));
  };

  /*
   * En el buscador sólo se ofrece a quien no está ya elegido.
   *
   * Dejar a los elegidos en la lista invitaba a tocarlos para quitarlos —el
   * gesto natural— y eso los habría vuelto a añadir. Quitar se hace en la
   * ficha, que es donde se ven.
   *
   * El rótulo que llega ya es el alias cuando lo hay: lo resuelve `fn_rotulo`
   * en la base. El nombre registrado baja a la línea gris, para poder
   * comprobar que el alias es de quien uno cree.
   */
  const disponibles = useMemo(
    () =>
      vendedores
        .filter((v) => !elegidos.includes(v.id))
        .map((v) => ({
          id: v.id,
          codigo: v.codigo,
          nombre: v.nombre,
          alias: null,
          detalle: `${v.tickets} ${v.tickets === 1 ? "ticket" : "tickets"}`,
        })),
    [vendedores, elegidos],
  );

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
          {/*
            Se escribe el alias en vez de buscar el botón con la vista.

            Con ochenta vendedores el muro de botones ocupaba más que la tabla
            que venía a mirarse, y estaba ordenado por código —que es justo lo
            que nadie recuerda—. El buscador añade de uno en uno; lo ya elegido
            baja a fichas, que es donde se quita.

            `permitirTodos={false}`: aquí «todos» no se elige, se consigue
            quitando fichas hasta no dejar ninguna. La opción habría sido un
            segundo camino para lo mismo, y uno de los dos siempre confunde.
          */}
          <div className="flex flex-col gap-2">
            <BuscadorVendedor
              vendedores={disponibles}
              valor=""
              onElegir={(id) => id && alternar(id)}
              etiqueta=""
              permitirTodos={false}
              placeholder={
                disponibles.length === 0
                  ? "Ya están todos elegidos"
                  : "Escriba el alias, el nombre o el código"
              }
              className="max-w-[340px]"
            />

            {elegidos.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {elegidos.map((id) => {
                  const v = vendedores.find((x) => x.id === id);
                  if (!v) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => alternar(id)}
                      aria-label={`Quitar a ${v.nombre} del filtro`}
                      className="flex items-center gap-2 px-[11px] py-[7px] rounded-campo text-meta border bg-acento border-acento text-white text-left cursor-pointer"
                    >
                      <span>
                        <span className="font-medium">{v.nombre}</span>
                        <span className="block text-label text-navy-etiqueta">
                          {v.codigo} · {v.tickets} {v.tickets === 1 ? "ticket" : "tickets"}
                        </span>
                      </span>
                      <X size={13} strokeWidth={2.4} absoluteStrokeWidth className="flex-none" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
