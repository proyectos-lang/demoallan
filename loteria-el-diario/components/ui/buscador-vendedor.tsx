"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * Lo mínimo que hace falta para elegir a alguien. Cada pantalla añade lo suyo
 * —cuántos sorteos le faltan, su zona— en `detalle`.
 */
export type VendedorBuscable = {
  id: string;
  codigo: string;
  nombre: string;
  /** Nombre comercial. Es por lo que se le conoce, y por lo que se le busca. */
  alias?: string | null;
  /** Línea gris bajo el nombre: zona, saldo pendiente, lo que aporte cada pantalla. */
  detalle?: string;
  /** Se pinta en gris y con una coletilla: «(inactivo)», «(eliminado)». */
  apagado?: string;
};

/**
 * Elegir un vendedor escribiendo, no buscándolo en una lista.
 *
 * POR QUÉ NO UN `select`
 * ----------------------
 * Con sesenta vendedores, un desplegable obliga a recorrerlos con la vista
 * hasta dar con el que se busca — y ordenado por código, que es justo lo que
 * nadie recuerda. Aquí se teclea «merka» y aparece.
 *
 * SE BUSCA POR ALIAS, NOMBRE Y CÓDIGO A LA VEZ
 * --------------------------------------------
 * Porque quien busca no sabe de antemano por cuál de los tres lo va a
 * encontrar: lo conoce por el alias del toldo, lo tiene apuntado por código, o
 * se acuerda del nombre registrado. Obligar a elegir el campo antes de escribir
 * es un paso de más en el gesto más repetido del panel.
 *
 * EL ALIAS MANDA EN LO QUE SE LEE. Si lo tiene, es lo que se pinta en grande y
 * el nombre baja a la línea gris: es como se le llama por teléfono y como sale
 * en su ticket. Sin alias, el nombre ocupa ese sitio.
 *
 * SE NAVEGA CON EL TECLADO
 * ------------------------
 * Flechas para moverse, Enter para elegir, Esc para cerrar. En una pantalla de
 * administración se trabaja con las dos manos en el teclado, y obligar a bajar
 * al ratón por cada filtro es lo que hace lenta una herramienta que se usa
 * cincuenta veces al día.
 */
export function BuscadorVendedor({
  vendedores,
  valor,
  onElegir,
  etiqueta = "Vendedor",
  placeholder = "Escriba el alias, el nombre o el código",
  textoTodos = "Todos",
  permitirTodos = true,
  className,
}: {
  vendedores: VendedorBuscable[];
  /** El identificador elegido, o cadena vacía para «todos». */
  valor: string;
  onElegir: (id: string) => void;
  etiqueta?: string;
  placeholder?: string;
  /** Qué dice la opción que no filtra por nadie. */
  textoTodos?: string;
  /** En liquidación hay que elegir a alguien: ahí no vale «todos». */
  permitirTodos?: boolean;
  className?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [resaltado, setResaltado] = useState(0);
  const caja = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLUListElement>(null);
  const idLista = useId();

  const elegido = vendedores.find((v) => v.id === valor) ?? null;

  /** Lo que se muestra en grande: el alias si lo tiene, si no el nombre. */
  const rotulo = (v: VendedorBuscable) => v.alias?.trim() || v.nombre;

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return vendedores;
    return vendedores.filter((v) =>
      [v.codigo, v.nombre, v.alias ?? ""].some((c) => c.toLowerCase().includes(q)),
    );
  }, [busqueda, vendedores]);

  // Al filtrar, el resaltado vuelve arriba: dejarlo donde estaba lo pondría
  // sobre un vendedor que ya no está en la lista, y Enter elegiría a otro.
  useEffect(() => {
    setResaltado(0);
  }, [busqueda]);

  // Cerrar al tocar fuera. Sin esto la lista se queda abierta tapando la
  // pantalla mientras se intenta usar otro filtro.
  useEffect(() => {
    if (!abierto) return;
    const alTocar = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener("mousedown", alTocar);
    return () => document.removeEventListener("mousedown", alTocar);
  }, [abierto]);

  // El resaltado tiene que verse: con sesenta vendedores, bajar con la flecha
  // sin que la lista acompañe deja al usuario moviéndose a ciegas.
  useEffect(() => {
    if (!abierto || !lista.current) return;
    const fila = lista.current.children[resaltado] as HTMLElement | undefined;
    fila?.scrollIntoView({ block: "nearest" });
  }, [resaltado, abierto]);

  const abrir = () => {
    setAbierto(true);
    setBusqueda("");
    // El foco va tras el pintado: pedirlo en el mismo ciclo se lo lleva el
    // elemento que todavía se está montando.
    setTimeout(() => campo.current?.focus(), 0);
  };

  const elegir = (id: string) => {
    onElegir(id);
    setAbierto(false);
    setBusqueda("");
  };

  const alTeclear = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setAbierto(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const total = filtrados.length + (permitirTodos ? 1 : 0);
      if (total === 0) return;
      setResaltado((i) => (e.key === "ArrowDown" ? (i + 1) % total : (i - 1 + total) % total));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (permitirTodos && resaltado === 0) {
        elegir("");
        return;
      }
      const v = filtrados[resaltado - (permitirTodos ? 1 : 0)];
      if (v) elegir(v.id);
    }
  };

  return (
    <div className={cn("block", className)}>
      {etiqueta && (
        <span className="block text-label text-secundario font-medium mb-[6px]">{etiqueta}</span>
      )}

      <div ref={caja} className="relative">
        {/* Cerrado: un botón que enseña a quién está elegido. */}
        {!abierto && (
          <button
            type="button"
            onClick={abrir}
            aria-haspopup="listbox"
            aria-expanded={false}
            className="w-full flex items-center gap-2 px-3 py-[9px] border border-borde-campo rounded-campo bg-superficie text-base text-left"
          >
            <span className="flex-1 min-w-0 truncate">
              {elegido ? (
                <>
                  <span className="text-tinta">{rotulo(elegido)}</span>
                  <span className="text-mudo"> · {elegido.codigo}</span>
                </>
              ) : (
                <span className="text-secundario">{textoTodos}</span>
              )}
            </span>
            {elegido && permitirTodos && (
              // Quitar el filtro sin abrir la lista: es el gesto que se hace
              // más veces después de haber mirado a uno.
              <span
                role="button"
                tabIndex={-1}
                aria-label="Quitar el filtro de vendedor"
                onClick={(e) => {
                  e.stopPropagation();
                  onElegir("");
                }}
                className="flex-none p-[2px] text-mudo hover:text-cuerpo"
              >
                <X size={13} strokeWidth={2.4} absoluteStrokeWidth />
              </span>
            )}
            <ChevronDown size={15} strokeWidth={2} absoluteStrokeWidth className="flex-none text-mudo" />
          </button>
        )}

        {/* Abierto: el campo de búsqueda ocupa el sitio del botón. */}
        {abierto && (
          <div className="relative">
            <Search
              size={14}
              strokeWidth={2}
              absoluteStrokeWidth
              className="absolute left-[10px] top-1/2 -translate-y-1/2 text-mudo pointer-events-none"
            />
            <input
              ref={campo}
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={alTeclear}
              placeholder={placeholder}
              role="combobox"
              aria-expanded
              aria-controls={idLista}
              aria-autocomplete="list"
              className="w-full pl-[30px] pr-3 py-[9px] border border-acento rounded-campo bg-superficie text-base outline-none"
            />
          </div>
        )}

        {abierto && (
          <ul
            ref={lista}
            id={idLista}
            role="listbox"
            className="absolute z-30 left-0 right-0 mt-1 max-h-[300px] overflow-y-auto bg-superficie border border-borde rounded-card shadow-card py-1 min-w-[260px]"
          >
            {permitirTodos && (
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected={valor === ""}
                  onMouseEnter={() => setResaltado(0)}
                  onClick={() => elegir("")}
                  className={cn(
                    "w-full text-left px-3 py-[7px] text-meta flex items-center gap-2",
                    resaltado === 0 ? "bg-acento-suave" : "bg-transparent",
                  )}
                >
                  <span className="flex-1 text-secundario">{textoTodos}</span>
                  {valor === "" && (
                    <Check size={13} strokeWidth={2.6} absoluteStrokeWidth className="text-acento" />
                  )}
                </button>
              </li>
            )}

            {filtrados.map((v, i) => {
              const indice = i + (permitirTodos ? 1 : 0);
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={v.id === valor}
                    onMouseEnter={() => setResaltado(indice)}
                    onClick={() => elegir(v.id)}
                    className={cn(
                      "w-full text-left px-3 py-[7px] flex items-center gap-2",
                      resaltado === indice ? "bg-acento-suave" : "bg-transparent",
                      v.apagado && "opacity-70",
                    )}
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-meta text-tinta truncate">
                        {rotulo(v)}
                        {v.apagado && <span className="text-mudo"> {v.apagado}</span>}
                      </span>
                      {/*
                        La línea gris lleva el código y, si hay alias, TAMBIÉN
                        el nombre registrado: es lo que permite comprobar que
                        «MERKA EXPRESS» es quien uno cree antes de elegirlo.
                      */}
                      <span className="block text-label text-mudo truncate">
                        {v.codigo}
                        {v.alias?.trim() ? ` · ${v.nombre}` : ""}
                        {v.detalle ? ` · ${v.detalle}` : ""}
                      </span>
                    </span>
                    {v.id === valor && (
                      <Check
                        size={13}
                        strokeWidth={2.6}
                        absoluteStrokeWidth
                        className="flex-none text-acento"
                      />
                    )}
                  </button>
                </li>
              );
            })}

            {filtrados.length === 0 && (
              <li className="px-3 py-3 text-meta text-mudo">
                Ningún vendedor coincide con «{busqueda.trim()}».
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
