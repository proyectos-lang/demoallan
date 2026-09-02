"use client";

import { useState, useTransition } from "react";

import { registrarCorte } from "@/app/(admin)/liquidacion/acciones";
import { BotonImprimir } from "@/components/liquidacion/boton-imprimir";
import {
  TablaSorteos,
  type FilaLiquidacion,
} from "@/components/liquidacion/tabla-sorteos";

export type { FilaLiquidacion };
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fmt } from "@/lib/format";

/**
 * La hoja semanal de un vendedor.
 *
 * CADA FILA ES UN SORTEO, y cada fila se marca por separado. Ése es el grano
 * que pide el pago parcial: «se liquidó lunes y martes» no siempre significa
 * dos días enteros — puede faltar el sorteo de la noche del martes porque el
 * vendedor todavía no había entregado. La casilla de la cabecera de cada día
 * marca los tres de golpe, que es el caso normal.
 *
 * Lo que se manda al servidor son los identificadores marcados; los totales de
 * abajo son una vista previa y se vuelven a calcular en la base.
 */
export function HojaLiquidacion({
  filas,
  vendedorId,
  vendedorNombre,
  desde,
  hasta,
  sinLiquidar,
  factor,
  comisionTasa,
  semana,
  yaPagados,
}: {
  filas: FilaLiquidacion[];
  vendedorId: string;
  vendedorNombre: string;
  desde: string;
  hasta: string;
  /** Sorteos del rango que aún no tienen número ganador. */
  sinLiquidar: number;
  /** Para la cabecera del papel: el factor y la comisión vigentes. */
  factor: number | null;
  comisionTasa: number | null;
  semana: number | null;
  /** Sorteos de esta semana ya cobrados: no salen en el papel, pero se dicen. */
  yaPagados: number;
}) {
  const [marcados, setMarcados] = useState<Set<string>>(
    () => new Set(filas.map((f) => f.liquidacionId)),
  );
  const [confirmando, setConfirmando] = useState(false);
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [pagando, iniciar] = useTransition();

  const elegidas = filas.filter((f) => marcados.has(f.liquidacionId));

  const total = elegidas.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      comision: a.comision + f.comision,
      premios: a.premios + f.premios,
      saldo: a.saldo + f.saldo,
    }),
    { venta: 0, comision: 0, premios: 0, saldo: 0 },
  );

  /*
   * UNA SOLA ACCIÓN, DOS DIRECCIONES.
   *
   * Una semana acaba de dos maneras: el vendedor entrega dinero, o la casa se
   * lo entrega a él porque los premios que pagó de su bolsillo superaron su
   * venta. Las dos son LIQUIDAR —cerrar la cuenta de esos sorteos— y por eso
   * el botón es uno: partirlo en «pagar» y «cobrar» obligaría a elegir antes
   * de mirar el signo, y quien elige mal registra el gesto contrario al que
   * hizo.
   *
   * Lo que SÍ cambia con el signo es el rótulo de la cifra, en la pantalla y
   * en el papel: un «total» a secas se lee mal en una de las dos direcciones.
   */
  const entregaElVendedor = total.saldo >= 0;
  const rotuloSaldo = entregaElVendedor ? "EL VENDEDOR ENTREGA" : "LA CASA LE PAGA";

  const alternar = (id: string) =>
    setMarcados((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const alternarDia = (delDia: FilaLiquidacion[]) => {
    const todosMarcados = delDia.every((f) => marcados.has(f.liquidacionId));
    setMarcados((s) => {
      const n = new Set(s);
      for (const f of delDia) {
        if (todosMarcados) n.delete(f.liquidacionId);
        else n.add(f.liquidacionId);
      }
      return n;
    });
  };

  const liquidar = () => {
    setError("");
    iniciar(async () => {
      const r = await registrarCorte(
        vendedorId,
        elegidas.map((f) => f.liquidacionId),
        desde,
        hasta,
        nota,
      );
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setConfirmando(false);
      setNota("");
      setAviso(r.mensaje);
    });
  };

  if (filas.length === 0) {
    return (
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-8 text-center">
        <p className="text-base text-cuerpo m-0">
          No queda nada por liquidar con <strong>{vendedorNombre}</strong> en esta semana.
        </p>
        {sinLiquidar > 0 && (
          <p className="text-meta text-secundario mt-2 mb-0">
            Quedan {sinLiquidar} {sinLiquidar === 1 ? "sorteo" : "sorteos"} de la semana sin
            liquidar: hasta que se les capture el número ganador no se pueden cerrar.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {aviso && (
        <div className="rounded-banner bg-positivo-fondo text-positivo-texto px-[13px] py-[11px] text-tabla font-medium">
          {aviso}
        </div>
      )}

      {sinLiquidar > 0 && (
        <div className="rounded-banner bg-ambar-fondo text-ambar-texto px-[13px] py-[11px] text-tabla font-medium leading-[1.45]">
          La semana no está completa: quedan {sinLiquidar}{" "}
          {sinLiquidar === 1 ? "sorteo" : "sorteos"} sin liquidar. Se puede cerrar lo que ya
          está y lo demás aparecerá aquí en cuanto se capture su número ganador.
        </div>
      )}

      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        <TablaSorteos filas={filas} seleccion={{ marcados, alternar, alternarDia }} />
      </div>

      {/* --- El cierre --- */}
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex flex-wrap gap-8 items-end justify-between">
        <div className="min-w-[280px]">
          <div className="text-eyebrow font-semibold tracking-seccion text-secundario mb-3">
            {elegidas.length} DE {filas.length} SORTEOS MARCADOS
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-x-8 gap-y-[6px] items-baseline">
            <span className="text-tabla text-cuerpo">Venta</span>
            <span className="text-tabla text-right font-medium">{fmt(total.venta, false)}</span>

            <span className="text-tabla text-cuerpo">
              Comisión <span className="text-label text-mudo">(le corresponde)</span>
            </span>
            <span className="text-tabla text-right font-medium">{fmt(total.comision, false)}</span>

            <span className="text-tabla text-cuerpo">
              Premios <span className="text-label text-mudo">(los pagó él)</span>
            </span>
            <span className="text-tabla text-right font-medium">{fmt(total.premios, false)}</span>
          </div>

          <div className="border-t border-riel mt-3 pt-3 flex items-baseline justify-between gap-8">
            <span className="text-eyebrow font-semibold tracking-seccion text-secundario">
              {rotuloSaldo}
            </span>
            <span
              className={cn(
                "text-h1 font-semibold tracking-titular",
                entregaElVendedor ? "text-tinta" : "text-negativo",
              )}
            >
              {fmt(Math.abs(total.saldo))}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-[10px] flex-wrap">
          {error && <span className="text-meta text-negativo max-w-[280px]">{error}</span>}
          {/*
            El papel lleva TODO lo que sigue pendiente, no lo que está marcado:
            es el documento que se le entrega al vendedor para cuadrar, y lo
            marcado es lo que se va a liquidar ahora mismo. Lo ya liquidado no
            aparece porque no llega hasta aquí — `fn_liquidacion_pendiente` lo
            deja fuera desde la base.
          */}
          <BotonImprimir
            hoja={{
              vendedor: vendedorNombre,
              factor,
              comisionTasa,
              desde,
              hasta,
              semana,
              yaPagados,
              lineas: filas.map((f) => ({
                fecha: f.fecha,
                hora: f.hora,
                ganador: f.ganador,
                venta: f.venta,
                comision: f.comision,
                premios: f.premios,
                saldo: f.saldo,
              })),
            }}
          />
          <Boton
            variante="ghost"
            onClick={() => setMarcados(new Set(filas.map((f) => f.liquidacionId)))}
            disabled={elegidas.length === filas.length}
          >
            Marcar todo
          </Boton>
          <Boton onClick={() => setConfirmando(true)} disabled={elegidas.length === 0 || pagando}>
            Liquidar
          </Boton>
        </div>
      </div>

      <Modal
        abierto={confirmando}
        eyebrow={vendedorNombre}
        titulo="Liquidar estos sorteos"
        onCerrar={() => setConfirmando(false)}
        error={error}
        ancho={560}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setConfirmando(false)} disabled={pagando}>
              Cancelar
            </Boton>
            <Boton onClick={liquidar} disabled={pagando}>
              {pagando ? "Liquidando…" : "Confirmar liquidación"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-base text-cuerpo leading-[1.6] m-0">
            Se cierran <strong>{elegidas.length}</strong>{" "}
            {elegidas.length === 1 ? "sorteo" : "sorteos"} por{" "}
            <strong>{fmt(Math.abs(total.saldo))}</strong>{" "}
            {entregaElVendedor
              ? "que entrega el vendedor"
              : "que le entrega la casa al vendedor"}.
          </p>

          <p className="text-meta text-secundario leading-[1.55] m-0 bg-panel border border-borde rounded-card px-4 py-3">
            A partir de aquí esos sorteos dejan de aparecer en el informe, aunque se vuelva a
            consultar la misma semana. Los que quedaron sin marcar siguen pendientes.
          </p>

          <CampoModal etiqueta="Nota (opcional)" anchoCompleto>
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Recibo 0142, en efectivo…"
              className={CLASE_CONTROL_MODAL}
            />
          </CampoModal>
        </div>
      </Modal>
    </>
  );
}
