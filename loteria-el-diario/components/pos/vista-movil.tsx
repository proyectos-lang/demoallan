"use client";

import {
  AvisoFueraDeHora,
  ListaTanda,
  Recibo,
  TicketEnCurso,
} from "@/components/pos/piezas";
import { HojaMonto } from "@/components/pos/hoja-monto";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, hora12, pad2 } from "@/lib/format";
import { CUPO_BAJO, POR_LINEA, type Pos } from "@/lib/pos/use-pos";

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
 * SIN MODOS. De los tres flujos del prototipo no queda ninguno en la mano: se
 * toca el número en la rejilla y una hoja pregunta cuánto. La línea rápida y el
 * teclado de dos campos siguen en la vista de escritorio, donde hay sitio y un
 * teclado físico.
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

            <Rejilla pos={pos} />

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

      <HojaMonto pos={pos} />
    </div>
  );
}

/**
 * La rejilla 00–99, en diez filas de diez.
 *
 * ANTES EL NÚMERO SE TECLEABA CIFRA A CIFRA: para vender el 01 había que
 * pulsar el 0 y luego el 1, y encima acertar en qué campo estaba el foco. El
 * vendedor pidió tocarlo de una, y tocándolo sale gratis lo demás: tocar
 * varios, y tomar una fila entera con un gesto.
 *
 * La primera columna de cada fila es el botón que toma la línea entera. Va ahí
 * y no debajo con el texto completo porque debajo duplicaba la altura y
 * obligaba a recorrer la rejilla con el pulgar; al principio de la fila, el
 * gesto queda al lado de lo que afecta.
 *
 * CINCO POR LÍNEA Y NO DIEZ. Con diez columnas la casilla salía de 29 px de
 * ancho —por debajo de los 44 que recomiendan iOS y Android—, y aquí un toque
 * errado no es un inconveniente: es vender otro número. Con cinco casi se
 * duplica. Se paga en alto: veinte líneas en vez de diez.
 */
function Rejilla({ pos }: { pos: Pos }) {
  const lineas = Array.from({ length: 100 / POR_LINEA }, (_, i) => i);

  return (
    <div className="mt-3">
      <div className="text-micro text-secundario mb-2">
        Toque un número y diga cuánto. El rango pregunta por la línea entera.
      </div>

      <div className="flex flex-col gap-[2px]">
        {lineas.map((indice) => {
          const desde = indice * POR_LINEA;
          const fila = Array.from({ length: POR_LINEA }, (_, i) => desde + i);
          const conCupo = fila.filter((n) => pos.disponible[n] > 0);

          return (
            <div
              key={indice}
              className="grid gap-[2px]"
              style={{
                gridTemplateColumns: `46px repeat(${POR_LINEA}, minmax(0, 1fr))`,
              }}
            >
              <button
                onClick={() => pos.pedirMonto(fila)}
                disabled={conCupo.length === 0}
                aria-label={`Seleccionar toda la línea del ${pad2(desde)} al ${pad2(desde + POR_LINEA - 1)}`}
                className={cn(
                  "h-[38px] rounded-celda text-badge font-semibold border-[1.5px] leading-tight",
                  conCupo.length === 0
                    ? "bg-riel text-mudo border-riel"
                    : "bg-panel text-cuerpo border-borde-pos",
                )}
              >
                {pad2(desde)}–{pad2(desde + POR_LINEA - 1)}
              </button>

              {fila.map((n) => {
                const dp = pos.disponible[n];
                return (
                  <button
                    key={n}
                    onClick={() => pos.pedirMonto([n])}
                    disabled={dp <= 0}
                    className={cn(
                      "h-[38px] rounded-celda text-pos font-semibold border-[1.5px] p-0",
                      dp <= 0
                          ? "bg-negativo-fondo text-negativo-texto border-negativo-borde"
                          : dp < CUPO_BAJO
                            ? "bg-ambar-fondo text-tinta border-borde-pos"
                            : "bg-superficie text-tinta border-borde-pos",
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
