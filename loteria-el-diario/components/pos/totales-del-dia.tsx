"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Pencil, X } from "lucide-react";

import {
  anularVentaPorTotales,
  editarVentaPorTotales,
} from "@/app/(admin)/punto-de-venta/acciones";
import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fmt, hora12 } from "@/lib/format";

export type CapturaDelDia = {
  id: string;
  hora: string;
  estado: string;
  vendedorId: string;
  codigo: string;
  /** El alias si lo tiene; si no, el nombre. Lo resuelve la base. */
  vendedor: string;
  venta: number;
  premios: number;
  comision: number;
  saldo: number;
  nota: string | null;
  anulado: boolean;
};

/** Sólo dígitos y un punto. Un importe no admite otra cosa. */
const limpiar = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/**
 * Lo capturado por totales en un día, con sus tres sorteos juntos.
 *
 * POR QUÉ EL DÍA ENTERO Y NO EL SORTEO
 * ------------------------------------
 * La captura por totales se hace con la hoja de papel del vendedor delante, y
 * esa hoja trae el día completo. Revisar lo capturado sorteo por sorteo
 * obligaba a entrar tres veces y a sumar de cabeza para cotejarla.
 *
 * SE PUEDE CORREGIR, NO SÓLO ANULAR
 * ---------------------------------
 * Una venta de 4.500 tecleada como 450 se arreglaba anulando y volviendo a
 * capturar, y eso deja dos filas en el histórico para un error de un dígito.
 * Ahora se corrige la cifra en su sitio y la anterior queda en auditoría.
 *
 * El vendedor y el sorteo NO se tocan: eso no es corregir, es mover dinero de
 * un sitio a otro, y para eso está anular y capturar donde toque.
 */
export function TotalesDelDia({
  capturas,
  dia,
}: {
  capturas: CapturaDelDia[];
  dia: string;
}) {
  const router = useRouter();
  const [editando, setEditando] = useState<CapturaDelDia | null>(null);
  const [venta, setVenta] = useState("");
  const [premiado, setPremiado] = useState("");
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  useEffect(() => {
    if (!editando) return;
    setVenta(String(editando.venta));
    setPremiado(String(editando.premios));
    setNota(editando.nota ?? "");
    setError("");
  }, [editando]);

  const guardar = () => {
    if (!editando) return;
    iniciar(async () => {
      const r = await editarVentaPorTotales(
        editando.id,
        Number(venta) || 0,
        Number(premiado) || 0,
        nota,
      );
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setEditando(null);
      router.refresh();
    });
  };

  const anular = (c: CapturaDelDia) => {
    iniciar(async () => {
      const r = await anularVentaPorTotales(c.id);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      router.refresh();
    });
  };

  const vivas = capturas.filter((c) => !c.anulado);
  const total = vivas.reduce(
    (a, c) => ({
      venta: a.venta + c.venta,
      premios: a.premios + c.premios,
      saldo: a.saldo + c.saldo,
    }),
    { venta: 0, premios: 0, saldo: 0 },
  );

  if (capturas.length === 0) {
    return (
      <TarjetaNota>
        No hay ninguna venta capturada por totales ese día. Se captura desde la pestaña
        «Por totales».
      </TarjetaNota>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta padding="18px 20px">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              {vivas.length} {vivas.length === 1 ? "captura" : "capturas"} por totales
            </h2>
            <p className="text-micro text-secundario mt-[5px] mb-0">
              Venta sin detalle de números. No consume cupo.
            </p>
          </div>
          <div className="flex gap-7 flex-wrap">
            <Cifra etiqueta="VENTA" valor={fmt(total.venta)} />
            <Cifra etiqueta="PREMIOS" valor={total.premios > 0 ? fmt(total.premios) : "—"} />
            <Cifra etiqueta="SALDO" valor={fmt(total.saldo)} />
          </div>
        </div>
      </Tarjeta>

      <Tarjeta padding="0">
        {/* Mismo alto acotado que el detalle: la tabla se recorre por dentro y
            el resumen de arriba no se va de la vista. */}
        <div className="overflow-auto max-h-[70dvh]">
          <table className="w-full border-collapse text-tabla">
            <thead className="sticky top-0 z-10 bg-superficie">
              <tr className="text-left">
                {["SORTEO", "VENDEDOR", "VENTA", "PREMIOS", "COMISIÓN", "SALDO", ""].map(
                  (h, i) => (
                    <th
                      key={h + i}
                      className={cn(
                        "border-b border-borde py-[10px] px-3 text-eyebrow font-semibold tracking-seccion text-secundario",
                        ["VENTA", "PREMIOS", "COMISIÓN", "SALDO"].includes(h) && "text-right",
                        i === 0 && "pl-4",
                      )}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {capturas.map((c) => (
                <tr key={c.id} className={cn(c.anulado && "opacity-55")}>
                  <td className="border-b border-fondo py-[10px] pl-4 pr-3 text-secundario whitespace-nowrap">
                    {hora12(c.hora)}
                  </td>
                  <td className="border-b border-fondo py-[10px] px-3">
                    <span className="block text-cuerpo">{c.vendedor}</span>
                    <span className="block text-label text-mudo">{c.codigo}</span>
                  </td>
                  <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo whitespace-nowrap">
                    {fmt(c.venta, false)}
                  </td>
                  <td
                    className={cn(
                      "border-b border-fondo py-[10px] px-3 text-right whitespace-nowrap",
                      c.premios > 0 ? "text-positivo font-semibold" : "text-mudo",
                    )}
                  >
                    {c.premios > 0 ? fmt(c.premios, false) : "—"}
                  </td>
                  <td className="border-b border-fondo py-[10px] px-3 text-right text-secundario whitespace-nowrap">
                    {fmt(c.comision, false)}
                  </td>
                  <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo whitespace-nowrap">
                    {fmt(c.saldo, false)}
                  </td>
                  <td className="border-b border-fondo py-[10px] pl-3 pr-4 whitespace-nowrap">
                    {c.anulado ? (
                      <span className="text-label text-negativo">ANULADA</span>
                    ) : (
                      <span className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setEditando(c)}
                          aria-label={`Corregir la captura de ${c.vendedor}`}
                          className="inline-flex items-center gap-[5px] text-label text-acento font-medium py-1 hover:underline"
                        >
                          <Pencil size={13} strokeWidth={2} absoluteStrokeWidth />
                          corregir
                        </button>
                        <button
                          type="button"
                          onClick={() => anular(c)}
                          disabled={enviando}
                          aria-label={`Anular la captura de ${c.vendedor}`}
                          className="inline-flex items-center gap-[5px] text-label text-negativo font-medium py-1 hover:underline"
                        >
                          <X size={13} strokeWidth={2.4} absoluteStrokeWidth />
                          anular
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tarjeta>

      {error && !editando && (
        <p className="text-meta text-negativo m-0">{error}</p>
      )}

      <Modal
        abierto={editando !== null}
        onCerrar={() => setEditando(null)}
        eyebrow={editando ? `${hora12(editando.hora)} · ${dia}` : ""}
        titulo="Corregir la captura"
        subtitulo={editando ? `${editando.vendedor} · ${editando.codigo}` : ""}
        error={error}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setEditando(null)} disabled={enviando}>
              Cancelar
            </Boton>
            <Boton onClick={guardar} disabled={enviando}>
              {enviando ? "Guardando…" : "Guardar la corrección"}
            </Boton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {editando?.estado === "liquidado" && (
            <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
              Este sorteo ya está liquidado: la liquidación del vendedor se rehará, y si ya
              se le pagó en un corte la corrección se rechaza.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <CampoModal etiqueta="Venta (L)">
              <input
                value={venta}
                onChange={(e) => setVenta(limpiar(e.target.value))}
                inputMode="decimal"
                className={`${CLASE_CONTROL_MODAL} text-right tabular-nums`}
              />
            </CampoModal>
            <CampoModal etiqueta="Valor premiado (L)">
              <input
                value={premiado}
                onChange={(e) => setPremiado(limpiar(e.target.value))}
                inputMode="decimal"
                className={`${CLASE_CONTROL_MODAL} text-right tabular-nums`}
              />
            </CampoModal>
          </div>

          {/*
            Se teclea lo PREMIADO, no lo pagado: el factor lo aplica la base.
            Es la misma regla que al capturar, y decirla aquí otra vez evita
            que alguien multiplique de cabeza al corregir.
          */}
          <p className="text-meta text-secundario m-0 leading-[1.5]">
            El valor premiado es lo que le jugaron al número que salió, sin multiplicar
            por el factor. La comisión se mantiene la del día de la captura.
          </p>

          <CampoModal etiqueta="Nota (opcional)" anchoCompleto>
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value.slice(0, 200))}
              maxLength={200}
              className={CLASE_CONTROL_MODAL}
            />
          </CampoModal>
        </div>
      </Modal>
    </div>
  );
}

/** Una cifra del panel de cabecera. */
function Cifra({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
        {etiqueta}
      </span>
      <span className="block text-h2 font-semibold tracking-titular mt-[3px]">{valor}</span>
    </div>
  );
}
