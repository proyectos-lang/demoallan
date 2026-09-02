"use client";

import { useMemo, useState, useTransition } from "react";

import { registrarCorte } from "@/app/(admin)/liquidacion/acciones";
import { BotonImprimir } from "@/components/liquidacion/boton-imprimir";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, jornada, pad2 } from "@/lib/format";

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
          {/*
            Compacta a propósito: una semana son veintiún sorteos y con la fila
            alta no cabía una semana entera en pantalla. El día dejó de ser una
            columna ancha repetida tres veces y pasó a ser una fila de grupo,
            que además es donde tiene sentido la casilla que marca el día
            entero y el subtotal.
          */}
          <table className="w-full border-collapse text-tabla min-w-[620px]">
            <thead>
              <tr className="bg-tinte">
                {["", "SORTEO", "GANADOR", "VENTA", "COMISIÓN", "PREMIOS", "SALDO"].map(
                  (th, i) => (
                    <th
                      key={th || "marca"}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[8px]",
                        i >= 3 ? "text-right" : "text-left",
                        i === 0 ? "pl-4 pr-2 w-9" : i === 6 ? "pl-3 pr-4" : "px-3",
                      )}
                    >
                      {th}
                    </th>
                  ),
                )}
              </tr>
            </thead>

            {porDia.map(([fecha, delDia]) => {
              const marcadasDelDia = delDia.filter((f) => marcados.has(f.liquidacionId));
              const subtotal = marcadasDelDia.reduce((a, f) => a + f.saldo, 0);
              const todos = marcadasDelDia.length === delDia.length;
              const algunos = marcadasDelDia.length > 0 && !todos;

              return (
                <tbody key={fecha}>
                  <tr className="bg-tinte">
                    <td className="border-b border-riel py-[6px] pl-4 pr-2">
                      <input
                        type="checkbox"
                        checked={todos}
                        // El estado intermedio no se puede poner por atributo:
                        // es una propiedad del elemento y hay que escribirla.
                        ref={(el) => {
                          if (el) el.indeterminate = algunos;
                        }}
                        onChange={() => alternarDia(delDia)}
                        aria-label={`Marcar el día ${fecha} entero`}
                        className="w-4 h-4 accent-[var(--color-acento)]"
                      />
                    </td>
                    <td colSpan={5} className="border-b border-riel py-[6px] px-3">
                      <span className="text-meta font-semibold">{fechaLarga(fecha)}</span>
                      <span className="text-th text-secundario ml-2">
                        {marcadasDelDia.length} de {delDia.length}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "border-b border-riel py-[6px] pl-3 pr-4 text-right text-meta font-semibold",
                        subtotal < 0 && "text-negativo",
                      )}
                    >
                      {fmt(subtotal, false)}
                    </td>
                  </tr>

                  {delDia.map((f) => (
                    <tr
                      key={f.liquidacionId}
                      className={cn(!marcados.has(f.liquidacionId) && "opacity-45")}
                    >
                      <td className="border-b border-fondo py-[6px] pl-4 pr-2">
                        <input
                          type="checkbox"
                          checked={marcados.has(f.liquidacionId)}
                          onChange={() => alternar(f.liquidacionId)}
                          aria-label={`Pagar ${fecha} ${f.hora}`}
                          className="w-4 h-4 accent-[var(--color-acento)]"
                        />
                      </td>
                      <td className="border-b border-fondo py-[6px] px-3 text-cuerpo">
                        {jornada(f.hora)}
                        <span className="text-th text-mudo ml-[6px]">{hora12(f.hora)}</span>
                      </td>
                      <td className="border-b border-fondo py-[6px] px-3">
                        <span className="inline-block min-w-[28px] text-center px-[6px] py-px rounded-celda bg-acento-suave text-acento-fuerte text-meta font-semibold">
                          {f.ganador === null ? "â" : pad2(f.ganador)}
                        </span>
                      </td>
                      <td className="border-b border-fondo py-[6px] px-3 text-right">
                        {fmt(f.venta, false)}
                      </td>
                      <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                        {fmt(f.comision, false)}
                      </td>
                      <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                        {fmt(f.premios, false)}
                      </td>
                      <td
                        className={cn(
                          "border-b border-fondo py-[6px] pl-3 pr-4 text-right font-semibold",
                          f.saldo < 0 && "text-negativo",
                        )}
                      >
                        {fmt(f.saldo, false)}
                      </td>
                    </tr>
                  ))}
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
          {/*
            El papel lleva TODO lo que sigue pendiente, no lo que está marcado:
            es el documento que se le entrega al vendedor para cuadrar, y lo
            marcado es lo que se va a cobrar ahora mismo. Lo ya cobrado no
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
