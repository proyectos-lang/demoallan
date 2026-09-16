"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Pencil, Plus, Printer, X } from "lucide-react";

import { TicketImpreso } from "@/components/pos/ticket-impreso";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { fmt } from "@/lib/format";
import { corregirMiVenta } from "@/app/(vendedor)/mi-dia/correccion";
import {
  reimprimirTicket,
  type ResultadoReimpresion,
} from "@/app/(vendedor)/mi-dia/reimpresion";

/** Una línea en edición. El monto se guarda como texto: se está tecleando. */
type Fila = { numero: string; monto: string };

/** La tirilla ya cargada, lista para mandar a la impresora. */
type Cargado = Extract<ResultadoReimpresion, { ok: true }>;

/**
 * El vendedor corrige una venta suya y se lleva la tirilla nueva.
 *
 * POR QUÉ LA IMPRESIÓN NO ES UN PASO APARTE
 * -----------------------------------------
 * Porque corregir sin reimprimir deja el problema peor que antes. El cliente
 * tiene en la mano un papel que dice 07:100 y el sistema pasa a decir 07:250:
 * dos verdades distintas sobre la misma venta, y la del papel es la que se
 * presenta a cobrar. Si el vendedor tuviera que acordarse de darle al botón de
 * la tirilla, el día que no se acuerde es el día que hay una discusión en el
 * mostrador.
 *
 * Así que al confirmar, esta pantalla no se cierra: pasa a enseñar el
 * comprobante nuevo con el botón de imprimir delante. El gesto termina cuando
 * el papel sale, no cuando la base dice que sí.
 *
 * LA TIRILLA SE PIDE AL SERVIDOR, NO SE ARMA AQUÍ
 * -----------------------------------------------
 * Se podría pintar con lo que el vendedor acaba de teclear y sería instantáneo.
 * Pero entonces el papel diría lo que él quiso registrar, no lo que quedó
 * registrado, y son cosas distintas cuando la base ajusta algo. Se vuelve a
 * leer con `reimprimirTicket`, que es la misma vía por la que sale cualquier
 * copia: el papel dice lo que hay en la base o no sale.
 *
 * SÓLO APARECE CON EL SORTEO ABIERTO
 * ----------------------------------
 * Eso lo decide la fila del historial. Pero la regla de verdad no está en si
 * el botón se pinta —eso es comodidad— sino en `corregirMiVenta`, que
 * comprueba el estado del sorteo contra la base antes de tocar nada.
 */
export function CorregirMiVenta({
  ticketId,
  folio,
  sorteo,
  /** `07:100  42:250` — la jugada tal como la devuelve el historial. */
  jugada,
}: {
  ticketId: string;
  folio: string;
  sorteo: string;
  jugada: string;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  /** Cuando está puesto, la corrección ya se hizo y toca imprimir. */
  const [tirilla, setTirilla] = useState<Cargado | null>(null);
  const [resumen, setResumen] = useState("");
  /** Sube en cada petición de impresión; es lo que dispara el efecto. */
  const [pedido, setPedido] = useState(0);

  /*
   * Al abrir se parte la jugada en filas editables.
   *
   * Viene como `07:100  42:250` —el formato que ya pinta el historial— y se
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
    setTirilla(null);
    setResumen("");
  }, [abierto, jugada]);

  useEffect(() => {
    /*
     * `window.print()` va en un efecto y no en el `onClick`.
     *
     * Antes de imprimir hay que RENDERIZAR lo que se va a imprimir: la hoja se
     * cuelga de `document.body` con un portal, y en el mismo gesto del clic
     * todavía no está en el árbol. Es el mismo motivo por el que lo hacen así
     * el recibo de venta y la reimpresión.
     */
    if (pedido === 0) return;
    window.print();
  }, [pedido]);

  const cambiar = (i: number, campo: keyof Fila, valor: string) =>
    setFilas((f) => f.map((x, j) => (j === i ? { ...x, [campo]: valor } : x)));

  const quitar = (i: number) => setFilas((f) => f.filter((_, j) => j !== i));
  const agregar = () => setFilas((f) => [...f, { numero: "", monto: "" }]);

  const total = filas.reduce((a, f) => a + (Number(f.monto) || 0), 0);

  const confirmar = () =>
    iniciar(async () => {
      setError("");

      const lineas = filas
        .filter((f) => f.numero.trim() !== "" || f.monto.trim() !== "")
        .map((f) => ({ numero: Number(f.numero), monto: Number(f.monto) }));

      const r = await corregirMiVenta(ticketId, lineas, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }

      setResumen(r.mensaje);

      /*
       * Ya está corregida. Ahora la tirilla: si esta lectura fallara, la
       * corrección SIGUE HECHA —no se deshace por no poder imprimir— y hay que
       * decirlo tal cual, para que el vendedor sepa que el sistema ya cambió
       * aunque el papel no haya salido. Lo dice el aviso de abajo.
       */
      const t = await reimprimirTicket(folio);
      if (t.ok) setTirilla(t);
      else
        setError(
          `La venta quedó corregida, pero no se pudo cargar la tirilla: ${t.mensaje}. Use el botón «tirilla» de la fila.`,
        );

      // El historial y el cupo cambiaron.
      router.refresh();
    });

  const cerrar = () => {
    setAbierto(false);
    setTirilla(null);
    setResumen("");
    setError("");
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Corregir los números del ticket ${folio}`}
        aria-label={`Corregir los números del ticket ${folio}`}
        className="inline-flex items-center gap-[5px] text-label text-acento font-medium py-1"
      >
        <Pencil size={13} strokeWidth={2} absoluteStrokeWidth />
        corregir
      </button>

      <Modal
        abierto={abierto}
        onCerrar={cerrar}
        eyebrow={folio}
        titulo={tirilla ? "Tirilla corregida" : "Corregir la venta"}
        subtitulo={
          tirilla
            ? "Entréguele esta tirilla al cliente: la anterior ya no coincide."
            : `Sorteo de las ${sorteo}. Cambie los números o los montos.`
        }
        error={error}
        pie={
          tirilla ? (
            <>
              <Boton variante="ghost" onClick={cerrar}>
                Cerrar
              </Boton>
              <Boton onClick={() => setPedido((p) => p + 1)}>
                <span className="inline-flex items-center gap-2">
                  <Printer size={15} strokeWidth={2} absoluteStrokeWidth />
                  Imprimir
                </span>
              </Boton>
            </>
          ) : (
            <>
              <Boton variante="ghost" onClick={cerrar} disabled={enviando}>
                Cancelar
              </Boton>
              <Boton onClick={confirmar} disabled={enviando || filas.length === 0}>
                {enviando ? "Corrigiendo…" : "Corregir e imprimir"}
              </Boton>
            </>
          )
        }
      >
        {/* --- Ya corregida: el papel --- */}
        {tirilla ? (
          <div className="flex flex-col items-center gap-3">
            {resumen && (
              <p className="w-full text-meta text-positivo bg-positivo-fondo rounded-card px-3 py-2 m-0">
                {resumen}
              </p>
            )}

            <TicketImpreso
              modo="pantalla"
              tickets={[tirilla.ticket]}
              sorteo={tirilla.sorteo}
              vendedor={tirilla.vendedor}
            />

            <p className="text-label text-mudo text-center m-0">
              El folio es el mismo: es la misma venta corregida. La tirilla vieja dice
              otra cosa, así que conviene recogerla.
            </p>
          </div>
        ) : (
          /* --- Todavía editando --- */
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              {filas.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    inputMode="numeric"
                    value={f.numero}
                    onChange={(e) =>
                      cambiar(i, "numero", e.target.value.replace(/[^0-9]/g, "").slice(0, 2))
                    }
                    placeholder="00"
                    aria-label={`Número de la línea ${i + 1}`}
                    className={`${CLASE_CONTROL_MODAL} w-[72px] text-center tabular-nums`}
                  />
                  <span className="text-mudo text-meta">:</span>
                  <input
                    inputMode="decimal"
                    value={f.monto}
                    onChange={(e) =>
                      cambiar(i, "monto", e.target.value.replace(/[^0-9.]/g, ""))
                    }
                    placeholder="0"
                    aria-label={`Monto de la línea ${i + 1}`}
                    className={`${CLASE_CONTROL_MODAL} flex-1 tabular-nums`}
                  />
                  <button
                    type="button"
                    onClick={() => quitar(i)}
                    aria-label={`Quitar la línea ${i + 1}`}
                    className="w-[34px] h-[34px] flex-none inline-flex items-center justify-center rounded-campo border border-borde-campo bg-superficie text-secundario"
                  >
                    <X size={14} strokeWidth={2} absoluteStrokeWidth />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <button
                type="button"
                onClick={agregar}
                className="inline-flex items-center gap-[6px] text-meta text-acento font-medium"
              >
                <Plus size={14} strokeWidth={2} absoluteStrokeWidth />
                Añadir número
              </button>
              <span className="text-meta text-secundario">
                Total: <strong className="text-cuerpo">{fmt(total)}</strong>
              </span>
            </div>

            <CampoModal etiqueta="Por qué se corrige (opcional)">
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="El cliente dijo 250, no 25"
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>

            {/*
              La consecuencia real de esta pantalla, dicha antes de confirmar:
              el papel que el cliente tiene en la mano deja de valer. Por eso
              el botón dice «corregir e imprimir» y no sólo «corregir».
            */}
            <p className="text-label text-secundario m-0">
              Al corregir, la tirilla que ya entregó deja de coincidir. Se imprime una
              nueva con el mismo folio.
            </p>
          </div>
        )}
      </Modal>

      {/*
        La hoja que sale por la impresora.

        Sólo existe mientras hay tirilla cargada: colgarla siempre pondría en
        `document.body` una hoja por cada fila del historial, y al imprimir
        cualquier cosa saldrían todas.
      */}
      {abierto && tirilla && (
        <TicketImpreso
          modo="impresion"
          tickets={[tirilla.ticket]}
          sorteo={tirilla.sorteo}
          vendedor={tirilla.vendedor}
        />
      )}
    </>
  );
}
