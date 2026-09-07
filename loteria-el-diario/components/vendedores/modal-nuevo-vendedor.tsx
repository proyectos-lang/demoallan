"use client";

import { useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { crearVendedor } from "@/app/(admin)/vendedores/acciones";

const VACIO = {
  nombre: "",
  telefono: "",
  correo: "",
  alias: "",
  identidad: "",
  ciudad: "",
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
  ciudades = [],
}: {
  abierto: boolean;
  onCerrar: () => void;
  /**
   * Las ciudades que YA se usan, para sugerirlas.
   *
   * No son un catálogo ni una restricción: se puede escribir cualquier otra.
   * Están para que nadie tenga que recordar cómo se tecleó la primera vez —
   * que es de donde salen «Choloma», «choloma» y «CHOLOMA» conviviendo como si
   * fueran tres sitios.
   */
  ciudades?: string[];
  /**
   * El segundo argumento llega sólo cuando además se creó el acceso: son las
   * credenciales, que se muestran una única vez.
   */
  onCreado: (
    mensaje: string,
    acceso?: { nombre: string; usuario: string; contrasena: string },
  ) => void;
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
        alias: form.alias,
        comision: parseFloat(form.comision || "0"),
        factor_pago: parseFloat(form.factor_pago || "0"),
        tope_por_numero: parseFloat(form.tope_por_numero || "0"),
      });

      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      const nombre = form.nombre.trim();
      const acceso =
        r.usuario && r.contrasena
          ? { nombre, usuario: r.usuario, contrasena: r.contrasena }
          : undefined;
      setForm(VACIO);
      setError("");
      onCreado(r.mensaje, acceso);
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

        {/*
          El alias va PEGADO AL NOMBRE porque es su alternativa: quien lo lee
          entiende de un vistazo que uno sustituye al otro en el papel. Más
          abajo, entre el correo y la ciudad, parecería un dato de contacto.
        */}
        <CampoModal etiqueta="Alias (opcional)" anchoCompleto>
          <input
            value={form.alias}
            onChange={(e) => set("alias", e.target.value.slice(0, 30))}
            placeholder="Lo que se imprime en el ticket"
            maxLength={30}
            className={CLASE_CONTROL_MODAL}
          />
          <span className="block text-label text-mudo mt-[5px]">
            Si lo deja en blanco, el ticket imprime el nombre. Máximo 30
            caracteres: es lo que cabe en la tirilla.
          </span>
        </CampoModal>

        <CampoModal etiqueta="Teléfono (opcional)">
          <input
            value={form.telefono}
            onChange={(e) => set("telefono", e.target.value)}
            placeholder="9999-9999"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Identidad (opcional)">
          <input
            value={form.identidad}
            onChange={(e) => set("identidad", e.target.value)}
            placeholder="0501-1988-04217"
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Correo (opcional)" anchoCompleto>
          <input
            value={form.correo}
            onChange={(e) => set("correo", e.target.value)}
            className={CLASE_CONTROL_MODAL}
          />
        </CampoModal>

        <CampoModal etiqueta="Ciudad">
          {/*
            Campo libre con lista de sugerencias, no un selector.

            `datalist` deja escribir cualquier cosa y a la vez ofrece lo ya
            registrado en cuanto se teclean dos letras. Un selector obligaría a
            mantener un catálogo; un campo pelado invitaría a que el mismo
            lugar acabe escrito de cuatro maneras.
          */}
          <input
            value={form.ciudad}
            onChange={(e) => set("ciudad", e.target.value)}
            list="ciudades-conocidas"
            placeholder="San Pedro Sula"
            autoComplete="off"
            className={CLASE_CONTROL_MODAL}
          />
          <datalist id="ciudades-conocidas">
            {ciudades.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
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
