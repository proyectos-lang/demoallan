"use client";

import { useMemo, useState, useTransition } from "react";

import { registrarCorte } from "@/app/(admin)/liquidacion/acciones";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, pad2 } from "@/lib/format";

export type FilaLiquidacion = {
  liquidacionId: string;
  fecha: string;
  hora: string;
  ganador: number | null;
  venta: number;
  comision: number;
  premios: number;
  /** venta − comisión − premios. */
  saldo: number;
};

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
}: {
  filas: FilaLiquidacion[];
  vendedorId: string;
  vendedorNombre: string;
  desde: string;
  hasta: string;
  /** Sorteos del rango que aún no tienen número ganador. */
  sinLiquidar: number;
}) {
  const [marcados, setMarcados] = useState<Set<string>>(
    () => new Set(filas.map((f) => f.liquidacionId)),
  );
  const [confirmando, setConfirmando] = useState(false);
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [pagando, iniciar] = useTransition();

  const porDia = useMemo(() => {
    const mapa = new Map<string, FilaLiquidacion[]>();
    for (const f of filas) {
      const lista = mapa.get(f.fecha) ?? [];
      lista.push(f);
      mapa.set(f.fecha, lista);
    }
    return [...mapa.entries()];
  }, [filas]);

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

  // El signo decide quién le paga a quién, y el rótulo tiene que decirlo: un
  // «total» a secas en una hoja de cobro se lee mal en las dos direcciones.
  const entregaElVendedor = total.saldo >= 0;

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

  const pagar = () => {
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
          No queda nada por pagarle a <strong>{vendedorNombre}</strong> en este rango.
        </p>
        {sinLiquidar > 0 && (
          <p className="text-meta text-secundario mt-2 mb-0">
            Quedan {sinLiquidar} {sinLiquidar === 1 ? "sorteo" : "sorteos"} de la semana sin
            liquidar: hasta que se les capture el número ganador no se pueden pagar.
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
          {sinLiquidar === 1 ? "sorteo" : "sorteos"} sin liquidar. Se puede pagar lo que ya
          está y lo demás aparecerá aquí en cuanto se capture su número ganador.
        </div>
      )}

      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-tabla min-w-[760px]">
            <thead>
              <tr className="bg-tinte">
                {["", "DÍA", "SORTEO", "GANADOR", "VENTA", "COMISIÓN", "PREMIOS", "SALDO"].map(
                  (th, i) => (
                    <th
                      key={th || "marca"}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                        i >= 4 ? "text-right" : "text-left",
                        i === 0 ? "pl-4 pr-2 w-10" : i === 7 ? "pl-3 pr-4" : "px-3",
                      )}
                    >
                      {th}
                    </th>
                  ),
                )}
              </tr>
            </thead>

            {porDia.map(([fecha, delDia]) => {
              const subtotal = delDia
                .filter((f) => marcados.has(f.liquidacionId))
                .reduce((a, f) => a + f.saldo, 0);
              const todos = delDia.every((f) => marcados.has(f.liquidacionId));

              return (
                <tbody key={fecha}>
                  {delDia.map((f, i) => (
                    <tr key={f.liquidacionId} className={cn(!marcados.has(f.liquidacionId) && "opacity-45")}>
                      <td className="border-b border-fondo py-[11px] pl-4 pr-2">
                        <input
                          type="checkbox"
                          checked={marcados.has(f.liquidacionId)}
                          onChange={() => alternar(f.liquidacionId)}
                          aria-label={`Pagar ${fecha} ${f.hora}`}
                          className="w-4 h-4 accent-[var(--color-acento)]"
                        />
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-cuerpo">
                        {i === 0 && (
                          <button
                            type="button"
                            onClick={() => alternarDia(delDia)}
                            className="text-left"
                            title={todos ? "Quitar el día entero" : "Marcar el día entero"}
                          >
                            <span className="block font-medium">{fechaLarga(fecha)}</span>
                            <span className="block text-label text-acento">
                              {todos ? "quitar el día" : "marcar el día"}
                            </span>
                          </button>
                        )}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-cuerpo">
                        {hora12(f.hora)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3">
                        <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
                          {f.ganador === null ? "—" : pad2(f.ganador)}
                        </span>
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right">
                        {fmt(f.venta, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.comision, false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(f.premios, false)}
                      </td>
                      <td
                        className={cn(
                          "border-b border-fondo py-[11px] pl-3 pr-4 text-right font-semibold",
                          f.saldo < 0 && "text-negativo",
                        )}
                      >
                        {fmt(f.saldo, false)}
                      </td>
                    </tr>
                  ))}

                  <tr className="bg-tinte">
                    <td colSpan={7} className="border-b border-riel py-[7px] px-3 text-right text-label text-secundario">
                      subtotal del día
                    </td>
                    <td className="border-b border-riel py-[7px] pl-3 pr-4 text-right text-meta font-semibold">
                      {fmt(subtotal, false)}
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
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
              {entregaElVendedor ? "EL VENDEDOR ENTREGA" : "LA CASA LE PAGA"}
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
          <Boton
            variante="ghost"
            onClick={() => setMarcados(new Set(filas.map((f) => f.liquidacionId)))}
            disabled={elegidas.length === filas.length}
          >
            Marcar todo
          </Boton>
          <Boton onClick={() => setConfirmando(true)} disabled={elegidas.length === 0 || pagando}>
            Registrar pago
          </Boton>
        </div>
      </div>

      <Modal
        abierto={confirmando}
        eyebrow={vendedorNombre}
        titulo="Registrar el pago"
        onCerrar={() => setConfirmando(false)}
        error={error}
        ancho={560}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setConfirmando(false)} disabled={pagando}>
              Cancelar
            </Boton>
            <Boton onClick={pagar} disabled={pagando}>
              {pagando ? "Registrando…" : "Confirmar pago"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-base text-cuerpo leading-[1.6] m-0">
            Se cierran <strong>{elegidas.length}</strong>{" "}
            {elegidas.length === 1 ? "sorteo" : "sorteos"} por{" "}
            <strong>{fmt(Math.abs(total.saldo))}</strong>{" "}
            {entregaElVendedor ? "que entrega el vendedor" : "que le paga la casa"}.
          </p>

          <p className="text-meta text-secundario leading-[1.55] m-0 bg-panel border border-borde rounded-card px-4 py-3">
            A partir de aquí esos sorteos dejan de aparecer en el informe, aunque se vuelva a
            consultar la misma semana. Los que quedaron sin marcar siguen pendientes.
          </p>

          <CampoModal etiqueta="Nota (opcional)" anchoCompleto>
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Recibo 0142, entregado en efectivo…"
              className={CLASE_CONTROL_MODAL}
            />
          </CampoModal>
        </div>
      </Modal>
    </>
  );
}
