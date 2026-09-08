"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { anularVenta } from "@/app/(admin)/informe/anulacion";

/**
 * Anular una venta desde el detalle.
 *
 * POR QUÉ HAY CONFIRMACIÓN
 * ------------------------
 * Las filas del detalle se parecen entre sí —mismo vendedor, misma hora,
 * montos cercanos— y es justo la pantalla a la que se baja cuando algo no
 * cuadra, o sea con prisa. El modal repite el ticket entero antes de hacer
 * nada: folio, vendedor, sorteo, los números jugados y el total. Si lo que se
 * lee ahí no es lo que se buscaba, todavía se puede cancelar.
 *
 * EL MOTIVO ES OPCIONAL
 * ---------------------
 * Se ofrece porque queda guardado en la bitácora junto a quién anuló y cuándo,
 * y es lo que contesta dentro de un mes «¿por qué falta esta venta?». Pero no
 * se exige: obligar a escribir algo produce «x» y «asdf», que ocupan el mismo
 * sitio que un motivo de verdad y no dicen nada.
 *
 * SE AVISA DE LO QUE VA A PASAR
 * -----------------------------
 * Si el sorteo está liquidado, el modal dice que la liquidación del vendedor
 * se va a rehacer. No es un detalle técnico: cambia lo que ese vendedor tiene
 * que entregar, y quien anula debería saberlo antes y no descubrirlo al
 * cuadrar la semana.
 */
export function AnularVenta({
  ticketId,
  folio,
  vendedor,
  sorteo,
  jugada,
  total,
  estado,
}: {
  ticketId: string;
  folio: string;
  vendedor: string;
  sorteo: string;
  jugada: string;
  total: string;
  /** El del sorteo: cambia lo que hay que advertir. */
  estado: string;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  const cerrar = () => {
    setAbierto(false);
    setMotivo("");
    setError("");
  };

  const anular = () => {
    iniciar(async () => {
      const r = await anularVenta(ticketId, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      cerrar();
      // La acción revalida, pero este componente es cliente y no se entera
      // solo: sin el refresco la fila seguiría igual junto al aviso de que se
      // anuló.
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Anular la venta ${folio}`}
        aria-label={`Anular la venta ${folio}`}
        className="inline-flex items-center gap-[5px] text-label text-negativo font-medium py-1 hover:underline"
      >
        <Trash2 size={13} strokeWidth={2} absoluteStrokeWidth />
        anular
      </button>

      <Modal
        abierto={abierto}
        onCerrar={cerrar}
        eyebrow={folio}
        titulo="Anular esta venta"
        subtitulo="La venta deja de contar y su cupo vuelve. Queda registrada en auditoría, no se borra."
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={cerrar} disabled={enviando}>
              Cancelar
            </Boton>
            <Boton onClick={anular} disabled={enviando}>
              {enviando ? "Anulando…" : "Anular venta"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* El ticket entero, para poder comprobar que es el que se busca. */}
          <div className="bg-panel border border-borde rounded-card px-4 py-3 flex flex-col gap-2">
            <Dato etiqueta="VENDEDOR" valor={vendedor} />
            <Dato etiqueta="SORTEO" valor={sorteo} />
            <div>
              <span className="block text-eyebrow font-semibold tracking-seccion text-mudo">
                NÚMEROS JUGADOS
              </span>
              {/* Monoespaciada, como en el detalle y como en el papel. */}
              <span className="block font-mono text-micro text-cuerpo mt-[3px] break-words">
                {jugada}
              </span>
            </div>
            <Dato etiqueta="TOTAL" valor={total} />
          </div>

          {estado === "liquidado" && (
            <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
              Este sorteo ya está <strong>liquidado</strong>. Al anular, la liquidación de
              este vendedor se rehace: su venta, su comisión y lo que tiene que entregar
              cambian. Si ese sorteo ya se le pagó en un corte, la anulación se rechaza.
            </p>
          )}

          <CampoModal etiqueta="Motivo (opcional)" anchoCompleto>
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value.slice(0, 200))}
              placeholder="Por ejemplo: registrada dos veces"
              maxLength={200}
              className={CLASE_CONTROL_MODAL}
              autoFocus
            />
            <span className="block text-label text-mudo mt-[5px]">
              Queda guardado con su nombre y la hora. Es lo que contesta dentro de un mes
              por qué falta esta venta.
            </span>
          </CampoModal>
        </div>
      </Modal>
    </>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <span className="block text-eyebrow font-semibold tracking-seccion text-mudo">
        {etiqueta}
      </span>
      <span className="block text-tabla text-cuerpo mt-[2px]">{valor}</span>
    </div>
  );
}
