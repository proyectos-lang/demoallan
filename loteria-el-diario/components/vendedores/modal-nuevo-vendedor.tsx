"use client";

import { useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { crearVendedor, type Ciudad } from "@/app/(admin)/vendedores/acciones";

const CIUDADES: Ciudad[] = ["San Pedro Sula", "Choloma", "Villanueva", "La Lima"];

const VACIO = {
  nombre: "",
  telefono: "",
  correo: "",
  identidad: "",
  ciudad: "San Pedro Sula" as Ciudad,
  barrio: "",
  comision: "12.5",
  factor_pago: "70",
  tope_por_numero: "1000",
};

/** Sólo dígitos y un punto, con tope de longitud (igual que el prototipo). */
const decimal = (v: string, largo: number) => {
  const limpio = v.replace(/[^\d.]/g, "").slice(0, largo);
  const p = limpio.split(".");
  return p.length > 2 ? `${p[0]}.${p.slice(1).join("")}` : limpio;
};

export function ModalNuevoVendedor({
  abierto,
  onCerrar,
  onCreado,
}: {
  abierto: boolean;
  onCerrar: () => void;
  onCreado: (mensaje: string) => void;
}) {
  const [form, setForm] = useState(VACIO);
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  const set = <K extends keyof typeof VACIO>(campo: K, valor: (typeof VACIO)[K]) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setError("");
  };

  const cerrar = () => {
    setForm(VACIO);
    setError("");
    onCerrar();
  };

  const crear = () => {
    iniciar(async () => {
      const r = await crearVendedor({
        nombre: form.nombre,
        telefono: form.telefono,
        correo: form.correo,
        identidad: form.identidad,
        ciudad: form.ciudad,
        barrio: form.barrio,
        comision: parseFloat(form.comision || "0"),
        factor_pago: parseFloat(form.factor_pago || "0"),
        tope_por_numero: parseFloat(form.tope_por_numero || "0"),
      });

      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setForm(VACIO);
      setError("");
      onCreado(r.mensaje);
    });
  };

  return (
    <Modal
      abierto={abierto}
      onCerrar={cerrar}
      eyebrow="NUEVO VENDEDOR"
      titulo="Alta de vendedor"
      subtitulo="Los parámetros se pueden ajustar después; aplican a ventas futuras."
      error={error}
      pie={
        <>
          <Boton variante="ghost" onClick={cerrar} disabled={enviando}>
            Cancelar
          </Boton>
          <Boton onClick={crear} disabled={enviando}>
            {enviando ? "Creando…" : "Crear vendedor"}
          </Boton>
        </>
      }
    >
      <div className="grid gap-x-[18px] gap-y-[14px] [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        <CampoModal etiqueta="Nombre completo" anchoCompleto>
          <input
            value={form.nombre}
            onChange={(e) => set("nombre", e.target.value)}
            className={CLASE_CONTROL_MODAL}
            autoFocus
          />
        </CampoModal>

        <CampoModal etiqueta="Teléfono">
          <input
            value={form.telefono}
            onChange={(e) => set("telefono", e.target.value)}
            placeholder="9999-9999"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Identidad">
          <input
            value={form.identidad}
            onChange={(e) => set("identidad", e.target.value)}
            placeholder="0501-1988-04217"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Correo" anchoCompleto>
          <input
            value={form.correo}
            onChange={(e) => set("correo", e.target.value)}
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Ciudad">
          <select
            value={form.ciudad}
            onChange={(e) => set("ciudad", e.target.value as Ciudad)}
            className={CLASE_CONTROL_MODAL}
          >
            {CIUDADES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </CampoModal>

        <CampoModal etiqueta="Barrio">
          <input
            value={form.barrio}
            onChange={(e) => set("barrio", e.target.value)}
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <div className="col-span-full h-px bg-riel" />

        <CampoModal etiqueta="Comisión (%)">
          <input
            value={form.comision}
            onChange={(e) => set("comision", decimal(e.target.value, 5))}
            inputMode="decimal"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Factor de pago">
          <input
            value={form.factor_pago}
            onChange={(e) => set("factor_pago", decimal(e.target.value, 6))}
            inputMode="decimal"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Máximo por número (L)">
          <input
            value={form.tope_por_numero}
            onChange={(e) => set("tope_por_numero", e.target.value.replace(/[^\d]/g, "").slice(0, 7))}
            inputMode="numeric"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>
      </div>
    </Modal>
  );
}
