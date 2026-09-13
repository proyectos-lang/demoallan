"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Wallet, X } from "lucide-react";

import {
  anularAbono,
  deudaDe,
  registrarAbono,
  type AbonoVendedor,
  type DeudaVendedor,
} from "@/app/(admin)/liquidacion/acciones";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt } from "@/lib/format";

/** Sólo dígitos y un punto. Un importe no admite otra cosa. */
const limpiar = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/**
 * Pagar saldos anteriores: todo de una vez, o abonando a cuenta.
 *
 * LAS DOS FORMAS DE COBRAR, EN UN SOLO SITIO
 * ------------------------------------------
 * El vendedor trae los 900 que debe, o trae 400 y el resto la semana que
 * viene. Hasta ahora sólo se podía lo primero: un pago menor cerraba la deuda
 * igual y la diferencia quedaba como ajuste, o sea perdonada. El dinero de un
 * abono entraba sin constancia.
 *
 * ABONAR NO CIERRA NADA. Baja el pendiente y el resto sigue debiéndose y
 * apareciendo. Cerrar los sorteos es otro gesto —el corte— y se ofrece aquí
 * mismo, pero sólo cuando la cuenta ya está en cero: cerrar con deuda viva es
 * perdonarla, y eso merece su propia pantalla y su motivo.
 *
 * LA FECHA ES LA DEL PAGO, no la del registro. Si entregó el viernes y esto se
 * teclea el lunes, va el viernes: es la fecha con la que él cuadra su cuenta.
 */
export function PagarSaldos({
  vendedorId,
  vendedor,
  /** Lo que la pantalla cree que debe. La base lo recalcula al abrir. */
  pendiente,
  hoy,
  variante = "boton",
}: {
  vendedorId: string;
  vendedor: string;
  pendiente: number;
  /** Hoy en Honduras, como tope del selector de fecha. */
  hoy: string;
  /** `fila` es la versión compacta para una tabla. */
  variante?: "boton" | "fila";
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [deuda, setDeuda] = useState<DeudaVendedor | null>(null);
  const [abonos, setAbonos] = useState<AbonoVendedor[]>([]);
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [cargando, iniciarCarga] = useTransition();
  const [enviando, iniciarEnvio] = useTransition();

  const cargar = () =>
    iniciarCarga(async () => {
      const r = await deudaDe(vendedorId);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setDeuda(r.deuda);
      setAbonos(r.abonos);
      // El campo viene con lo que falta: el caso corriente es que pague todo,
      // y quien vaya a abonar menos sólo tiene que corregir una cifra.
      setMonto(r.deuda.pendiente > 0 ? String(r.deuda.pendiente) : "");
    });

  useEffect(() => {
    if (!abierto) return;
    setError("");
    setAviso("");
    setFecha(hoy);
    setNota("");
    cargar();
    // `cargar` se redefine en cada render; depender de ella recargaría en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, vendedorId, hoy]);

  const montoNum = Number(monto) || 0;
  const falta = deuda ? deuda.pendiente : 0;
  const quedaria = Math.max(0, falta - montoNum);
  const pasaDeLaDeuda = montoNum > falta + 0.004;

  const guardar = () => {
    iniciarEnvio(async () => {
      const r = await registrarAbono(vendedorId, montoNum, fecha, nota);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso(r.mensaje);
      setNota("");
      setError("");
      cargar();
      router.refresh();
    });
  };

  const quitar = (id: string) => {
    iniciarEnvio(async () => {
      const r = await anularAbono(id, "corrección");
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso("");
      cargar();
      router.refresh();
    });
  };

  return (
    <>
      {variante === "fila" ? (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          title={`Cobrar a ${vendedor}`}
          aria-label={`Cobrar saldos anteriores a ${vendedor}`}
          className="inline-flex items-center gap-[5px] text-label text-acento font-medium py-1 hover:underline"
        >
          <Wallet size={13} strokeWidth={2} absoluteStrokeWidth />
          cobrar
        </button>
      ) : (
        <Boton onClick={() => setAbierto(true)} disabled={pendiente <= 0}>
          Pagar saldos anteriores
        </Boton>
      )}

      <Modal
        abierto={abierto}
        onCerrar={() => setAbierto(false)}
        eyebrow="Saldos anteriores"
        titulo="Cobrar lo pendiente"
        subtitulo={vendedor}
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setAbierto(false)} disabled={enviando}>
              Cerrar
            </Boton>
            <Boton
              onClick={guardar}
              disabled={enviando || cargando || montoNum <= 0 || pasaDeLaDeuda}
            >
              {enviando ? "Guardando…" : montoNum >= falta && falta > 0 ? "Registrar el pago" : "Registrar el abono"}
            </Boton>
          </>
        }
      >
        {cargando && !deuda ? (
          <p className="text-meta text-secundario m-0">Cargando la cuenta…</p>
        ) : !deuda ? null : (
          <div className="flex flex-col gap-4">
            {/* La cuenta, en tres cifras. Lo que debía, lo que ya entregó y lo
                que falta — que es la única que se va a teclear. */}
            <div className="rounded-card bg-riel px-4 py-3 flex flex-col gap-2">
              <Renglon
                etiqueta={`Debe · ${deuda.sorteos} ${deuda.sorteos === 1 ? "sorteo" : "sorteos"}`}
                valor={fmt(deuda.deuda)}
              />
              {deuda.abonado > 0 && (
                <Renglon etiqueta="Ya entregó a cuenta" valor={`− ${fmt(deuda.abonado)}`} />
              )}
              <div className="border-t border-borde pt-2">
                <Renglon etiqueta="Le falta" valor={fmt(deuda.pendiente)} fuerte />
              </div>
              {deuda.desde && (
                <p className="text-label text-mudo m-0">
                  Sorteos del {fechaLarga(deuda.desde)}
                  {deuda.hasta && deuda.hasta !== deuda.desde ? ` al ${fechaLarga(deuda.hasta)}` : ""}.
                </p>
              )}
            </div>

            {deuda.pendiente <= 0 ? (
              <p className="text-meta text-positivo-texto bg-positivo-fondo rounded-card px-3 py-2 m-0 leading-[1.5]">
                Está al día: ya entregó todo lo que debía. Cierre los sorteos con el corte de
                la semana para que dejen de aparecer.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <CampoModal etiqueta="Entrega (L)">
                    <input
                      value={monto}
                      onChange={(e) => {
                        setMonto(limpiar(e.target.value));
                        setError("");
                        setAviso("");
                      }}
                      inputMode="decimal"
                      autoFocus
                      className={`${CLASE_CONTROL_MODAL} text-right tabular-nums`}
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
                  </CampoModal>
                </div>

                {/*
                  Lo que va a pasar, dicho antes de confirmar. Es la diferencia
                  entre abonar y pagar, y se ve en cuanto se teclea la cifra en
                  vez de descubrirse después.
                */}
                {pasaDeLaDeuda ? (
                  <p className="text-meta text-negativo m-0">
                    Son más de los {fmt(falta)} que debe. Si entregó de más, ciérrelo con un
                    corte, que deja constancia del motivo.
                  </p>
                ) : montoNum > 0 ? (
                  <p
                    className={cn(
                      "text-meta rounded-card px-3 py-2 m-0 leading-[1.5]",
                      quedaria > 0
                        ? "text-ambar-texto bg-ambar-fila-sucia"
                        : "text-positivo-texto bg-positivo-fondo",
                    )}
                  >
                    {quedaria > 0 ? (
                      <>
                        Abono a cuenta: le quedarían <strong>{fmt(quedaria)}</strong> por pagar,
                        que seguirán apareciendo hasta que los entregue.
                      </>
                    ) : (
                      <>Queda al día. Los sorteos se cierran con el corte de la semana.</>
                    )}
                  </p>
                ) : null}

                <CampoModal etiqueta="Nota (opcional)" anchoCompleto>
                  <input
                    value={nota}
                    onChange={(e) => setNota(e.target.value.slice(0, 200))}
                    placeholder="Por ejemplo: entregó en la oficina"
                    maxLength={200}
                    className={CLASE_CONTROL_MODAL}
                  />
                </CampoModal>
              </>
            )}

            {aviso && (
              <p className="text-meta text-positivo-texto bg-positivo-fondo rounded-card px-3 py-2 m-0">
                {aviso}
              </p>
            )}

            {/* Lo ya entregado, para poder quitar un dedazo. */}
            {abonos.length > 0 && (
              <div className="flex flex-col gap-[6px]">
                <span className="text-eyebrow font-semibold tracking-seccion text-secundario">
                  ENTREGAS A CUENTA
                </span>
                {abonos.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-3 text-meta border-b border-fondo pb-[6px] last:border-0"
                  >
                    <span className="text-secundario whitespace-nowrap">
                      {fechaLarga(a.fechaPago)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-mudo">{a.nota ?? ""}</span>
                    <span className="tabular-nums text-cuerpo">{fmt(a.monto)}</span>
                    <button
                      type="button"
                      onClick={() => quitar(a.id)}
                      disabled={enviando}
                      aria-label={`Quitar el abono de ${fmt(a.monto)}`}
                      className="flex-none p-1 text-mudo hover:text-negativo"
                    >
                      <X size={13} strokeWidth={2.4} absoluteStrokeWidth />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function Renglon({
  etiqueta,
  valor,
  fuerte,
}: {
  etiqueta: string;
  valor: string;
  fuerte?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <span className={cn("text-meta", fuerte ? "text-cuerpo font-medium" : "text-secundario")}>
        {etiqueta}
      </span>
      <span
        className={cn(
          "tabular-nums whitespace-nowrap",
          fuerte ? "text-h2 font-semibold tracking-sutil" : "text-meta text-cuerpo",
        )}
      >
        {valor}
      </span>
    </div>
  );
}
