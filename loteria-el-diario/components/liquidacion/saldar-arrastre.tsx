"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { fechaLarga, fmt, hora12 } from "@/lib/format";
import {
  detalleArrastre,
  saldarArrastre,
  type SorteoArrastre,
} from "@/app/(admin)/liquidacion/acciones";

/**
 * Cerrar lo que un vendedor arrastra de semanas anteriores.
 *
 * QUÉ SE SALDA
 * ------------
 * TODO el arrastre de una vez. No es un número suelto: son sorteos concretos
 * de semanas pasadas que nunca entraron en un corte, y el modal los enseña uno
 * a uno antes de cerrar nada — quien va a dar por pagada una deuda tiene
 * derecho a ver de qué sorteos sale.
 *
 * LA ENTREGA PUEDE NO CUADRAR
 * ---------------------------
 * El campo viene relleno con el saldo calculado, pero se puede cambiar: un
 * pago en la calle se cierra con un acuerdo —se redondea, se perdona un
 * resto—. La diferencia se ve en pantalla EN CUANTO se teclea, y si la hay se
 * exige el motivo: un descuadre sin explicación es lo que nadie sabe
 * justificar tres meses después.
 *
 * LA FECHA ES LA DEL PAGO
 * -----------------------
 * Si el vendedor pagó el viernes y esto se registra el lunes, va el viernes.
 * El sistema guarda aparte cuándo se tecleó, así que las dos cosas quedan.
 */
export function SaldarArrastre({
  vendedorId,
  vendedor,
  arrastre,
  desde,
  hoy,
}: {
  vendedorId: string;
  vendedor: string;
  /** Lo que dice la tabla. La base lo recalcula al confirmar. */
  arrastre: number;
  /** Primer día de la semana que se está viendo: el arrastre es lo anterior. */
  desde: string;
  /** Hoy en Honduras, como tope del selector de fecha. */
  hoy: string;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [sorteos, setSorteos] = useState<SorteoArrastre[] | null>(null);
  const [saldo, setSaldo] = useState(arrastre);
  const [entrega, setEntrega] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [cargando, iniciarCarga] = useTransition();
  const [enviando, iniciarEnvio] = useTransition();

  // El detalle se pide al abrir: son los sorteos que se van a cerrar, y el
  // saldo que devuelve la base manda sobre el que traía la tabla.
  useEffect(() => {
    if (!abierto) return;
    iniciarCarga(async () => {
      const r = await detalleArrastre(vendedorId, desde);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setSorteos(r.sorteos);
      setSaldo(r.saldo);
      setEntrega(r.saldo.toFixed(2));
    });
  }, [abierto, vendedorId, desde]);

  const cerrar = () => {
    setAbierto(false);
    setSorteos(null);
    setEntrega("");
    setMotivo("");
    setFecha(hoy);
    setError("");
  };

  const valor = parseFloat(entrega);
  const ajuste = Number.isFinite(valor) ? Number((valor - saldo).toFixed(2)) : 0;
  const faltaMotivo = ajuste !== 0 && motivo.trim() === "";

  const guardar = () => {
    iniciarEnvio(async () => {
      const r = await saldarArrastre(vendedorId, desde, valor, fecha, motivo);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      cerrar();
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setAbierto(true)}
        title={`Saldar lo que ${vendedor} arrastra de semanas anteriores`}
        className="text-label text-acento font-medium hover:underline"
      >
        saldar
      </button>

      <Modal
        abierto={abierto}
        onCerrar={cerrar}
        eyebrow={vendedor}
        titulo="Saldar semanas anteriores"
        subtitulo="Cierra todos los sorteos pendientes de antes de esta semana. El arrastre queda en cero."
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={cerrar} disabled={enviando}>
              Cancelar
            </Boton>
            <Boton
              onClick={guardar}
              disabled={enviando || !sorteos?.length || !Number.isFinite(valor) || faltaMotivo}
            >
              {enviando ? "Registrando…" : "Registrar pago"}
            </Boton>
          </>
        }
      >
        {cargando && !sorteos && (
          <p className="text-meta text-secundario m-0">Buscando lo pendiente…</p>
        )}

        {sorteos?.length === 0 && (
          <p className="text-meta text-secundario m-0">
            Este vendedor no arrastra nada de semanas anteriores.
          </p>
        )}

        {sorteos && sorteos.length > 0 && (
          <div className="flex flex-col gap-4">
            {/* Qué se va a cerrar. Sin esto, «saldar el arrastre» es dar por
                pagada una cifra sin ver de dónde sale. */}
            <div className="bg-panel border border-borde rounded-card overflow-hidden">
              <div className="px-4 py-2 border-b border-fondo">
                <span className="text-eyebrow font-semibold tracking-seccion text-mudo">
                  {sorteos.length} {sorteos.length === 1 ? "SORTEO PENDIENTE" : "SORTEOS PENDIENTES"}
                </span>
              </div>
              <div className="max-h-[190px] overflow-y-auto">
                <table className="w-full border-collapse text-meta">
                  <tbody>
                    {sorteos.map((s, i) => (
                      <tr key={`${s.fecha}-${s.hora}-${i}`} className="border-b border-fondo last:border-0">
                        <td className="px-4 py-[6px] text-cuerpo">{fechaLarga(s.fecha)}</td>
                        <td className="px-3 py-[6px] text-secundario">{hora12(s.hora)}</td>
                        <td
                          className={`px-4 py-[6px] text-right ${
                            s.saldo < 0 ? "text-negativo" : "text-cuerpo"
                          }`}
                        >
                          {fmt(s.saldo, false)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between px-4 py-[9px] bg-tinte border-t border-riel">
                <span className="text-meta font-semibold">
                  {saldo < 0 ? "LA CASA LE PAGA" : "EL VENDEDOR ENTREGA"}
                </span>
                <span className="text-meta font-semibold">{fmt(Math.abs(saldo))}</span>
              </div>
            </div>

            <div className="grid gap-x-[18px] gap-y-[14px] [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
              <CampoModal etiqueta="Cuánto entregó (L)">
                <input
                  value={entrega}
                  onChange={(e) => {
                    // Dígitos, un punto y un signo menos al principio: el
                    // saldo puede ser negativo cuando la casa es la que paga.
                    setEntrega(e.target.value.replace(/[^\d.-]/g, "").slice(0, 12));
                    setError("");
                  }}
                  inputMode="decimal"
                  className={CLASE_CONTROL_MODAL}
                />
              </CampoModal>

              <CampoModal etiqueta="Fecha del pago">
                <input
                  type="date"
                  value={fecha}
                  max={hoy}
                  onChange={(e) => setFecha(e.target.value)}
                  className={CLASE_CONTROL_MODAL}
                />
                <span className="block text-label text-mudo mt-[5px]">
                  El día en que se recibió el dinero, no el de hoy si fue antes.
                </span>
              </CampoModal>
            </div>

            {/*
              La diferencia se ve mientras se teclea, no al confirmar. Quien
              redondea a la baja debería saber en el momento cuánto está
              perdonando, no descubrirlo cuando ya está registrado.
            */}
            {ajuste !== 0 && Number.isFinite(valor) && (
              <div className="text-meta bg-ambar-fila-sucia text-ambar-texto rounded-card px-3 py-2 leading-[1.5]">
                La entrega no coincide con el saldo: {ajuste > 0 ? "sobran" : "faltan"}{" "}
                <strong>{fmt(Math.abs(ajuste))}</strong>. Se registra como ajuste, y el
                arrastre queda igualmente en cero.
              </div>
            )}

            <CampoModal etiqueta={ajuste !== 0 ? "Motivo del ajuste" : "Motivo (opcional)"}>
              <input
                value={motivo}
                onChange={(e) => {
                  setMotivo(e.target.value.slice(0, 200));
                  setError("");
                }}
                placeholder={
                  ajuste !== 0 ? "Por ejemplo: se redondeó el resto" : "Opcional"
                }
                maxLength={200}
                className={CLASE_CONTROL_MODAL}
              />
              {faltaMotivo && (
                <span className="block text-label text-negativo mt-[5px]">
                  Con diferencia hay que decir por qué: es lo que se pregunta después.
                </span>
              )}
            </CampoModal>

            <p className="text-label text-mudo m-0 leading-[1.5]">
              Al registrarlo, estos {sorteos.length}{" "}
              {sorteos.length === 1 ? "sorteo queda pagado" : "sorteos quedan pagados"} y dejan
              de sumar en el saldo anterior. Queda en auditoría con su nombre y la hora.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
