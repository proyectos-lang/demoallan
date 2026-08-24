"use client";

import { useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { fmt, fmtK, hora12, pad2 } from "@/lib/format";
import {
  calcularImpacto,
  cerrarVenta,
  liquidar,
  type Impacto,
} from "@/app/(admin)/resultados/acciones";

export type SorteoCaptura = {
  id: string;
  fechaLarga: string;
  hora: string;
  estado: "abierto" | "cerrado";
  venta: number;
  tickets: number;
  /** Hora a la que cierra la venta, sólo si TODAVÍA está vigente. */
  cierraA?: string | null;
};

export type ResultadoHistorico = {
  numero: number;
  fecha: string;
  hora: string;
  venta: number;
  utilidad: number;
};

export function CapturaResultado({
  sorteo,
  historicos,
}: {
  sorteo: SorteoCaptura;
  historicos: ResultadoHistorico[];
}) {
  const [numero, setNumero] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [impacto, setImpacto] = useState<Impacto | null>(null);
  const [modalAbierto, setModalAbierto] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; error: boolean }>({ texto: "", error: false });
  const [trabajando, iniciar] = useTransition();

  const numeroValido = numero.length === 2;
  const coincide = confirmacion === numero && numeroValido;

  const revisar = () => {
    if (!numeroValido) return;
    setConfirmacion("");
    setAviso({ texto: "", error: false });
    iniciar(async () => {
      const r = await calcularImpacto(sorteo.id, parseInt(numero, 10));
      if (!r.ok) return setAviso({ texto: r.mensaje, error: true });
      setImpacto(r.impacto);
      setModalAbierto(true);
    });
  };

  const cerrar = () => {
    iniciar(async () => {
      const r = await cerrarVenta(sorteo.id);
      if (!r.ok) setAviso({ texto: r.mensaje, error: true });
    });
  };

  const confirmar = () => {
    if (!coincide) {
      return setAviso({ texto: "El número redigitado no coincide.", error: true });
    }
    iniciar(async () => {
      const r = await liquidar(sorteo.id, parseInt(numero, 10));
      if (!r.ok) return setAviso({ texto: r.mensaje, error: true });
      setModalAbierto(false);
      setNumero("");
      setConfirmacion("");
      setAviso({
        texto: `Liquidado: ${r.ganadoras} líneas ganadoras, ${fmt(r.premios)} en premios. Sorteo bloqueado y auditoría registrada.`,
        error: false,
      });
    });
  };

  return (
    <div className="flex flex-wrap gap-[18px] items-start">
      {/* ---- Captura ---- */}
      <div className="flex-1 min-w-[480px] bg-superficie border border-borde rounded-card shadow-card px-[22px] pt-5 pb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              Sorteo {hora12(sorteo.hora)} · {sorteo.fechaLarga}
            </h2>
            <p className="text-micro text-secundario mt-[5px] mb-0">
              {sorteo.tickets} tickets · venta {fmt(sorteo.venta)}
            </p>
          </div>
          <span
            className={cn(
              "px-[11px] py-1 rounded-chip text-label font-semibold",
              sorteo.estado === "cerrado" ? "bg-chip text-cuerpo" : "bg-positivo-fondo text-positivo-texto",
            )}
          >
            {sorteo.estado === "cerrado" ? "CERRADO" : "EN VENTA"}
          </span>
        </div>

        {sorteo.estado === "abierto" ? (
          <div className="mt-5">
            <p className="text-base text-cuerpo leading-[1.6] max-w-[60ch] mt-0">
              Este sorteo todavía admite ventas. Hay que cortar la venta antes de capturar el
              número ganador: una vez cerrado no entra ningún ticket más, y sólo entonces la
              liquidación puede cuadrar contra un total que ya no cambia.
            </p>
            {sorteo.cierraA && (
              <p className="text-meta text-ambar-texto bg-ambar-fondo rounded-campo px-[13px] py-[9px] max-w-[60ch] mt-3 mb-0">
                Su venta no vence hasta las {sorteo.cierraA}. Cerrarla ahora es adelantarse: los
                vendedores dejarán de poder registrar tickets de este sorteo en el acto.
              </p>
            )}
            <Boton tamano="lg" onClick={cerrar} disabled={trabajando} className="mt-4">
              {trabajando ? "Cerrando…" : "Cerrar la venta"}
            </Boton>
          </div>
        ) : (
          <div className="flex gap-6 flex-wrap items-start mt-5">
            <div>
              <label className="block text-th font-semibold tracking-eyebrow text-secundario mb-2">
                NÚMERO GANADOR
              </label>
              <input
                value={numero}
                onChange={(e) => {
                  setNumero(e.target.value.replace(/\D/g, "").slice(0, 2));
                  setAviso({ texto: "", error: false });
                }}
                inputMode="numeric"
                maxLength={2}
                className="w-[150px] text-center text-captura font-semibold tracking-titular text-navy py-[14px] border-2 border-borde-campo rounded-hero bg-panel outline-none"
              />
            </div>

            <div className="min-w-[220px] flex-1 text-tabla text-cuerpo leading-[1.6]">
              <p className="mt-0">
                Antes de liquidar se muestra cuánto se pagaría con este número: cuántas líneas
                ganan, el premio total y la utilidad que quedaría.
              </p>
              <p className="mb-0">
                La confirmación pide redigitar el número. Un dígito equivocado aquí es dinero
                pagado de más, y la liquidación no se deshace sin una reversión auditada.
              </p>
            </div>
          </div>
        )}

        {sorteo.estado === "cerrado" && (
          <Boton
            tamano="lg"
            onClick={revisar}
            disabled={!numeroValido || trabajando}
            className="mt-5"
          >
            {trabajando ? "Calculando…" : "Revisar impacto económico"}
          </Boton>
        )}

        {aviso.texto && (
          <p
            className={cn(
              "text-tabla mt-4 mb-0",
              aviso.error ? "text-negativo" : "text-positivo",
            )}
          >
            {aviso.texto}
          </p>
        )}
      </div>

      {/* ---- Últimos resultados ---- */}
      <div className="flex-1 min-w-[300px] max-w-[360px] bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5">
        <h2 className="text-h2 font-semibold tracking-sutil m-0">Últimos resultados</h2>
        {historicos.length === 0 ? (
          <p className="text-meta text-mudo mt-3 mb-0">Todavía no hay sorteos liquidados.</p>
        ) : (
          <div className="mt-2">
            {historicos.map((h, i) => (
              <div
                key={i}
                className="flex items-center gap-3 py-[9px] border-b border-fondo last:border-b-0"
              >
                <span className="w-10 h-10 flex-none rounded-banner bg-navy text-white text-pos font-semibold flex items-center justify-center">
                  {pad2(h.numero)}
                </span>
                <span className="block flex-1 min-w-0">
                  <span className="block text-meta font-medium">
                    {h.fecha} · {h.hora}
                  </span>
                  <span className="block text-label text-secundario">
                    venta {fmtK(h.venta)}
                  </span>
                </span>
                <span
                  className={cn(
                    "text-meta font-semibold",
                    h.utilidad < 0 ? "text-negativo" : "text-positivo",
                  )}
                >
                  {h.utilidad > 0 ? "+" : ""}
                  {fmtK(h.utilidad)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Doble digitación ---- */}
      <Modal
        abierto={modalAbierto && impacto !== null}
        onCerrar={() => setModalAbierto(false)}
        ancho={560}
        eyebrow="REVISIÓN DE IMPACTO"
        titulo="Confirmar el número ganador"
        subtitulo="Redigite el número para liquidar. La operación no se deshace."
        error={aviso.error ? aviso.texto : ""}
        pie={
          <>
            <Boton variante="ghost" onClick={() => setModalAbierto(false)} disabled={trabajando}>
              Cancelar
            </Boton>
            <Boton variante="oscuro" onClick={confirmar} disabled={!coincide || trabajando}>
              {trabajando ? "Liquidando…" : "Confirmar y liquidar"}
            </Boton>
          </>
        }
      >
        {impacto && (
          <>
            <div className="flex items-center gap-4">
              <span className="w-[104px] h-[104px] flex-none rounded-modal bg-navy text-white text-tile font-semibold tracking-titular flex items-center justify-center">
                {pad2(parseInt(numero, 10))}
              </span>
              <div className="flex-1 flex flex-col gap-[9px]">
                {[
                  ["Líneas ganadoras", String(impacto.lineas_ganadoras)],
                  ["Premios a pagar", fmt(impacto.pago)],
                  ["Comisiones", fmt(impacto.comision)],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between text-tabla">
                    <span className="text-secundario">{k}</span>
                    <strong className="font-semibold">{v}</strong>
                  </div>
                ))}
                <div className="flex justify-between text-tabla border-t border-riel pt-[9px]">
                  <span className="text-secundario">Utilidad del sorteo</span>
                  <strong
                    className={cn(
                      "font-semibold",
                      impacto.utilidad < 0 ? "text-negativo" : "text-positivo",
                    )}
                  >
                    {fmt(impacto.utilidad)}
                  </strong>
                </div>
              </div>
            </div>

            <label className="block mt-5">
              <span className="block text-label text-secundario font-medium mb-[6px]">
                Redigite el número ganador
              </span>
              <input
                value={confirmacion}
                onChange={(e) => {
                  setConfirmacion(e.target.value.replace(/\D/g, "").slice(0, 2));
                  setAviso({ texto: "", error: false });
                }}
                inputMode="numeric"
                maxLength={2}
                autoFocus
                className={cn(
                  "w-[120px] text-center text-ganador font-semibold py-3 border-2 rounded-pos bg-panel outline-none",
                  confirmacion.length === 2 && !coincide
                    ? "border-negativo"
                    : coincide
                      ? "border-positivo-vivo"
                      : "border-borde-campo",
                )}
              />
            </label>
          </>
        )}
      </Modal>
    </div>
  );
}
