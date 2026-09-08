"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

import {
  AvisoFueraDeHora,
  BannerCupo,
  ListaTanda,
  PildoraEstado,
  Recibo,
  TicketEnCurso,
} from "@/components/pos/piezas";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, hora12, pad2 } from "@/lib/format";
import {
  CUPO_BAJO,
  MONTOS_RAPIDOS,
  POR_LINEA,
  POR_RANGO,
  type Pos,
} from "@/lib/pos/use-pos";

/**
 * El punto de venta del VENDEDOR en una laptop.
 *
 * POR QUÉ NO SIRVE LA VISTA DE ESCRITORIO QUE YA HABÍA
 * ----------------------------------------------------
 * Esa está hecha para administración: tres modos de captura entre los que
 * elegir —número y monto, línea rápida, rejilla— y una rejilla plana de 10×10
 * sin botón de decena ni «marcar varios».
 *
 * El vendedor ya sabe vender: lo hace todos los días en el teléfono, con la
 * rejilla de 5 en 5, el botón que toma una decena entera y la casilla de
 * marcar varios. Ponerle delante otra forma de trabajar en la laptop es
 * pedirle que aprenda dos oficios para el mismo gesto, y equivocarse con una
 * cola delante.
 *
 * Aquí está EL MISMO FLUJO del móvil, con las mismas funciones, aprovechando
 * lo que una laptop sí tiene: ancho para que la rejilla y el ticket convivan
 * sin desplazarse, y un teclado físico para el monto.
 *
 * QUÉ CAMBIA RESPECTO AL TELÉFONO, Y POR QUÉ
 * ------------------------------------------
 * La hoja del monto sube desde abajo en el móvil porque abajo está el pulgar.
 * En una laptop se apunta con el ratón y se escribe con el teclado, así que es
 * una ventana centrada con el campo ya enfocado: se teclea el monto y Enter
 * agrega, sin tocar el ratón. La tira de montos sigue ahí para quien prefiera
 * el clic.
 */
export function VistaVendedorEscritorio({ pos }: { pos: Pos }) {
  const { datos, vendedor } = pos;
  if (!vendedor) return null;

  return (
    <div className="hidden lg:flex flex-col gap-4">
      {/* La cabecera: a qué sorteo se está vendiendo y cuánto queda. */}
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-4 flex items-center gap-5 flex-wrap">
        <div>
          <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
            SORTEO
          </span>
          <span className="block text-h2 font-semibold tracking-sutil mt-[2px]">
            {hora12(datos.sorteo.hora)}
          </span>
        </div>

        <PildoraEstado estado={datos.sorteo.estado} />

        <div>
          <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
            CIERRA EN
          </span>
          <span className="block text-h2 font-semibold tracking-sutil mt-[2px] tabular-nums">
            {pos.ahora === 0
              ? "—"
              : pos.bloqueada
                ? "cerrada"
                : countdownHasta(pos.ahora, datos.sorteo.hora_cierre)}
          </span>
        </div>

        <div className="ml-auto text-meta text-secundario leading-[1.5] text-right">
          factor {vendedor.factor_pago.toFixed(2)} · comisión{" "}
          {(vendedor.comision * 100).toFixed(2)}%
          <br />
          tope por número {fmt(vendedor.tope_por_numero)}
        </div>
      </div>

      <AvisoFueraDeHora pos={pos} />

      {pos.recibo ? (
        <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-8 max-w-[520px] mx-auto w-full">
          <Recibo pos={pos} />
        </div>
      ) : (
        <div className="flex gap-4 items-start">
          {/* ---- La rejilla, la única forma de capturar ---- */}
          <div className="flex-1 min-w-0 bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex flex-col gap-3">
            <RejillaVendedor pos={pos} />
            <BannerCupo pos={pos} />
          </div>

          {/* ---- El ticket y la tanda ---- */}
          {/*
            Cede antes de estrangular la rejilla: la captura es el trabajo y
            el ticket la consecuencia. Mismo criterio que en la vista de
            administración.
          */}
          <div className="flex-none shrink basis-[340px] max-w-[400px] w-full bg-superficie border border-borde rounded-card shadow-card flex flex-col">
            <div className="px-[18px] pt-4">
              <TicketEnCurso pos={pos} />
              <ListaTanda pos={pos} />
            </div>

            {/*
              El pie, con las MISMAS dos cifras del teléfono: lo que se está
              tecleando y lo que va a registrarse. Verlas separadas es lo que
              evita confirmar creyendo que el ticket en curso ya entró.
            */}
            <div className="mt-auto border-t border-riel px-[18px] py-4">
              {pos.errorVenta && (
                <p className="text-meta text-negativo mt-0 mb-2">{pos.errorVenta}</p>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="block">
                  <span className="block text-label text-secundario">Ticket en curso</span>
                  <span className="block text-h2 font-semibold tracking-sutil">
                    {fmt(pos.totalTicket)}
                  </span>
                </span>
                <button
                  disabled={pos.carrito.length === 0}
                  onClick={pos.cerrarTicket}
                  className={cn(
                    "rounded-pos px-4 py-[10px] text-tabla font-semibold border",
                    pos.carrito.length > 0
                      ? "bg-superficie text-tinta border-borde-campo cursor-pointer"
                      : "bg-riel text-mudo border-riel cursor-not-allowed",
                  )}
                >
                  Cerrar ticket
                </button>
              </div>

              <div className="flex items-baseline justify-between mt-3 mb-2">
                <span className="text-tabla text-secundario">
                  {pos.ticketsPorRegistrar === 0
                    ? "Sin tickets"
                    : `Total · ${pos.ticketsPorRegistrar} ${
                        pos.ticketsPorRegistrar === 1 ? "ticket" : "tickets"
                      }`}
                </span>
                <span className="text-h1 font-semibold tracking-titular">
                  {fmt(pos.totalTanda)}
                </span>
              </div>

              <button
                disabled={pos.ticketsPorRegistrar === 0 || pos.enviando || pos.bloqueada}
                onClick={pos.confirmar}
                className={cn(
                  "w-full rounded-pos py-[14px] text-pos font-semibold border-0",
                  pos.ticketsPorRegistrar > 0 && !pos.enviando && !pos.bloqueada
                    ? "bg-acento text-white cursor-pointer"
                    : "bg-riel text-mudo cursor-not-allowed",
                )}
              >
                {pos.enviando
                  ? "Registrando…"
                  : pos.bloqueada
                    ? "Venta cerrada"
                    : "Confirmar y registrar"}
              </button>
            </div>
          </div>
        </div>
      )}

      <DialogoMonto pos={pos} />
    </div>
  );
}

/**
 * La rejilla del vendedor: la misma del teléfono, con más sitio.
 *
 * Se repite la estructura de `vista-movil` en vez de compartir el componente
 * porque las medidas son otras —celdas más altas, decenas más anchas— y
 * parametrizar todo eso habría dejado un componente lleno de condicionales que
 * no se entiende en ninguna de las dos pantallas. Lo que SÍ se comparte, que
 * es lo que importa, son las acciones: `pedirMonto`, `alternarModoVarios`,
 * `cobrarSeleccion` y `limpiarSeleccion` salen del mismo hook, así que las dos
 * vistas no pueden comportarse distinto por accidente.
 */
function RejillaVendedor({ pos }: { pos: Pos }) {
  const decenas = Array.from({ length: 100 / POR_RANGO }, (_, i) => i);
  const FILAS = POR_RANGO / POR_LINEA;

  return (
    <div>
      {/* El interruptor va ARRIBA: decide qué hace el siguiente clic, y
          decidirlo después de haber hecho clic no serviría de nada. */}
      <button
        type="button"
        onClick={pos.alternarModoVarios}
        aria-pressed={pos.modoVarios}
        className={cn(
          "flex items-center gap-[10px] px-[13px] py-[10px] rounded-campo text-meta font-medium text-left border mb-3 cursor-pointer",
          pos.modoVarios
            ? "bg-acento border-acento text-white"
            : "bg-panel border-borde-campo text-cuerpo",
        )}
      >
        <span
          className={cn(
            "w-[18px] h-[18px] flex-none rounded-[5px] border-[1.5px] flex items-center justify-center",
            pos.modoVarios ? "bg-white border-white" : "border-borde-pos bg-superficie",
          )}
        >
          {pos.modoVarios && (
            <Check size={13} strokeWidth={3.5} absoluteStrokeWidth color="var(--color-acento)" />
          )}
        </span>
        {pos.modoVarios
          ? "Marcando varios · elija los números y ponga un solo valor"
          : "Marcar varios números"}
      </button>

      {/* Con varios marcados, el botón que abre el monto para todos. */}
      {pos.modoVarios && pos.seleccion.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={pos.cobrarSeleccion}
            className="flex-1 border-0 bg-acento text-white rounded-pos py-[12px] text-pos font-semibold cursor-pointer"
          >
            Poner valor a {pos.seleccion.length}{" "}
            {pos.seleccion.length === 1 ? "número" : "números"}
          </button>
          <button
            type="button"
            onClick={pos.limpiarSeleccion}
            className="border border-borde-campo bg-superficie text-cuerpo rounded-pos px-4 py-[12px] text-meta font-medium cursor-pointer"
          >
            Limpiar
          </button>
        </div>
      )}

      <div className="flex flex-col gap-[3px]">
        {decenas.map((indice) => {
          const inicio = indice * POR_RANGO;
          const decena = Array.from({ length: POR_RANGO }, (_, i) => inicio + i);
          const conCupo = decena.filter((n) => pos.disponible[n] > 0);

          return (
            <div
              key={indice}
              className="grid gap-[3px]"
              style={{
                gridTemplateColumns: `72px repeat(${POR_LINEA}, minmax(0, 1fr))`,
              }}
            >
              {/* El botón abarca las dos filas de su decena, para quedar a la
                  altura de lo que selecciona. */}
              <button
                onClick={() => pos.pedirMonto(decena)}
                disabled={conCupo.length === 0}
                aria-label={`Seleccionar del ${pad2(inicio)} al ${pad2(inicio + POR_RANGO - 1)}`}
                style={{ gridRow: `span ${FILAS}` }}
                className={cn(
                  "rounded-celda text-meta font-semibold border-[1.5px] leading-tight",
                  conCupo.length === 0
                    ? "bg-riel text-mudo border-riel cursor-not-allowed"
                    : "bg-panel text-cuerpo border-borde-pos cursor-pointer hover:bg-acento-suave",
                )}
              >
                {pad2(inicio)}–{pad2(inicio + POR_RANGO - 1)}
              </button>

              {decena.map((n) => {
                const dp = pos.disponible[n];
                const marcado = pos.seleccion.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => pos.pedirMonto([n])}
                    disabled={dp <= 0}
                    title={`${pad2(n)} · disponible ${fmt(dp)}`}
                    className={cn(
                      "h-[34px] rounded-celda text-tabla font-semibold border-[1.5px] p-0",
                      dp <= 0
                        ? "bg-negativo-fondo text-negativo-texto border-negativo-borde cursor-not-allowed"
                        : marcado
                          // Marcado gana al semáforo de cupo: mientras se
                          // eligen números, lo que importa es cuáles van.
                          ? "bg-acento text-white border-acento cursor-pointer"
                          : dp < CUPO_BAJO
                            ? "bg-ambar-fondo text-tinta border-borde-pos cursor-pointer"
                            : "bg-superficie text-tinta border-borde-pos cursor-pointer hover:border-acento",
                    )}
                  >
                    {pad2(n)}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Cuánto juega: una ventana con el teclado físico.
 *
 * En el teléfono esto es una hoja que sube desde abajo con un teclado en
 * pantalla, porque abajo está el pulgar y no hay otro teclado. En una laptop
 * hay uno de verdad, así que la ventana se centra y el campo llega ENFOCADO:
 * se teclea el monto y Enter agrega, sin tocar el ratón. Ésa es toda la
 * diferencia entre las dos pantallas, y es la que hace que vender aquí sea
 * más rápido en vez de sólo más grande.
 */
function DialogoMonto({ pos }: { pos: Pos }) {
  const abierta = pos.montoAbierto && pos.seleccion.length > 0;
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!abierta) return;
    // El foco va tras el pintado: pedirlo en el mismo ciclo se lo lleva el
    // elemento que todavía está montándose.
    const t = setTimeout(() => campo.current?.focus(), 0);

    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") pos.cerrarMonto();
    };
    window.addEventListener("keydown", alPulsar);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", alPulsar);
    };
  }, [abierta, pos]);

  if (!abierta) return null;

  const varios = pos.seleccion.length > 1;

  return (
    <div className="hidden lg:flex fixed inset-0 z-40 items-center justify-center p-6">
      {/* Tocar fuera cancela, como en el resto de diálogos del proyecto. */}
      <button
        aria-label="Cancelar"
        onClick={pos.cerrarMonto}
        className="absolute inset-0 bg-tinta/45 border-0 cursor-pointer"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cuánto juega"
        className="relative bg-superficie rounded-modal border border-borde shadow-card w-full max-w-[520px] px-6 py-5"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="block">
            <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
              CUÁNTO JUEGA
            </span>
            <span className="block text-h2 font-semibold tracking-sutil mt-[2px]">
              {varios
                ? `${pos.seleccion.length} números`
                : `Número ${pad2(pos.seleccion[0])}`}
            </span>
          </span>
          <button
            onClick={pos.cerrarMonto}
            className="text-meta text-secundario font-medium px-2 py-1 cursor-pointer"
          >
            Cancelar
          </button>
        </div>

        {/* Qué números van: con varios marcados, fiarse de la memoria es como
            se cobra de más. */}
        {varios && (
          <div className="flex flex-wrap gap-1 mt-3">
            {pos.seleccion.map((n) => (
              <span
                key={n}
                className="px-[7px] py-[3px] rounded-celda bg-acento-suave text-acento-fuerte text-meta font-semibold tabular-nums"
              >
                {pad2(n)}
              </span>
            ))}
          </div>
        )}

        {/* El semáforo del cupo, con la misma clase que calcula el hook: si
            aquí se decidiera el color por separado, el mismo aviso podría
            salir de un color en el teléfono y de otro en la laptop. */}
        <div
          className={cn(
            "rounded-banner px-[13px] py-[9px] text-tabla font-medium leading-[1.35] mt-3",
            pos.banner.clase,
          )}
        >
          {pos.banner.texto}
        </div>

        <label className="block mt-4">
          <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario mb-[6px]">
            MONTO (L)
          </span>
          <input
            ref={campo}
            value={pos.monto}
            onChange={(e) => pos.setMonto(e.target.value.replace(/\D/g, "").slice(0, 5))}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              // Enter agrega y cierra: es el gesto que ahorra el viaje al
              // ratón, y el único motivo por el que esto no es la hoja móvil.
              if (pos.puedeAgregar) pos.agregarSeleccion();
            }}
            inputMode="numeric"
            placeholder="0"
            className="w-full px-4 py-3 rounded-pos border-2 border-acento text-display font-semibold outline-none bg-superficie"
          />
        </label>

        {/* La misma tira de 5 en 5 de la hoja móvil, para quien prefiera el
            clic. Aquí hay ancho, así que se ven de una vez sin arrastrar. */}
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(56px,1fr))] gap-2 mt-3">
          {MONTOS_RAPIDOS.map((m) => (
            <button
              key={m}
              onClick={() => pos.setMonto(String(m))}
              aria-pressed={String(m) === pos.monto}
              className={cn(
                "rounded-pos py-[9px] text-tabla font-semibold border cursor-pointer",
                String(m) === pos.monto
                  ? "bg-acento text-white border-acento"
                  : "bg-superficie text-tinta border-borde-pos",
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <button
          disabled={!pos.puedeAgregar}
          onClick={pos.agregarSeleccion}
          className={cn(
            "w-full mt-4 rounded-pos py-[13px] text-pos font-semibold border-0",
            pos.puedeAgregar
              ? "bg-tinta text-white cursor-pointer"
              : "bg-riel text-mudo cursor-not-allowed",
          )}
        >
          Agregar al ticket
        </button>

        <p className="text-label text-mudo text-center mt-2 mb-0">
          Enter agrega · Esc cancela
        </p>
      </div>
    </div>
  );
}
