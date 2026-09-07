"use client";

import { useEffect, useState, useTransition } from "react";
import { Printer } from "lucide-react";

import { TicketImpreso } from "@/components/pos/ticket-impreso";
import { Boton } from "@/components/ui/boton";
import { Modal } from "@/components/ui/modal";
import {
  reimprimirTicket,
  type ResultadoReimpresion,
} from "@/app/(vendedor)/mi-dia/reimpresion";

/** Lo que se está mirando: el resultado en su variante buena. */
type Cargado = Extract<ResultadoReimpresion, { ok: true }>;

/**
 * Volver a sacar la tirilla de una venta del historial.
 *
 * POR QUÉ HAY VISTA PREVIA Y NO SE IMPRIME DE UN CLIC
 * ---------------------------------------------------
 * Porque en un historial las filas se parecen entre sí —misma hora, montos
 * cercanos— y el clic equivocado se paga en papel y en confusión: dos tirillas
 * distintas en el mostrador y un cliente que no sabe cuál es la suya. Con la
 * previa, el vendedor confirma que es la venta que busca ANTES de gastar rollo.
 *
 * Es además el mismo gesto que ya conoce del recibo tras vender: allí también
 * ve la tirilla a tamaño real y decide si la manda a la impresora.
 *
 * REIMPRIMIR NO REGISTRA NADA
 * ---------------------------
 * La acción sólo lee. Se dice también en la pantalla, bajo el botón, porque el
 * miedo a duplicar una venta ya apareció una vez en boca de un vendedor y no
 * se despeja solo.
 */
export function ReimprimirTicket({ folio }: { folio: string }) {
  const [abierto, setAbierto] = useState(false);
  const [datos, setDatos] = useState<Cargado | null>(null);
  const [error, setError] = useState("");
  const [cargando, iniciar] = useTransition();
  /** Sube en cada petición de impresión; es lo que dispara el efecto. */
  const [pedido, setPedido] = useState(0);

  useEffect(() => {
    /*
     * `window.print()` va en un efecto y no en el `onClick`.
     *
     * Antes de imprimir hay que RENDERIZAR lo que se va a imprimir: la hoja se
     * cuelga de `document.body` con un portal, y en el mismo gesto del clic
     * todavía no está en el árbol. Llamarlo ahí sacaría la hoja anterior —o
     * ninguna—, que es el tipo de fallo que sólo se descubre con el papel en
     * la mano. Es el mismo motivo por el que el recibo de venta lo hace así.
     */
    if (pedido === 0) return;
    window.print();
  }, [pedido]);

  const abrir = () => {
    setAbierto(true);
    setError("");
    setDatos(null);
    iniciar(async () => {
      const r = await reimprimirTicket(folio);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setDatos(r);
    });
  };

  const cerrar = () => {
    setAbierto(false);
    setDatos(null);
    setError("");
  };

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        title={`Reimprimir la tirilla del ticket ${folio}`}
        aria-label={`Reimprimir la tirilla del ticket ${folio}`}
        className="inline-flex items-center gap-[5px] text-label text-acento font-medium py-1"
      >
        <Printer size={13} strokeWidth={2} absoluteStrokeWidth />
        tirilla
      </button>

      <Modal
        abierto={abierto}
        onCerrar={cerrar}
        eyebrow={folio}
        titulo="Reimprimir tirilla"
        subtitulo="Vuelve a sacar el mismo comprobante. No registra una venta nueva."
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={cerrar}>
              Cerrar
            </Boton>
            <Boton onClick={() => setPedido((p) => p + 1)} disabled={!datos}>
              <span className="inline-flex items-center gap-2">
                <Printer size={15} strokeWidth={2} absoluteStrokeWidth />
                Imprimir
              </span>
            </Boton>
          </>
        }
      >
        {cargando && !datos && (
          <p className="text-meta text-secundario m-0">Buscando el ticket…</p>
        )}

        {datos && (
          <div className="flex flex-col items-center gap-3">
            {/* Un ticket anulado se imprime igual —quien reclama necesita el
                papel justo para eso— pero se avisa antes, no después. */}
            {datos.anulado && (
              <p className="w-full text-meta text-negativo bg-negativo-fondo rounded-card px-3 py-2 m-0">
                Esta venta está <strong>anulada</strong>. La tirilla se puede imprimir, pero
                el ticket no juega ni paga premio.
              </p>
            )}

            {/* A tamaño real: lo que se ve es lo que va a salir. */}
            <TicketImpreso
              modo="pantalla"
              tickets={[datos.ticket]}
              sorteo={datos.sorteo}
              vendedor={datos.vendedor}
            />

            <p className="text-label text-mudo text-center m-0">
              Es una copia del comprobante que ya existe: no crea una venta nueva ni
              descuenta cupo.
            </p>
          </div>
        )}
      </Modal>

      {/*
        La hoja que sale por la impresora.

        Sólo existe mientras el modal está abierto: colgarla siempre pondría en
        `document.body` una hoja por cada fila del historial, y al imprimir
        cualquier cosa saldrían todas.
      */}
      {abierto && datos && (
        <TicketImpreso
          modo="impresion"
          tickets={[datos.ticket]}
          sorteo={datos.sorteo}
          vendedor={datos.vendedor}
        />
      )}
    </>
  );
}
