"use client";

import { createPortal } from "react-dom";

import type { TicketRegistrado } from "@/app/(admin)/punto-de-venta/acciones";
import {
  fechaHonduras,
  fechaLargaSinDia,
  fmt,
  hora12,
  horaHonduras12,
  pad2,
} from "@/lib/format";
import type { SorteoPos, VendedorPos } from "@/lib/pos/use-pos";

/**
 * El ticket en papel.
 *
 * CÓMO LLEGA A LA IMPRESORA
 * -------------------------
 * Por el diálogo de impresión del sistema: se pinta un recibo con hoja de
 * estilos de impresión y se llama a `window.print()`. En un handheld POS con
 * Android, la impresora del equipo aparece como servicio de impresión —sea el
 * del fabricante o el de RawBT—, así que no hace falta saber el modelo ni
 * hablar ESC/POS. Es lo que más dispositivos cubre; el precio es un toque de
 * más para elegir la impresora la primera vez.
 *
 * POR QUÉ VA EN UN PORTAL A `document.body`
 * -----------------------------------------
 * Al imprimir hay que apagar TODO lo demás: mandar la página entera a un rollo
 * de 58 mm son metros de papel en blanco. La regla que lo apaga vive en
 * `globals.css` y dice «oculta todo hijo directo de body que no sea el
 * recibo», y para que eso funcione el recibo tiene que ser, literalmente, un
 * hijo directo de body. De ahí el portal.
 *
 * EL ANCHO ESTÁ EN UNA SOLA VARIABLE, `--ticket-ancho` en `globals.css`.
 * Pasar de 58 a 80 mm es cambiar esa línea.
 */
export function TicketImpreso({
  tickets,
  sorteo,
  vendedor,
}: {
  tickets: TicketRegistrado[];
  sorteo: SorteoPos;
  vendedor: VendedorPos;
}) {
  // El portal necesita `document`, que en el render del servidor no existe.
  // No hace falta un estado de «ya monté»: este componente sólo se pinta
  // cuando alguien toca «Imprimir», y para entonces hace rato que hay
  // navegador. La guarda está por si algún día se renderiza antes.
  if (typeof document === "undefined" || tickets.length === 0) return null;

  /*
   * Sin cabecera de marca: el papel empieza en EMITIDO.
   *
   * El rollo de 58 mm es caro en líneas y el comprador ya sabe a quién le
   * compró — tiene al vendedor delante. Lo que necesita el papel es lo que no
   * se puede recordar: cuándo, a qué sorteo, qué números y cuánto.
   */
  return createPortal(
    <div data-impresion className="hoja-impresion" aria-hidden="true">
      {tickets.map((t) => (
        <article key={t.folio} className="ticket-impreso">
          {/*
            Dos tiempos distintos y los dos hacen falta.

            «EMITIDO» es cuando se hizo la venta —el dato que guarda la base, no
            el reloj del aparato— y es lo que resuelve un «yo compré antes del
            cierre». «SORTEO» es el juego al que va la apuesta. Confundirlos es
            fácil, así que van rotulados y separados.
          */}
          <div className="ticket-fila">
            <span>EMITIDO</span>
            {/*
              `fechaHonduras` y no los diez primeros caracteres del ISO: el
              timestamp viene en UTC, y a partir de las seis de la tarde en
              Honduras esos diez caracteres ya son del día siguiente. Un ticket
              vendido el lunes a las 19:00 se imprimiría con fecha de martes.
            */}
            <span>
              {fechaLargaSinDia(fechaHonduras(t.creadoEn))} {horaHonduras12(t.creadoEn)}
            </span>
          </div>

          <div className="ticket-fila ticket-fuerte">
            <span>SORTEO</span>
            <span>{hora12(sorteo.hora)}</span>
          </div>
          <div className="ticket-fila">
            <span></span>
            <span>{fechaLargaSinDia(sorteo.fecha)}</span>
          </div>

          <div className="ticket-fila">
            <span>VENDEDOR</span>
            <span>{vendedor.codigo}</span>
          </div>
          <div className="ticket-fila">
            <span>FOLIO</span>
            <span>{t.folio}</span>
          </div>

          <div className="ticket-linea" />

          <div className="ticket-fila ticket-encabezado">
            <span>NÚMERO</span>
            <span>VALOR</span>
          </div>

          {t.lineas.map((l, i) => (
            <div key={i} className="ticket-fila ticket-numero">
              <span>N.º {pad2(l.numero)}</span>
              <span>{fmt(l.monto)}</span>
            </div>
          ))}

          <div className="ticket-linea" />

          <div className="ticket-fila ticket-total">
            <span>TOTAL</span>
            <span>{fmt(t.total)}</span>
          </div>

          <div className="ticket-mensaje">¡Muchos éxitos con tus sorteos!</div>

          {/* Aire al final para que el corte no se coma la última línea. */}
          <div className="ticket-pie">&nbsp;</div>
        </article>
      ))}
    </div>,
    document.body,
  );
}
