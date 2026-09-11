"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { anularMiVenta } from "@/app/(vendedor)/mi-dia/anulacion";

/**
 * El vendedor quita una venta suya.
 *
 * POR QUÉ HAY CONFIRMACIÓN
 * ------------------------
 * Porque no se deshace. Anular devuelve el cupo y la venta deja de contar,
 * pero el ticket queda marcado para siempre — no hay un botón que lo traiga de
 * vuelta. Un toque accidental en una lista de veinte filas parecidas no puede
 * costar eso, así que el modal repite el folio y el total antes de nada.
 *
 * SÓLO APARECE DONDE SE PUEDE
 * ---------------------------
 * En las ventas de un sorteo todavía abierto, y sólo si no está ya anulada.
 * Ofrecerlo en las demás para que la base rechace la mitad enseñaría al
 * vendedor a esperar errores; y quien aprende a esperar errores deja de
 * leerlos.
 *
 * Eso es comodidad de pantalla, no la regla: la regla la pone la base, que
 * rechaza fuera de un sorteo abierto aunque alguien llame por otra vía.
 */
export function AnularMiVenta({
  ticketId,
  folio,
  sorteo,
  total,
}: {
  ticketId: string;
  folio: string;
  sorteo: string;
  total: string;
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
      const r = await anularMiVenta(ticketId, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      cerrar();
      // La acción revalida, pero este componente es cliente y no se entera
      // solo: sin el refresco la fila seguiría igual tras anularla.
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Quitar la venta ${folio}`}
        aria-label={`Quitar la venta ${folio}`}
        className="inline-flex items-center gap-[5px] text-label text-negativo font-medium py-1"
      >
        <Trash2 size={13} strokeWidth={2} absoluteStrokeWidth />
        quitar
      </button>

      <Modal
        abierto={abierto}
        onCerrar={cerrar}
        eyebrow={folio}
        titulo="Quitar esta venta"
        subtitulo="Los números vuelven a estar disponibles. No se puede deshacer."
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={cerrar} disabled={enviando}>
              Cancelar
            </Boton>
            <Boton onClick={anular} disabled={enviando}>
              {enviando ? "Quitando…" : "Quitar la venta"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="bg-panel border border-borde rounded-card px-4 py-3 flex flex-col gap-2">
            <Dato etiqueta="SORTEO" valor={sorteo} />
            <Dato etiqueta="TOTAL" valor={total} />
          </div>

          <CampoModal etiqueta="Motivo (opcional)" anchoCompleto>
            <input
              value={motivo}
              onChange={(e) => {
                setMotivo(e.target.value.slice(0, 200));
                setError("");
              }}
              placeholder="Por ejemplo: número equivocado"
              maxLength={200}
              className={CLASE_CONTROL_MODAL}
              autoFocus
            />
          </CampoModal>

          <p className="text-label text-mudo m-0 leading-[1.5]">
            Sólo se pueden quitar ventas del sorteo que sigue abierto. Una vez cerrado,
            avise a administración.
          </p>
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
