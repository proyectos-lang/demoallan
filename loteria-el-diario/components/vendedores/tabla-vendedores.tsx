"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { ModalNuevoVendedor } from "@/components/vendedores/modal-nuevo-vendedor";
import { fmt, iniciales } from "@/lib/format";
import { cn } from "@/lib/cn";
import { guardarParametros, type Cambio } from "@/app/(admin)/vendedores/acciones";

export type FilaVendedor = {
  id: string;
  codigo: string;
  nombre: string;
  identidad: string | null;
  telefono: string | null;
  correo: string | null;
  zona: string;
  color: string;
  /** Porcentaje ya convertido para mostrar: 12.5, no 0.125. */
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

type Campo = "tope_por_numero" | "comision" | "factor_pago";

/** Sólo dígitos y un punto decimal, como el prototipo. */
function sanear(valor: string): string {
  const limpio = valor.replace(/[^\d.]/g, "").slice(0, 8);
  const partes = limpio.split(".");
  return partes.length > 2 ? `${partes[0]}.${partes.slice(1).join("")}` : limpio;
}

export function TablaVendedores({ filas, limiteGlobal }: { filas: FilaVendedor[]; limiteGlobal: number }) {
  // Buffer de edición: sólo guarda lo que el usuario tocó, indexado por
  // `${id}:${campo}`. Lo que no está aquí se lee de la fila original.
  const [borrador, setBorrador] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<{ texto: string; tipo: "ok" | "error" | "neutro" }>({
    texto: "",
    tipo: "neutro",
  });
  const [guardando, iniciarGuardado] = useTransition();
  const [modalAbierto, setModalAbierto] = useState(false);

  const valor = (fila: FilaVendedor, campo: Campo) =>
    borrador[`${fila.id}:${campo}`] ?? String(fila[campo]);

  const sucioCampo = (fila: FilaVendedor, campo: Campo) => {
    const v = borrador[`${fila.id}:${campo}`];
    return v !== undefined && parseFloat(v || "0") !== fila[campo];
  };

  const sucioFila = (fila: FilaVendedor) =>
    (["tope_por_numero", "comision", "factor_pago"] as Campo[]).some((c) => sucioCampo(fila, c));

  const sucio = filas.some(sucioFila);

  const editar = (fila: FilaVendedor, campo: Campo, entrada: string) => {
    setBorrador((b) => ({ ...b, [`${fila.id}:${campo}`]: sanear(entrada) }));
    setAviso({ texto: "", tipo: "neutro" });
  };

  const descartar = () => {
    setBorrador({});
    setAviso({ texto: "", tipo: "neutro" });
  };

  const guardar = () => {
    const cambios: Cambio[] = filas.filter(sucioFila).map((f) => ({
      vendedor_id: f.id,
      comision: parseFloat(valor(f, "comision") || "0"),
      factor_pago: parseFloat(valor(f, "factor_pago") || "0"),
      tope_por_numero: parseFloat(valor(f, "tope_por_numero") || "0"),
    }));

    iniciarGuardado(async () => {
      const r = await guardarParametros(cambios);
      setAviso({ texto: r.mensaje, tipo: r.ok ? "ok" : "error" });
      if (r.ok) setBorrador({});
    });
  };

  const exposicion = (fila: FilaVendedor) => {
    const tope = parseFloat(valor(fila, "tope_por_numero"));
    const factor = parseFloat(valor(fila, "factor_pago"));
    return Number.isNaN(tope) || Number.isNaN(factor) ? "valor no válido" : fmt(tope * factor);
  };

  const claseInput = (fila: FilaVendedor, campo: Campo, ancho: string) =>
    cn(
      ancho,
      "text-right px-[10px] py-[7px] rounded-campo border text-base font-medium outline-none bg-superficie",
      sucioCampo(fila, campo) ? "border-ambar-sucio" : "border-borde-campo",
    );

  return (
    <>
      <ModalNuevoVendedor
        abierto={modalAbierto}
        onCerrar={() => setModalAbierto(false)}
        onCreado={(mensaje) => {
          setModalAbierto(false);
          setAviso({ texto: mensaje, tipo: "ok" });
        }}
      />

      <div className="flex items-end justify-between gap-5 flex-wrap mb-[18px]">
        <div>
          <h1 className="text-h1 font-semibold tracking-titular m-0">Vendedores y límites</h1>
          <p className="text-base text-cuerpo leading-[1.6] max-w-[70ch] mt-[6px] mb-0">
            Un solo tope en lempiras por número para cada vendedor, más su comisión y factor
            de pago. Los cambios aplican a ventas futuras: cada línea ya vendida conserva los
            valores vigentes al momento de la venta.
          </p>
        </div>
        <div className="flex items-center gap-[10px] flex-wrap">
          {aviso.texto && (
            <span
              className={cn(
                "text-meta max-w-[280px]",
                aviso.tipo === "error"
                  ? "text-negativo"
                  : aviso.tipo === "ok"
                    ? "text-positivo"
                    : "text-secundario",
              )}
            >
              {aviso.texto}
            </span>
          )}
          <Boton
            variante="ghost"
            onClick={() => setModalAbierto(true)}
            className="flex items-center gap-[7px] text-acento-fuerte"
          >
            <Plus size={15} strokeWidth={2.2} absoluteStrokeWidth />
            Nuevo vendedor
          </Boton>
          <Boton variante="ghost" onClick={descartar} disabled={!sucio || guardando}>
            Descartar
          </Boton>
          <Boton onClick={guardar} disabled={!sucio || guardando}>
            {guardando ? "Guardando…" : "Guardar cambios"}
          </Boton>
        </div>
      </div>

      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-tabla min-w-[860px]">
            <thead>
              <tr className="bg-tinte">
                {[
                  "VENDEDOR",
                  "CONTACTO",
                  "ZONA",
                  "MÁXIMO POR NÚMERO (L)",
                  "COMISIÓN (%)",
                  "FACTOR DE PAGO",
                  "EXPOSICIÓN MÁX. POR NÚMERO",
                ].map((th, i) => (
                  <th
                    key={th}
                    className={cn(
                      "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                      i >= 3 ? "text-right" : "text-left",
                      i === 0 ? "pl-4 pr-3" : i === 6 ? "pl-3 pr-4" : "px-3",
                    )}
                  >
                    {th}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((fila) => (
                <tr
                  key={fila.id}
                  className={cn(sucioFila(fila) && "bg-ambar-fila-sucia")}
                >
                  <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                    <div className="flex items-center gap-[10px]">
                      <span
                        className="w-[30px] h-[30px] flex-none rounded-campo bg-chip text-th font-semibold flex items-center justify-center"
                        style={{ color: fila.color }}
                      >
                        {iniciales(fila.nombre)}
                      </span>
                      <span className="block">
                        <span className="block font-medium">{fila.nombre}</span>
                        <span className="block text-label text-secundario">
                          {fila.codigo} · {fila.identidad ?? "—"}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-fondo py-[11px] px-3 text-secundario">
                    <span className="block">{fila.telefono ?? "—"}</span>
                    <span className="block text-label">{fila.correo ?? "—"}</span>
                  </td>
                  <td className="border-b border-fondo py-[11px] px-3 text-cuerpo">
                    {fila.zona}
                  </td>
                  <td className="border-b border-fondo py-[11px] px-3 text-right">
                    <input
                      value={valor(fila, "tope_por_numero")}
                      onChange={(e) => editar(fila, "tope_por_numero", e.target.value)}
                      inputMode="decimal"
                      className={claseInput(fila, "tope_por_numero", "w-[120px]")}
                    />
                  </td>
                  <td className="border-b border-fondo py-[11px] px-3 text-right">
                    <input
                      value={valor(fila, "comision")}
                      onChange={(e) => editar(fila, "comision", e.target.value)}
                      inputMode="decimal"
                      className={claseInput(fila, "comision", "w-[88px]")}
                    />
                  </td>
                  <td className="border-b border-fondo py-[11px] px-3 text-right">
                    <input
                      value={valor(fila, "factor_pago")}
                      onChange={(e) => editar(fila, "factor_pago", e.target.value)}
                      inputMode="decimal"
                      className={claseInput(fila, "factor_pago", "w-[88px]")}
                    />
                  </td>
                  <td className="border-b border-fondo py-[11px] pl-3 pr-4 text-right">
                    <span className="block font-semibold">{exposicion(fila)}</span>
                    <span className="block text-label text-mudo">tope × factor</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-[14px] bg-tinte border-t border-riel text-meta text-cuerpo leading-[1.55]">
          Al validar una venta se exige el tope del vendedor y el límite global de la casa (
          {fmt(limiteGlobal)} por número). Todo cambio queda en auditoría con valor anterior,
          usuario y fecha.
        </div>
      </div>
    </>
  );
}
