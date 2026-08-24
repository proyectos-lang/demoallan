"use client";

import { createPortal } from "react-dom";

import type { TicketRegistrado } from "@/app/(admin)/punto-de-venta/acciones";
import { cn } from "@/lib/cn";
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
 * Se usa de dos formas y las dos importan:
 *
 *   · `modo="pantalla"` lo pinta dentro del recibo, a su ancho real. El
 *     vendedor ve exactamente lo que va a salir ANTES de gastar papel, y si
 *     algo falla se ve en la pantalla en vez de descubrirse con un rollo en
 *     blanco en la mano.
 *
 *   · `modo="impresion"` lo cuelga de `document.body` con un portal. Al
 *     imprimir hay que apagar todo lo demás —mandar la pantalla entera a un
 *     rollo de 58 mm son metros de papel en blanco—, y la regla que lo apaga
 *     mira hijos DIRECTOS de body. Por eso el portal: para ser uno de ellos.
 *
 * EL ANCHO vive en `--ticket-ancho` (`globals.css`), salvo en `@page`, donde
 * va literal porque el contexto de página no hereda variables.
 */
export function TicketImpreso({
  tickets,
  sorteo,
  vendedor,
  modo,
  soloFolio,
}: {
  tickets: TicketRegistrado[];
  sorteo: SorteoPos;
  vendedor: VendedorPos;
  modo: "pantalla" | "impresion";
  /** Si se pidió imprimir uno solo, el resto se omite del papel. */
  soloFolio?: string | null;
}) {
  if (tickets.length === 0) return null;

  const hoja = (
    <div
      data-impresion={modo === "impresion" ? "" : undefined}
      className={cn(modo === "impresion" ? "hoja-impresion" : "hoja-pantalla")}
    >
      {tickets.map((t) => (
        <article
          key={t.folio}
          className={cn(
            "ticket-impreso",
            soloFolio && t.folio !== soloFolio && "ticket-omitido",
          )}
        >
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
            <span />
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
    </div>
  );

  if (modo === "pantalla") return hoja;

  // El portal necesita `document`, que en el render del servidor no existe.
  if (typeof document === "undefined") return null;
  return createPortal(hoja, document.body);
}
