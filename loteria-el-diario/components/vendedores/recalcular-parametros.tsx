"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  impactoRecalculo,
  recalcularParametros,
  type ImpactoRecalculo,
} from "@/app/(admin)/vendedores/acciones";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt } from "@/lib/format";

/** Un vendedor al que se le acaba de cambiar la comisión o el factor. */
export type Recalculable = {
  id: string;
  codigo: string;
  nombre: string;
  /** En porcentaje, como se teclea en la tabla. */
  comision: number;
  factorPago: number;
  /** Lo que tenía antes, para poder decir de dónde viene. */
  comisionAntes: number;
  factorAntes: number;
};

/**
 * Preguntar si el cambio de comisión o factor se aplica también hacia atrás.
 *
 * POR QUÉ SE PREGUNTA Y NO SE HACE SOLO
 * -------------------------------------
 * Cada venta congela la comisión que regía al registrarse. Por omisión eso es
 * lo correcto: si cambiar el porcentaje reescribiera el pasado, un corte ya
 * firmado dejaría de cuadrar con lo que se le entregó al vendedor.
 *
 * Pero cuando el cambio se acordó por la mañana y se tecleó por la tarde, lo
 * correcto es lo contrario — la jornada entera debía ir al porcentaje nuevo. Y
 * sólo quien hizo el trato sabe cuál de los dos casos es.
 *
 * LO QUE SE ENSEÑA ANTES DE CONFIRMAR
 * -----------------------------------
 * Cuántos sorteos entran, cuánto se mueve la comisión en lempiras y —lo que de
 * verdad importa— cuántos de esos sorteos YA SE PAGARON. Recalcular uno pagado
 * deja la liquidación diciendo algo distinto del papel con el que se entregó
 * el dinero, y eso hay que verlo antes, no descubrirlo después.
 */
export function RecalcularParametros({
  vendedor,
  hoy,
  onCerrar,
}: {
  /** Nulo mientras no hay nada que preguntar. */
  vendedor: Recalculable | null;
  /** Hoy en Honduras, como tope del selector de fecha. */
  hoy: string;
  onCerrar: () => void;
}) {
  const router = useRouter();
  const [desde, setDesde] = useState(hoy);
  const [impacto, setImpacto] = useState<ImpactoRecalculo | null>(null);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [consultando, iniciarConsulta] = useTransition();
  const [enviando, iniciarEnvio] = useTransition();

  // Al abrir, la fecha arranca en hoy: el caso corriente es «lo de esta
  // jornada debía ir al nuevo porcentaje».
  useEffect(() => {
    if (!vendedor) return;
    setDesde(hoy);
    setImpacto(null);
    setError("");
    setAviso("");
  }, [vendedor, hoy]);

  // Cada vez que cambia la fecha se vuelve a preguntar qué pasaría. Sin esto
  // habría que confirmar para enterarse, que es justo lo que se quiere evitar.
  useEffect(() => {
    if (!vendedor || !desde) return;
    iniciarConsulta(async () => {
      const r = await impactoRecalculo(vendedor.id, desde, vendedor.comision, vendedor.factorPago);
      if (!r.ok) {
        setError(r.mensaje);
        setImpacto(null);
        return;
      }
      setError("");
      setImpacto(r.impacto);
    });
    // `impactoRecalculo` es estable; depender de más reconsultaría en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendedor, desde]);

  const aplicar = () => {
    if (!vendedor) return;
    iniciarEnvio(async () => {
      const r = await recalcularParametros(
        vendedor.id,
        desde,
        vendedor.comision,
        vendedor.factorPago,
      );
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso(r.mensaje);
      router.refresh();
    });
  };

  if (!vendedor) return null;

  const cambioComision = vendedor.comision !== vendedor.comisionAntes;
  const cambioFactor = vendedor.factorPago !== vendedor.factorAntes;
  const nada = impacto !== null && impacto.sorteos === 0;
  const diferencia = impacto ? impacto.comisionAhora - impacto.comisionAntes : 0;

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      eyebrow={`${vendedor.codigo} · ${vendedor.nombre}`}
      titulo="¿Aplicar también a lo ya registrado?"
      subtitulo={
        [
          cambioComision
            ? `comisión ${vendedor.comisionAntes}% → ${vendedor.comision}%`
            : "",
          cambioFactor ? `factor ${vendedor.factorAntes} → ${vendedor.factorPago}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      }
      error={error}
      pie={
        aviso ? (
          <Boton onClick={onCerrar}>Listo</Boton>
        ) : (
          <>
            <Boton variante="ghost" onClick={onCerrar} disabled={enviando}>
              No, sólo de aquí en adelante
            </Boton>
            <Boton onClick={aplicar} disabled={enviando || consultando || nada}>
              {enviando ? "Recalculando…" : "Sí, recalcular"}
            </Boton>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {aviso ? (
          <p className="text-meta text-positivo-texto bg-positivo-fondo rounded-card px-3 py-2 m-0 leading-[1.5]">
            {aviso}
          </p>
        ) : (
          <>
            <p className="text-meta text-secundario m-0 leading-[1.5]">
              Lo ya vendido conserva la comisión que tenía al registrarse. Si el cambio se
              acordó antes de teclearlo, aquí se aplica hacia atrás.
            </p>

            <CampoModal etiqueta="Recalcular desde" anchoCompleto>
              <input
                type="date"
                value={desde}
                max={hoy}
                onChange={(e) => setDesde(e.target.value)}
                className={CLASE_CONTROL_MODAL}
              />
            </CampoModal>

            {consultando && !impacto && (
              <p className="text-meta text-secundario m-0">Mirando qué cambiaría…</p>
            )}

            {impacto && (
              <div className="rounded-card bg-riel px-4 py-3 flex flex-col gap-2">
                {nada ? (
                  <p className="text-meta text-secundario m-0">
                    No hay nada registrado desde esa fecha. Pruebe con una anterior.
                  </p>
                ) : (
                  <>
                    <Renglon
                      etiqueta={`${impacto.sorteos} ${impacto.sorteos === 1 ? "sorteo" : "sorteos"}`}
                      valor={
                        impacto.desdeReal ? `desde el ${fechaLarga(impacto.desdeReal)}` : ""
                      }
                    />
                    <Renglon etiqueta="Venta" valor={fmt(impacto.venta)} />
                    <Renglon
                      etiqueta="Comisión"
                      valor={`${fmt(impacto.comisionAntes)} → ${fmt(impacto.comisionAhora)}`}
                    />
                    {impacto.premiosAntes !== impacto.premiosAhora && (
                      <Renglon
                        etiqueta="Premios pagados"
                        valor={`${fmt(impacto.premiosAntes)} → ${fmt(impacto.premiosAhora)}`}
                      />
                    )}
                    <div className="border-t border-borde pt-2">
                      <Renglon
                        etiqueta={diferencia >= 0 ? "Le corresponde más" : "Le corresponde menos"}
                        valor={fmt(Math.abs(diferencia))}
                        fuerte
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {/*
              Lo ya pagado se recalcula igual —así se pidió— pero se dice
              antes, no después: la liquidación de esos sorteos dejará de
              coincidir con el papel que firmó el vendedor, y quien confirma
              tiene que saberlo para poder ir a hablar con él.
            */}
            {impacto && impacto.pagados > 0 && (
              <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
                <strong>
                  {impacto.pagados} {impacto.pagados === 1 ? "sorteo ya está" : "sorteos ya están"}{" "}
                  pagados
                </strong>{" "}
                en un corte. Se recalculan igual, pero el corte guarda las cifras con las que
                se le entregó el dinero: después de esto, esa liquidación y ese papel dirán
                cosas distintas.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
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
          "tabular-nums whitespace-nowrap text-right",
          fuerte ? "text-h2 font-semibold tracking-sutil" : "text-meta text-cuerpo",
        )}
      >
        {valor}
      </span>
    </div>
  );
}
