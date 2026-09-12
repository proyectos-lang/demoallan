"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Pencil, Plus, X } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { fmt } from "@/lib/format";
import { editarVenta } from "@/app/(admin)/informe/edicion";

/** Una línea en edición. El monto se guarda como texto: se está tecleando. */
type Fila = { numero: string; monto: string };

/**
 * Corregir los números y montos de una venta registrada.
 *
 * QUÉ SE PUEDE CAMBIAR Y QUÉ NO
 * -----------------------------
 * Las líneas: números, montos, quitar y añadir. El FOLIO, el vendedor y el
 * sorteo no — es la misma venta corregida, no otra, y el cliente tiene una
 * tirilla con ese folio en la mano.
 *
 * LO QUE HAY QUE DECIR ANTES DE CONFIRMAR
 * ---------------------------------------
 * Que la tirilla impresa deja de coincidir. Es la consecuencia real de esta
 * pantalla y no se ve por ningún lado: quien corrige un monto en el sistema
 * sigue teniendo un papel en la calle que dice otra cosa. El aviso no lo
 * impide —a veces corregir es lo correcto— pero lo pone delante.
 *
 * La jugada anterior queda ENTERA en la auditoría, que es lo único que permite
 * reconstruir después qué decía esa tirilla.
 */
export function EditarVenta({
  ticketId,
  folio,
  vendedor,
  sorteo,
  /** `07:100  42:250` — la jugada tal como la devuelve el detalle. */
  jugada,
  estado,
}: {
  ticketId: string;
  folio: string;
  vendedor: string;
  sorteo: string;
  jugada: string;
  /** El del sorteo: cambia lo que hay que advertir. */
  estado: string;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  /*
   * Al abrir se parte la jugada en filas editables.
   *
   * Viene como `07:100  42:250` —el formato que ya pinta el detalle— y se
   * deshace aquí en vez de pedir las líneas al servidor: el dato ya está en la
   * pantalla, y un viaje más sólo añadiría una espera antes de poder teclear.
   */
  useEffect(() => {
    if (!abierto) return;
    setFilas(
      jugada
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((par) => {
          const [n, m] = par.split(":");
          return { numero: n ?? "", monto: m ?? "" };
        }),
    );
    setMotivo("");
    setError("");
  }, [abierto, jugada]);

  const cambiar = (i: number, campo: keyof Fila, valor: string) => {
    setFilas((f) => f.map((x, j) => (j === i ? { ...x, [campo]: valor } : x)));
    setError("");
  };

  const quitar = (i: number) => setFilas((f) => f.filter((_, j) => j !== i));
  const anadir = () => setFilas((f) => [...f, { numero: "", monto: "" }]);

  const lineas = filas
    .map((f) => ({ numero: parseInt(f.numero, 10), monto: parseFloat(f.monto) }))
    .filter((l) => Number.isInteger(l.numero) && Number.isFinite(l.monto));

  const total = lineas.reduce((a, l) => a + l.monto, 0);
  const completas = lineas.length === filas.length && filas.length > 0;

  const guardar = () => {
    iniciar(async () => {
      const r = await editarVenta(ticketId, lineas, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAbierto(false);
      // La acción revalida, pero este componente es cliente y no se entera
      // solo: sin el refresco la fila seguiría con la jugada vieja.
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Corregir la venta ${folio}`}
        aria-label={`Corregir la venta ${folio}`}
        className="inline-flex items-center gap-[5px] text-label text-acento font-medium py-1 hover:underline"
      >
        <Pencil size={13} strokeWidth={2} absoluteStrokeWidth />
        corregir
      </button>

      <Modal
        abierto={abierto}
        onCerrar={() => setAbierto(false)}
        eyebrow={folio}
        titulo="Corregir la venta"
        subtitulo={`${vendedor} · ${sorteo}`}
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setAbierto(false)} disabled={enviando}>
              Cancelar
            </Boton>
            <Boton onClick={guardar} disabled={enviando || !completas}>
              {enviando ? "Guardando…" : "Guardar la corrección"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/*
            El aviso va ARRIBA y siempre, no sólo con el sorteo liquidado: la
            tirilla del cliente deja de coincidir en todos los casos, y ésa es
            la consecuencia que nadie ve al teclear un monto nuevo.
          */}
          <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
            La tirilla que tiene el cliente <strong>dejará de coincidir</strong> con lo que
            diga el sistema. La jugada anterior queda en auditoría.
            {estado === "liquidado" && (
              <>
                {" "}
                Este sorteo ya está liquidado: la liquidación del vendedor se rehará, y si ya
                se le pagó en un corte la corrección se rechaza.
              </>
            )}
          </p>

          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[70px_1fr_32px] gap-2 text-eyebrow font-semibold tracking-seccion text-mudo">
              <span>NÚMERO</span>
              <span>MONTO (L)</span>
              <span />
            </div>

            {filas.map((f, i) => (
              <div key={i} className="grid grid-cols-[70px_1fr_32px] gap-2 items-center">
                <input
                  value={f.numero}
                  onChange={(e) =>
                    cambiar(i, "numero", e.target.value.replace(/\D/g, "").slice(0, 2))
                  }
                  inputMode="numeric"
                  placeholder="00"
                  className={`${CLASE_CONTROL_MODAL} text-center tabular-nums`}
                />
                <input
                  value={f.monto}
                  onChange={(e) =>
                    cambiar(i, "monto", e.target.value.replace(/[^\d.]/g, "").slice(0, 9))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className={`${CLASE_CONTROL_MODAL} text-right tabular-nums`}
                />
                <button
                  type="button"
                  onClick={() => quitar(i)}
                  aria-label={`Quitar el número ${f.numero || i + 1}`}
                  className="flex items-center justify-center p-1 text-mudo hover:text-negativo"
                >
                  <X size={15} strokeWidth={2.4} absoluteStrokeWidth />
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={anadir}
              className="inline-flex items-center gap-[6px] text-meta text-acento font-medium self-start mt-1"
            >
              <Plus size={14} strokeWidth={2.2} absoluteStrokeWidth />
              Añadir un número
            </button>
          </div>

          <div className="flex justify-between items-baseline border-t border-riel pt-3">
            <span className="text-tabla text-secundario">
              {filas.length} {filas.length === 1 ? "número" : "números"}
            </span>
            <span className="text-h2 font-semibold tracking-sutil tabular-nums">
              {fmt(total)}
            </span>
          </div>

          {!completas && filas.length > 0 && (
            <p className="text-meta text-negativo m-0">
              Hay líneas sin número o sin monto. Complételas o quítelas.
            </p>
          )}
          {filas.length === 0 && (
            <p className="text-meta text-negativo m-0">
              La venta tiene que quedar con al menos un número. Para dejarla sin nada,
              anúlela.
            </p>
          )}

          <CampoModal etiqueta="Motivo (opcional)" anchoCompleto>
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value.slice(0, 200))}
              placeholder="Por ejemplo: monto mal tecleado"
              maxLength={200}
              className={CLASE_CONTROL_MODAL}
            />
          </CampoModal>
        </div>
      </Modal>
    </>
  );
}
