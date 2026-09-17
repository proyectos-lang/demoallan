"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Plus } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { fmt } from "@/lib/format";
import {
  anularSaldoInicial,
  cargarSaldoInicial,
} from "@/app/(admin)/liquidacion/acciones";

/**
 * Cargar el saldo con el que un vendedor entra al sistema.
 *
 * QUÉ RESUELVE
 * ------------
 * Los vendedores que se dan de alta no son negocios nuevos: llevan años
 * vendiendo y traen una cuenta abierta de la libreta anterior. El «saldo
 * anterior» de la liquidación se calcula sumando los sorteos viejos que no han
 * pagado, y uno recién creado no tiene ninguno — su arrastre es cero y no
 * había forma de decir que debe 4.500.
 *
 * POSITIVO O NEGATIVO, Y SE ELIGE CON BOTONES
 * -------------------------------------------
 * Un saldo negativo es dinero que la casa le debe al vendedor: cerró la
 * temporada anterior con premios por encima de su venta. Es un caso real, pero
 * escribirlo con un signo menos delante se presta a que el signo se pierda —o
 * a que alguien lo teclee sin querer— y el error se descubre cuando la cuenta
 * sale al revés. Por eso el sentido se elige con dos botones que dicen
 * literalmente quién le debe a quién, y el monto se escribe siempre positivo.
 *
 * SE COBRA COMO CUALQUIER DEUDA VIEJA
 * -----------------------------------
 * Una vez cargado, suma al arrastre. Los dos botones que ya existen siguen
 * valiendo: «cobrar» admite un abono a cuenta y «saldar» cierra la deuda
 * entera. No hay un tercer gesto que aprender.
 *
 * SE PUEDE QUITAR, PERO NO BORRAR
 * -------------------------------
 * Si se cargó mal, se quita y se vuelve a cargar. Lo quitado queda registrado:
 * cuando alguien pregunte por qué el arrastre de un vendedor cambió, la
 * respuesta tiene que estar en algún sitio.
 */
export function SaldoInicial({
  vendedorId,
  vendedor,
  /** El saldo de apertura vivo, si ya tiene uno. */
  actual,
  hoy,
  variante = "fila",
}: {
  vendedorId: string;
  vendedor: string;
  actual?: { id: string; monto: number; vigenteDesde: string } | null;
  /** Hoy en Honduras, como tope del selector de fecha. */
  hoy: string;
  variante?: "fila" | "boton";
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [sentido, setSentido] = useState<"debe" | "le-deben">("debe");
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [nota, setNota] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  useEffect(() => {
    if (!abierto) return;
    setSentido(actual && actual.monto < 0 ? "le-deben" : "debe");
    setMonto(actual ? String(Math.abs(actual.monto)) : "");
    setFecha(actual?.vigenteDesde ?? hoy);
    setNota("");
    setMotivo("");
    setError("");
  }, [abierto, actual, hoy]);

  const cantidad = Number(monto) || 0;
  const conSigno = sentido === "debe" ? cantidad : -cantidad;

  const confirmar = () =>
    iniciar(async () => {
      setError("");
      const r = await cargarSaldoInicial(vendedorId, conSigno, fecha, nota);
      if (!r.ok) return setError(r.mensaje);
      setAbierto(false);
      router.refresh();
    });

  const quitar = () =>
    iniciar(async () => {
      if (!actual) return;
      setError("");
      const r = await anularSaldoInicial(actual.id, motivo);
      if (!r.ok) return setError(r.mensaje);
      setAbierto(false);
      router.refresh();
    });

  return (
    <>
      {variante === "fila" ? (
        <button
          type="button"
          onClick={() => setAbierto(true)}
          title={
            actual
              ? `Saldo inicial de ${vendedor}: ${fmt(actual.monto)}`
              : `Cargar el saldo con el que entró ${vendedor}`
          }
          className="text-label text-acento font-medium py-1"
        >
          {actual ? "saldo inicial" : "+ saldo inicial"}
        </button>
      ) : (
        <Boton variante="ghost" onClick={() => setAbierto(true)}>
          <Plus size={15} strokeWidth={2} absoluteStrokeWidth />
          Agregar saldo pendiente
        </Boton>
      )}

      <Modal
        abierto={abierto}
        onCerrar={() => setAbierto(false)}
        eyebrow={vendedor}
        titulo={actual ? "Saldo inicial cargado" : "Agregar saldo pendiente"}
        subtitulo={
          actual
            ? "Ya tiene un saldo de apertura. Para cambiarlo hay que quitarlo y cargar otro."
            : "Lo que este vendedor ya debía antes de entrar al sistema, traído de la libreta anterior."
        }
        error={error}
        pie={
          actual ? (
            <>
              <Boton variante="ghost" onClick={() => setAbierto(false)} disabled={enviando}>
                Cerrar
              </Boton>
              <Boton onClick={quitar} disabled={enviando}>
                {enviando ? "Quitando…" : "Quitar este saldo"}
              </Boton>
            </>
          ) : (
            <>
              <Boton variante="ghost" onClick={() => setAbierto(false)} disabled={enviando}>
                Cancelar
              </Boton>
              <Boton onClick={confirmar} disabled={enviando || cantidad <= 0}>
                {enviando ? "Cargando…" : "Cargar saldo"}
              </Boton>
            </>
          )
        }
      >
        {actual ? (
          <div className="flex flex-col gap-3">
            <div className="bg-panel rounded-card px-4 py-3">
              <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                {actual.monto > 0 ? "EL VENDEDOR ARRASTRA" : "LA CASA LE DEBE"}
              </span>
              <span className="block text-h1 font-semibold tracking-titular mt-1 tabular-nums">
                {fmt(Math.abs(actual.monto))}
              </span>
              <span className="block text-label text-secundario mt-1">
                Cuenta desde el {actual.vigenteDesde}
              </span>
            </div>

            <p className="text-label text-secundario m-0">
              Este saldo ya suma al arrastre, así que se cobra con los botones de siempre:
              «cobrar» para un abono a cuenta, «saldar» para cerrarlo entero.
            </p>

            <CampoModal etiqueta="Por qué se quita (opcional)">
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="Se cargó mal, el saldo real era otro"
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/*
              El sentido, con botones y no con un signo menos: escribir «-4500»
              se presta a que el signo se pierda al copiar o a que alguien lo
              teclee sin querer, y el error se descubre cuando la cuenta sale
              al revés.
            */}
            <CampoModal etiqueta="Quién le debe a quién">
              <div className="flex gap-2">
                {(
                  [
                    ["debe", "El vendedor debe"],
                    ["le-deben", "La casa le debe"],
                  ] as const
                ).map(([id, texto]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSentido(id)}
                    aria-pressed={sentido === id}
                    className={`flex-1 rounded-campo border px-3 py-[9px] text-meta font-medium ${
                      sentido === id
                        ? "bg-acento border-acento text-white"
                        : "bg-superficie border-borde-campo text-cuerpo"
                    }`}
                  >
                    {texto}
                  </button>
                ))}
              </div>
            </CampoModal>

            <CampoModal etiqueta="Cuánto">
              <input
                inputMode="decimal"
                value={monto}
                onChange={(e) => setMonto(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0"
                className={`${CLASE_CONTROL_MODAL} tabular-nums`}
              />
            </CampoModal>

            <CampoModal etiqueta="Desde cuándo cuenta">
              <input
                type="date"
                value={fecha}
                max={hoy}
                onChange={(e) => setFecha(e.target.value)}
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>

            <CampoModal etiqueta="Nota (opcional)">
              <input
                value={nota}
                onChange={(e) => setNota(e.target.value)}
                placeholder="Saldo de la libreta al 31 de agosto"
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>

            {cantidad > 0 && (
              <div className="bg-panel rounded-card px-4 py-3">
                <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                  QUEDARÁ COMO
                </span>
                <span
                  className={`block text-h2 font-semibold tracking-sutil mt-1 tabular-nums ${
                    conSigno < 0 ? "text-negativo" : ""
                  }`}
                >
                  {fmt(conSigno)}
                </span>
                <span className="block text-label text-secundario mt-1">
                  {conSigno > 0
                    ? "Se sumará a lo que el vendedor arrastra."
                    : "Se descontará del saldo: es dinero que la casa le debe."}
                </span>
              </div>
            )}

            {/*
              Lo que esto NO es, dicho antes de confirmar. Es la confusión
              natural —«si cargo 4.500, ¿sube la venta?»— y la respuesta importa
              para que nadie lo use para cuadrar un informe.
            */}
            <p className="text-label text-secundario m-0">
              Esto no es una venta: no aparece en informes de venta ni en el tablero. Sólo
              entra en el saldo que el vendedor arrastra.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
