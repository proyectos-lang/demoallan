"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";

import type { TicketRegistrado } from "@/app/(admin)/punto-de-venta/acciones";
import { TicketImpreso } from "@/components/pos/ticket-impreso";
import { cn } from "@/lib/cn";
import { fmt, hora12, pad2 } from "@/lib/format";
import type { EstadoSorteoPos, Pos, SorteoPos } from "@/lib/pos/use-pos";

/**
 * Piezas que comparten la vista de escritorio y la de móvil.
 *
 * Las dos vistas son disposiciones distintas del mismo estado, no dos
 * productos: todo lo que se ve igual en ambas vive aquí, para que un cambio de
 * criterio —el color del semáforo de cupo, el texto del recibo— no haya que
 * hacerlo dos veces y quede a medias una.
 */

const ETIQUETA_ESTADO: Record<EstadoSorteoPos, string> = {
  programado: "SIN ABRIR",
  abierto: "EN VENTA",
  cerrado: "CERRADO",
  liquidado: "LIQUIDADO",
};

export function PildoraEstado({ estado }: { estado: EstadoSorteoPos }) {
  return (
    <span
      className={cn(
        "inline-block px-[9px] py-[2px] rounded-chip text-th font-semibold",
        estado === "abierto"
          ? "bg-positivo-fondo text-positivo-texto"
          : estado === "liquidado"
            ? "bg-acento-suave text-acento-fuerte"
            : "bg-chip text-cuerpo",
      )}
    >
      {ETIQUETA_ESTADO[estado]}
    </span>
  );
}

/** El semáforo de cupo. El texto y el color los decide el hook. */
export function BannerCupo({ pos, className }: { pos: Pos; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-banner px-[13px] py-[11px] text-tabla font-medium leading-[1.4]",
        pos.banner.clase,
        className,
      )}
    >
      {pos.banner.texto}
    </div>
  );
}

/**
 * Aviso de que se está registrando fuera de hora.
 *
 * Sólo lo ve quien puede hacerlo. Se pinta bien visible a propósito: registrar
 * sobre un sorteo cerrado —y más aún sobre uno liquidado, donde el número
 * ganador ya se conoce— no debería poder pasar por descuido.
 */
export function AvisoFueraDeHora({ pos }: { pos: Pos }) {
  if (!pos.cerrada || !pos.datos.puedeForzar) return null;

  const liquidado = pos.datos.sorteo.estado === "liquidado";

  return (
    <div className="rounded-banner bg-ambar-fondo text-ambar-texto px-[13px] py-[11px] text-tabla font-medium leading-[1.45]">
      Registro fuera de horario.{" "}
      {liquidado
        ? "Este sorteo ya está liquidado y su número ganador se conoce: el ticket recalcula la liquidación del vendedor y queda marcado en auditoría."
        : "La venta de este sorteo ya cerró; el ticket queda marcado como forzado y con su usuario en auditoría."}
    </div>
  );
}

/** Selector de sorteo. No aparece si sólo hay uno que elegir. */
export function SelectorSorteo({
  sorteos,
  actual,
  onElegir,
  className,
}: {
  sorteos: SorteoPos[];
  actual: SorteoPos;
  onElegir: (id: string) => void;
  className?: string;
}) {
  if (sorteos.length < 2) return null;

  return (
    <select
      value={actual.id}
      onChange={(e) => onElegir(e.target.value)}
      className={cn(
        "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie",
        className,
      )}
      aria-label="Sorteo destino"
    >
      {sorteos.map((s) => (
        <option key={s.id} value={s.id}>
          {hora12(s.hora)} · {ETIQUETA_ESTADO[s.estado].toLowerCase()}
        </option>
      ))}
    </select>
  );
}

/** Una línea del ticket en curso, con su premio potencial y la cruz de quitar. */
export function LineaTicket({
  numero,
  monto,
  factor,
  onQuitar,
}: {
  numero: number;
  monto: number;
  factor: number;
  onQuitar: () => void;
}) {
  return (
    <div className="flex items-center gap-[11px] bg-superficie border border-riel rounded-pos px-3 py-[10px]">
      <span className="w-9 text-pos-xl font-semibold">{pad2(numero)}</span>
      <span className="flex-1 text-micro text-secundario">
        premio si acierta {fmt(monto * factor)}
      </span>
      <span className="text-h2 font-semibold">{fmt(monto, false)}</span>
      <button
        onClick={onQuitar}
        className="border-0 bg-transparent text-negativo text-exito leading-none px-1 cursor-pointer"
        aria-label={`Quitar línea ${pad2(numero)}`}
      >
        ×
      </button>
    </div>
  );
}

/** La lista del ticket que se está tecleando. */
export function TicketEnCurso({ pos }: { pos: Pos }) {
  return (
    <>
      <div className="text-eyebrow font-semibold tracking-ticket text-secundario mb-2">
        TICKET EN CURSO · {pos.carrito.length}{" "}
        {pos.carrito.length === 1 ? "LÍNEA" : "LÍNEAS"}
      </div>
      {pos.carrito.length === 0 ? (
        <div className="border border-dashed border-borde-punteado rounded-pos p-[18px] text-center text-meta text-mudo">
          Sin líneas todavía
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {pos.carrito.map((l, i) => (
            <LineaTicket
              key={i}
              numero={l.numero}
              monto={l.monto}
              factor={pos.vendedor?.factor_pago ?? 0}
              onQuitar={() => pos.quitarLinea(i)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Los tickets ya cerrados que esperan la confirmación.
 *
 * Se muestran resumidos —número de líneas y total— y no desglosados: quien
 * atiende una cola necesita saber cuántos lleva y por cuánto, no releer cada
 * apuesta. Para corregir uno se quita entero y se vuelve a teclear.
 */
export function ListaTanda({ pos }: { pos: Pos }) {
  if (pos.tanda.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="text-eyebrow font-semibold tracking-ticket text-secundario mb-2">
        TANDA · {pos.tanda.length} {pos.tanda.length === 1 ? "TICKET" : "TICKETS"} SIN
        REGISTRAR
      </div>
      <div className="flex flex-col gap-2">
        {pos.tanda.map((t, i) => (
          <div
            key={i}
            className="flex items-center gap-[11px] bg-panel border border-borde rounded-pos px-3 py-[10px]"
          >
            <span className="w-9 text-tabla font-semibold text-secundario">#{i + 1}</span>
            <span className="flex-1 text-micro text-secundario">
              {t.lineas.length} {t.lineas.length === 1 ? "línea" : "líneas"} ·{" "}
              {t.lineas.map((l) => pad2(l.numero)).join(" · ")}
            </span>
            <span className="text-h2 font-semibold">{fmt(t.total, false)}</span>
            <button
              onClick={() => pos.quitarTicket(i)}
              className="border-0 bg-transparent text-negativo text-exito leading-none px-1 cursor-pointer"
              aria-label={`Quitar ticket ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * El comprobante de lo registrado.
 *
 * Una tanda es lo que compra UNA persona, así que sus tickets se entregan
 * juntos: el botón grande imprime todos. El de cada fila existe para el caso
 * feo —se atascó el papel, salió en blanco— en el que hace falta repetir uno
 * solo sin volver a sacar el resto.
 *
 * La impresión es OPCIONAL. Un vendedor sin impresora anexada cierra la venta
 * con «Nueva venta» y no se entera de que esto existe.
 */
export function Recibo({ pos }: { pos: Pos }) {
  const recibo = pos.recibo;

  /*
   * Qué se manda al papel: todos los tickets o uno solo.
   *
   * `window.print()` se llama desde un efecto y no desde el `onClick` porque
   * antes de imprimir hay que RENDERIZAR lo que se va a imprimir. Llamarlo en
   * el mismo gesto sacaría el recibo anterior —o ninguno—, que es justo el
   * tipo de fallo que sólo se descubre con el papel en la mano.
   */
  const [aImprimir, setAImprimir] = useState<TicketRegistrado[] | null>(null);

  useEffect(() => {
    if (!aImprimir) return;

    const limpiar = () => setAImprimir(null);
    window.addEventListener("afterprint", limpiar, { once: true });
    window.print();

    return () => window.removeEventListener("afterprint", limpiar);
  }, [aImprimir]);

  if (!recibo || !pos.vendedor) return null;

  const varios = recibo.tickets.length > 1;

  return (
    <div className="flex flex-col items-center gap-4">
      {aImprimir && (
        <TicketImpreso
          tickets={aImprimir}
          sorteo={pos.datos.sorteo}
          vendedor={pos.vendedor}
        />
      )}

      <span className="w-16 h-16 rounded-full bg-positivo-fondo text-positivo-vivo text-rapida font-semibold flex items-center justify-center">
        ✓
      </span>
      <span className="text-exito font-semibold">
        {varios ? `${recibo.tickets.length} tickets registrados` : "Venta registrada"}
      </span>

      <div className="w-full border border-dashed border-borde-punteado rounded-pos p-4">
        <div className="text-center text-th font-semibold tracking-th text-secundario">
          LOTERÍA EL DIARIO
        </div>
        <div className="text-center text-label text-mudo mt-1">
          Sorteo {hora12(pos.datos.sorteo.hora)}
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {recibo.tickets.map((t) => (
            <div
              key={t.folio}
              className="flex items-center gap-3 border-t border-borde-punteado pt-2"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-meta text-secundario truncate">{t.folio}</span>
                <span className="block text-label text-mudo">
                  {t.lineas.map((l) => pad2(l.numero)).join(" · ")}
                </span>
              </span>
              <span className="text-tabla font-semibold">{fmt(t.total, false)}</span>
              <button
                onClick={() => setAImprimir([t])}
                className="text-label text-acento font-medium px-1"
              >
                imprimir
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-between border-t border-borde-punteado mt-3 pt-2 text-tabla font-semibold">
          <span>TOTAL</span>
          <span>{fmt(recibo.total, false)}</span>
        </div>
      </div>

      <div className="flex gap-[10px] w-full">
        <button
          onClick={() => pos.setRecibo(null)}
          className="flex-1 border-0 bg-acento text-white rounded-pos py-4 text-pos font-semibold cursor-pointer"
        >
          Nueva venta
        </button>
        <button
          onClick={() => setAImprimir(recibo.tickets)}
          className="flex items-center gap-2 border border-borde-campo bg-superficie text-tinta rounded-pos px-5 py-4 text-pos font-semibold cursor-pointer"
        >
          <Printer size={17} strokeWidth={2} absoluteStrokeWidth />
          {varios ? `Imprimir ${recibo.tickets.length}` : "Imprimir"}
        </button>
      </div>
    </div>
  );
}
