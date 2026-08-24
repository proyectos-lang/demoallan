"use client";

import {
  AvisoFueraDeHora,
  BannerCupo,
  ListaTanda,
  Recibo,
  TicketEnCurso,
} from "@/components/pos/piezas";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, hora12 } from "@/lib/format";
import { MONTOS_RAPIDOS, TECLAS, type Pos } from "@/lib/pos/use-pos";

/**
 * Punto de venta en un teléfono de verdad.
 *
 * NO HAY MARCO DE TELÉFONO. Antes lo había: un `rounded-marco` con una pantalla
 * de `h-[780px] overflow-hidden`, que era una ilustración pensada para enseñar
 * el flujo en un escritorio. En un teléfono real —de 640 a 750 px útiles, menos
 * la cabecera— esos 780 px no caben, y el pie con el subtotal y el botón de
 * confirmar quedaba por debajo del pliegue. La venta se podía teclear pero no
 * cerrar. Aquí la pantalla del teléfono ES la pantalla.
 *
 * SÓLO TECLADO. De los tres flujos del prototipo se queda el primero. La línea
 * rápida y la rejilla 00–99 siguen existiendo en la vista de escritorio, donde
 * hay sitio y un teclado físico; en la mano, cambiar de modo era una decisión
 * más que tomar antes de cada venta.
 *
 * DOS NIVELES. El vendedor de calle atiende una cola: teclea un ticket, lo
 * cierra, teclea el siguiente, y al final confirma todo de una vez. De ahí el
 * pie de dos filas — el ticket en curso arriba y la tanda abajo.
 */
export function VistaMovil({ pos }: { pos: Pos }) {
  const { datos, vendedor } = pos;
  if (!vendedor) return null;

  return (
    /*
     * SIN ALTURA FIJA Y SIN SCROLL ANIDADO.
     *
     * El intento anterior fue encajar el punto de venta en una caja de 780 px
     * con `overflow-hidden` y su propio desplazamiento interior. Dos problemas:
     * en un teléfono de 640 px útiles el pie caía debajo del pliegue, y el
     * gesto de arrastrar sobre el teclado movía el contenedor interno en vez de
     * la página, así que ni siquiera se podía llegar a él.
     *
     * Ahora la página se desplaza como una página normal y el pie va `sticky`:
     * mientras el punto de venta esté en pantalla, el subtotal y el botón de
     * confirmar están pegados al borde inferior del viewport. No hay altura que
     * calcular ni barra de direcciones que los tape.
     */
    <div className="lg:hidden flex flex-col">
      {/* --- Cabecera del sorteo --- */}
      <div className="sticky top-0 z-10 bg-superficie border-b border-riel px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="block">
            <span className="block text-th font-semibold tracking-th text-secundario">
              SORTEO DESTINO
            </span>
            <span className="block text-pos-lg font-semibold tracking-sutil">
              {hora12(datos.sorteo.hora)}
            </span>
          </span>
          <span className="block text-right">
            <span className="block text-th text-secundario">
              {pos.cerrada ? "venta" : "cierra en"}
            </span>
            <span
              className={cn(
                "block text-pos-lg font-semibold",
                pos.cerrada ? "text-cuerpo" : "text-negativo",
              )}
            >
              {!pos.montado
                ? "—"
                : pos.cerrada
                  ? "cerrada"
                  : countdownHasta(pos.ahora, datos.sorteo.hora_cierre)}
            </span>
          </span>
        </div>
        <div className="text-label text-secundario mt-[6px]">
          {vendedor.nombre} · {vendedor.codigo} · factor {vendedor.factor_pago.toFixed(2)} ·
          comisión {(vendedor.comision * 100).toFixed(2)}%
        </div>
      </div>

      {pos.recibo ? (
        <div className="flex-1 px-4 py-6">
          <Recibo pos={pos} />
        </div>
      ) : (
        <>
          {/* --- Captura y listas --- */}
          <div className="px-4 pt-4 pb-2">
            <AvisoFueraDeHora pos={pos} />

            <div className="flex gap-[10px] mt-3">
              <button
                onClick={() => pos.setFoco("numero")}
                className={cn(
                  "flex-1 text-left bg-superficie rounded-pos px-[14px] py-[11px] border-2 cursor-pointer",
                  pos.foco === "numero" ? "border-acento" : "border-borde-pos",
                )}
              >
                <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                  NÚMERO
                </span>
                <span className="block text-display font-semibold">
                  {pos.numero.padEnd(2, "–")}
                </span>
              </button>
              <button
                onClick={() => (pos.disp ?? 0) > 0 && pos.setFoco("monto")}
                className={cn(
                  "flex-[1.2] text-left bg-superficie rounded-pos px-[14px] py-[11px] border-2 cursor-pointer",
                  pos.foco === "monto" ? "border-acento" : "border-borde-pos",
                  (pos.disp ?? 0) <= 0 && "opacity-50",
                )}
              >
                <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                  MONTO (L)
                </span>
                <span className="block text-display font-semibold">{pos.monto || "0"}</span>
              </button>
            </div>

            <BannerCupo pos={pos} className="mt-3" />

            <div className="grid grid-cols-3 gap-[9px] mt-3">
              {TECLAS.map((k) => (
                <button
                  key={k}
                  onClick={() => pos.tecla(k)}
                  className={cn(
                    "border border-borde-campo rounded-pos py-[15px] text-tecla font-semibold bg-superficie cursor-pointer active:bg-acento-suave",
                    (k === "C" || k === "←") && "text-negativo",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-2 mt-3">
              {MONTOS_RAPIDOS.map((m) => (
                <button
                  key={m}
                  onClick={() => (pos.disp ?? 0) > 0 && pos.setMonto(String(m))}
                  className={cn(
                    "rounded-pos py-[10px] text-tabla font-semibold border cursor-pointer",
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
              onClick={() => pos.agregar(pos.numeroActual!, pos.montoNum)}
              className={cn(
                "w-full mt-3 rounded-pos py-4 text-pos font-semibold border-0",
                pos.puedeAgregar
                  ? "bg-tinta text-white cursor-pointer"
                  : "bg-riel text-mudo cursor-not-allowed",
              )}
            >
              Agregar al ticket
            </button>

            <div className="mt-4">
              <TicketEnCurso pos={pos} />
            </div>

            <ListaTanda pos={pos} />
          </div>

          {/*
            El pie, pegado al borde inferior del viewport.

            Aquí viven las dos cifras que antes no se veían: el total del ticket
            que se está tecleando y el total de la tanda. El relleno de abajo
            suma `safe-area-inset-bottom` porque la barra de gestos de iOS y
            Android se dibuja encima del contenido, y sin eso el botón queda a
            medias.
          */}
          <div
            className="sticky bottom-0 z-10 border-t border-riel bg-superficie px-4 pt-3"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          >
            {pos.errorVenta && (
              <p className="text-meta text-negativo mt-0 mb-2">{pos.errorVenta}</p>
            )}

            {/* Fila 1: el ticket que se está tecleando. */}
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
                  "rounded-pos px-4 py-[11px] text-tabla font-semibold border",
                  pos.carrito.length > 0
                    ? "bg-superficie text-tinta border-borde-campo cursor-pointer"
                    : "bg-riel text-mudo border-riel cursor-not-allowed",
                )}
              >
                Cerrar ticket
              </button>
            </div>

            {/* Fila 2: la tanda entera y el botón que la registra. */}
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
                "w-full rounded-pos py-[17px] text-pos-lg font-semibold border-0",
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
        </>
      )}
    </div>
  );
}
