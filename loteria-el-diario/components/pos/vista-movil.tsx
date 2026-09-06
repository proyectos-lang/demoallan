"use client";

import { Check } from "lucide-react";

import {
  AvisoFueraDeHora,
  ListaTanda,
  Recibo,
  TicketEnCurso,
} from "@/components/pos/piezas";
import { HojaMonto } from "@/components/pos/hoja-monto";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, hora12, pad2 } from "@/lib/format";
import { CUPO_BAJO, POR_LINEA, POR_RANGO, type Pos } from "@/lib/pos/use-pos";

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
 * La primera columna es el botón que toma el rango entero. Va ahí y no debajo
 * con el texto completo porque debajo duplicaba la altura y obligaba a
 * recorrer la rejilla con el pulgar; al principio, el gesto queda al lado de lo
 * que afecta.
 *
 * CINCO POR FILA Y NO DIEZ. Con diez columnas la casilla sale de 28 px de
 * ancho —medido sobre los 351 px útiles de un iPhone SE, por debajo de los 44
 * que recomiendan iOS y Android—, y aquí un toque errado no es un
 * inconveniente: es vender otro número. Con cinco sube a 58.
 *
 * PERO EL BOTÓN ES POR DECENA, no por fila. El vendedor piensa la rejilla en
 * decenas —«del 20 al 29»— y tener que dar dos gestos para eso sobraba. El
 * botón ocupa el alto de sus dos filas, así que hay diez y no veinte, y
 * ninguna casilla se encoge por ello.
 */
function Rejilla({ pos }: { pos: Pos }) {
  const decenas = Array.from({ length: 100 / POR_RANGO }, (_, i) => i);
  /** Cuántas filas de cinco caben en una decena: dos. */
  const FILAS = POR_RANGO / POR_LINEA;

  return (
    <div className="mt-3">
      {/*
        EL INTERRUPTOR VA ARRIBA DE LA REJILLA, no abajo: es lo que decide qué
        hace el siguiente toque, y decidirlo después de haber tocado no serviría
        de nada.
      */}
      <button
        type="button"
        onClick={pos.alternarModoVarios}
        aria-pressed={pos.modoVarios}
        className={cn(
          "flex items-center gap-[10px] w-full px-[13px] py-[11px] rounded-campo text-meta font-medium text-left border mb-2",
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
        Marcar varios números
      </button>

      <div className="text-micro text-secundario mb-2">
        {pos.modoVarios
          ? "Toque los números que quiera; se marcan sin preguntar. Al terminar, ponga el valor una sola vez."
          : "Toque un número y diga cuánto. El rango pregunta por la decena entera."}
      </div>

      {/*
        La barra sólo aparece con algo marcado: un botón de «poner valor» sin
        números que cobrar no tiene nada que hacer ocupando sitio.
      */}
      {pos.modoVarios && pos.seleccion.length > 0 && (
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={pos.cobrarSeleccion}
            className="flex-1 border-0 bg-acento text-white rounded-pos py-[13px] text-pos font-semibold cursor-pointer"
          >
            Poner valor a {pos.seleccion.length}{" "}
            {pos.seleccion.length === 1 ? "número" : "números"}
          </button>
          <button
            type="button"
            onClick={pos.limpiarSeleccion}
            className="border border-borde-campo bg-superficie text-cuerpo rounded-pos px-4 py-[13px] text-meta font-medium cursor-pointer"
          >
            Limpiar
          </button>
        </div>
      )}

      <div className="flex flex-col gap-[2px]">
        {decenas.map((indice) => {
          const inicio = indice * POR_RANGO;
          const decena = Array.from({ length: POR_RANGO }, (_, i) => inicio + i);
          const conCupo = decena.filter((n) => pos.disponible[n] > 0);

          return (
            <div
              key={indice}
              className="grid gap-[2px]"
              style={{
                gridTemplateColumns: `46px repeat(${POR_LINEA}, minmax(0, 1fr))`,
              }}
            >
              {/*
                El botón ocupa las dos filas de su decena: `gridRow` con el
                número de filas que abarca. Así queda a la altura de lo que
                selecciona en vez de flotar junto a la primera mitad.
              */}
              <button
                onClick={() => pos.pedirMonto(decena)}
                disabled={conCupo.length === 0}
                aria-label={`Seleccionar del ${pad2(inicio)} al ${pad2(inicio + POR_RANGO - 1)}`}
                style={{ gridRow: `span ${FILAS}` }}
                className={cn(
                  "rounded-celda text-badge font-semibold border-[1.5px] leading-tight",
                  conCupo.length === 0
                    ? "bg-riel text-mudo border-riel"
                    : "bg-panel text-cuerpo border-borde-pos",
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
                    className={cn(
                      "h-[38px] rounded-celda text-pos font-semibold border-[1.5px] p-0",
                      dp <= 0
                        ? "bg-negativo-fondo text-negativo-texto border-negativo-borde"
                        : marcado
                          // Marcado gana al semáforo de cupo: mientras se
                          // eligen números, lo que importa es cuáles van.
                          ? "bg-acento text-white border-acento"
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
