"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { cn } from "@/lib/cn";

export type Opcion = { valor: string; rotulo: string; cuantos: number };

/**
 * Los filtros de la trazabilidad: un rango, una acción, una entidad, alguien.
 *
 * LAS OPCIONES SALEN DE LO QUE OCURRIÓ, no de una lista fija. Si en el rango
 * elegido nadie anuló nada, «Anuló» no aparece: ofrecerlo llevaría a una
 * pantalla vacía sin explicar por qué. Y cada opción dice cuántas veces, que
 * suele ser la respuesta antes de pulsarla.
 *
 * Todo vive en la dirección, como en el informe: una consulta concreta se
 * comparte por chat, que es como circula esto entre gerencia y administración.
 */
export function FiltrosTrazabilidad({
  desde,
  hasta,
  accion,
  entidad,
  usuario,
  hoy,
  acciones,
  entidades,
  usuarios,
}: {
  desde: string;
  hasta: string;
  accion: string;
  entidad: string;
  usuario: string;
  hoy: string;
  acciones: Opcion[];
  entidades: Opcion[];
  usuarios: Opcion[];
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();

  const ir = (cambios: Record<string, string | null>) => {
    const p = new URLSearchParams({ desde, hasta });
    if (accion) p.set("accion", accion);
    if (entidad) p.set("entidad", entidad);
    if (usuario) p.set("usuario", usuario);

    for (const [k, v] of Object.entries(cambios)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    iniciar(() => router.push(`/trazabilidad?${p.toString()}`));
  };

  /** Los tres últimos días, que es el rango con el que se investiga algo. */
  const atras = (dias: number) => {
    const d = new Date(`${hoy}T12:00:00`);
    d.setDate(d.getDate() - dias);
    const iso = d.toLocaleDateString("en-CA");
    ir({ desde: iso, hasta: hoy });
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">Desde</span>
          <input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => ir({ desde: e.target.value })}
            className="px-[13px] py-[9px] border border-borde-campo rounded-campo text-meta bg-superficie text-cuerpo"
          />
        </label>

        <label className="flex flex-col gap-[6px]">
          <span className="text-label text-secundario font-medium">Hasta</span>
          <input
            type="date"
            value={hasta}
            min={desde}
            max={hoy}
            onChange={(e) => ir({ hasta: e.target.value })}
            className="px-[13px] py-[9px] border border-borde-campo rounded-campo text-meta bg-superficie text-cuerpo"
          />
        </label>

        <div className="flex gap-1">
          {[
            { etiqueta: "Hoy", dias: 0 },
            { etiqueta: "3 días", dias: 2 },
            { etiqueta: "Semana", dias: 6 },
          ].map((a) => (
            <button
              key={a.etiqueta}
              type="button"
              onClick={() => atras(a.dias)}
              className="px-[13px] py-[9px] rounded-campo text-meta font-medium border bg-superficie border-borde-campo text-cuerpo cursor-pointer"
            >
              {a.etiqueta}
            </button>
          ))}
        </div>

        {pendiente && <span className="text-meta text-secundario pb-[10px]">Cargando…</span>}
      </div>

      <Grupo
        etiqueta="Qué se hizo"
        opciones={acciones}
        elegido={accion}
        onElegir={(v) => ir({ accion: v })}
      />
      <Grupo
        etiqueta="Sobre qué"
        opciones={entidades}
        elegido={entidad}
        onElegir={(v) => ir({ entidad: v })}
      />
      {usuarios.length > 0 && (
        <Grupo
          etiqueta="Quién"
          opciones={usuarios}
          elegido={usuario}
          onElegir={(v) => ir({ usuario: v })}
        />
      )}
    </div>
  );
}

function Grupo({
  etiqueta,
  opciones,
  elegido,
  onElegir,
}: {
  etiqueta: string;
  opciones: Opcion[];
  elegido: string;
  onElegir: (valor: string) => void;
}) {
  if (opciones.length === 0) return null;

  return (
    <div className="flex flex-col gap-[6px]">
      <span className="text-label text-secundario font-medium">
        {etiqueta}
        {elegido && (
          <button
            type="button"
            onClick={() => onElegir("")}
            className="ml-2 border-0 bg-transparent text-acento text-label cursor-pointer p-0"
          >
            limpiar
          </button>
        )}
      </span>
      <div className="flex gap-2 flex-wrap">
        {opciones.map((o) => {
          const activo = elegido === o.valor;
          return (
            <button
              key={o.valor}
              type="button"
              onClick={() => onElegir(activo ? "" : o.valor)}
              className={cn(
                "px-[13px] py-[7px] rounded-campo text-meta border cursor-pointer",
                activo
                  ? "bg-acento border-acento text-white"
                  : "bg-superficie border-borde-campo text-cuerpo",
              )}
            >
              {o.rotulo}
              {/* Cuántas veces ocurrió: suele ser la respuesta antes de
                  pulsar, y evita entrar a una lista para contar a ojo. */}
              <span
                className={cn(
                  "ml-[6px] text-label",
                  activo ? "text-navy-etiqueta" : "text-mudo",
                )}
              >
                {o.cuantos}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
