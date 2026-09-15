"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Undo2 } from "lucide-react";

import {
  detalleCorte,
  reversarCorte,
  type SorteoDelCorte,
} from "@/app/(admin)/liquidacion/acciones";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt, hora12 } from "@/lib/format";

/**
 * Deshacer una liquidación: dejarla como si nunca se hubiera hecho.
 *
 * PARA QUÉ
 * --------
 * Se liquidó la semana equivocada, se marcó un sorteo de más, o llegó una
 * corrección después de cerrar. Sin esto, esos sorteos quedaban «pagados» para
 * siempre y no volvían a aparecer en la hoja del vendedor.
 *
 * QUÉ SE ENSEÑA ANTES DE CONFIRMAR
 * --------------------------------
 * Los sorteos que contenía, uno a uno. Revertir borra el corte y no se puede
 * rehacer tal cual —habría que volver a marcarlos a mano— así que hay que
 * poder comprobar que es el corte correcto antes de tocarlo, no después.
 *
 * Y se avisa de lo que no es evidente: si ese corte había absorbido abonos,
 * ese dinero vuelve a contar como entregado a cuenta. Sin liberarlos, lo que
 * el vendedor ya pagó desaparecería de la cuenta.
 */
export function ReversarCorte({
  corteId,
  vendedor,
  desde,
  hasta,
  sorteos,
  saldo,
}: {
  corteId: string;
  vendedor: string;
  desde: string;
  hasta: string;
  sorteos: number;
  saldo: number;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [detalle, setDetalle] = useState<SorteoDelCorte[] | null>(null);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [cargando, iniciarCarga] = useTransition();
  const [enviando, iniciarEnvio] = useTransition();

  // El detalle se pide al abrir: son los sorteos que van a volver a quedar
  // pendientes, y quien deshace tiene derecho a verlos antes.
  useEffect(() => {
    if (!abierto) return;
    setMotivo("");
    setError("");
    setAviso("");
    iniciarCarga(async () => {
      const r = await detalleCorte(corteId);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setDetalle(r.sorteos);
    });
  }, [abierto, corteId]);

  const reversar = () => {
    iniciarEnvio(async () => {
      const r = await reversarCorte(corteId, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso(r.mensaje);
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Reversar la liquidación del ${fechaLargaSinDia(desde)}`}
        aria-label={`Reversar la liquidación de ${vendedor} del ${fechaLargaSinDia(desde)}`}
        className="inline-flex items-center gap-[5px] text-label text-negativo font-medium py-1 hover:underline"
      >
        <Undo2 size={13} strokeWidth={2} absoluteStrokeWidth />
        reversar
      </button>

      <Modal
        abierto={abierto}
        onCerrar={() => setAbierto(false)}
        eyebrow={`${fechaLargaSinDia(desde)} — ${fechaLargaSinDia(hasta)}`}
        titulo="Reversar la liquidación"
        subtitulo={vendedor}
        error={error}
        pie={
          aviso ? (
            <Boton onClick={() => setAbierto(false)}>Listo</Boton>
          ) : (
            <>
              <Boton variante="ghost" onClick={() => setAbierto(false)} disabled={enviando}>
                Cancelar
              </Boton>
              <Boton onClick={reversar} disabled={enviando || cargando}>
                {enviando ? "Reversando…" : "Sí, deshacerla"}
              </Boton>
            </>
          )
        }
      >
        {aviso ? (
          <p className="text-meta text-positivo-texto bg-positivo-fondo rounded-card px-3 py-2 m-0 leading-[1.5]">
            {aviso}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
              Los <strong>{sorteos} {sorteos === 1 ? "sorteo" : "sorteos"}</strong> de esta
              liquidación volverán a estar pendientes, como si nunca se hubiera cerrado. El
              corte desaparece de su historial de pagos; queda en auditoría.
            </p>

            {cargando && !detalle && (
              <p className="text-meta text-secundario m-0">Cargando el detalle…</p>
            )}

            {detalle && detalle.length > 0 && (
              <div className="rounded-card border border-borde overflow-hidden">
                <div className="max-h-[260px] overflow-auto">
                  <table className="w-full border-collapse text-tabla">
                    <thead className="sticky top-0 bg-tinte">
                      <tr>
                        {["SORTEO", "VENTA", "COMISIÓN", "PREMIOS", "SALDO"].map((h, i) => (
                          <th
                            key={h}
                            className={cn(
                              "text-th font-semibold tracking-th text-secundario border-b border-riel py-[7px]",
                              i === 0 ? "text-left pl-3 pr-2" : "text-right px-2",
                            )}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detalle.map((s, i) => (
                        <tr key={`${s.fecha}-${s.hora}-${i}`}>
                          <td className="border-b border-fondo py-[6px] pl-3 pr-2 text-cuerpo whitespace-nowrap">
                            {fechaLargaSinDia(s.fecha)} · {hora12(s.hora)}
                          </td>
                          <td className="border-b border-fondo py-[6px] px-2 text-right tabular-nums">
                            {fmt(s.venta, false)}
                          </td>
                          <td className="border-b border-fondo py-[6px] px-2 text-right tabular-nums text-secundario">
                            {fmt(s.comision, false)}
                          </td>
                          <td className="border-b border-fondo py-[6px] px-2 text-right tabular-nums text-secundario">
                            {fmt(s.premios, false)}
                          </td>
                          <td
                            className={cn(
                              "border-b border-fondo py-[6px] px-2 text-right tabular-nums font-medium",
                              s.saldo < 0 && "text-negativo",
                            )}
                          >
                            {fmt(s.saldo, false)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 bg-tinte border-t border-riel flex justify-between items-baseline">
                  <span className="text-meta text-secundario">
                    {saldo >= 0 ? "El vendedor entregaba" : "La casa le entregaba"}
                  </span>
                  <span className="text-cta font-semibold tabular-nums">
                    {fmt(Math.abs(saldo))}
                  </span>
                </div>
              </div>
            )}

            <CampoModal etiqueta="Motivo (opcional)" anchoCompleto>
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value.slice(0, 200))}
                placeholder="Por ejemplo: se liquidó la semana equivocada"
                maxLength={200}
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>
          </div>
        )}
      </Modal>
    </>
  );
}
