"use client";

import { useEffect, useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { CampoModal, CLASE_CONTROL_MODAL, Modal } from "@/components/ui/modal";
import { editarVendedor } from "@/app/(admin)/vendedores/acciones";

/**
 * Editar la ficha de un vendedor que ya existe.
 *
 * QUÉ TIENE Y QUÉ NO
 * ------------------
 * Los mismos campos del alta salvo los tres parámetros —comisión, factor y
 * tope—, que se quedan en la tabla. Allí se editan en línea y se guardan
 * versionados: cada cambio abre una vigencia nueva en vez de pisar la anterior,
 * para que las ventas ya registradas conserven lo que se les prometió. Aquí
 * todo se sobrescribe, así que mezclarlos sería reescribir el pasado.
 *
 * El CÓDIGO tampoco se edita, y se muestra en gris para que se vea que es a
 * propósito: está impreso en cada folio ya emitido y es la cuenta con la que
 * entra el vendedor. Cambiarlo dejaría los tickets viejos apuntando a un
 * código que ya no existe.
 */

export type VendedorEditable = {
  id: string;
  codigo: string;
  nombre: string;
  alias: string | null;
  telefono: string | null;
  correo: string | null;
  identidad: string | null;
  ciudad: string | null;
  barrio: string | null;
};

export function ModalEditarVendedor({
  vendedor,
  onCerrar,
  onGuardado,
  ciudades = [],
}: {
  /** `null` con el modal cerrado. */
  vendedor: VendedorEditable | null;
  onCerrar: () => void;
  onGuardado: (mensaje: string) => void;
  /** Las ciudades ya registradas, para sugerirlas. No son una restricción. */
  ciudades?: string[];
}) {
  const [form, setForm] = useState({
    nombre: "",
    alias: "",
    telefono: "",
    correo: "",
    identidad: "",
    ciudad: "",
    barrio: "",
  });
  const [error, setError] = useState("");
  const [enviando, iniciar] = useTransition();

  /*
   * El formulario se rellena cuando cambia el vendedor, no al montar.
   *
   * El modal vive siempre en el árbol y sólo cambia a quién apunta; sin esto,
   * abrir la ficha de un segundo vendedor mostraría los datos del primero —que
   * es la peor variante posible del error, porque se guardarían sobre el
   * vendedor equivocado sin que nada lo delate.
   */
  useEffect(() => {
    if (!vendedor) return;
    setForm({
      nombre: vendedor.nombre ?? "",
      alias: vendedor.alias ?? "",
      telefono: vendedor.telefono ?? "",
      correo: vendedor.correo ?? "",
      identidad: vendedor.identidad ?? "",
      ciudad: vendedor.ciudad ?? "",
      barrio: vendedor.barrio ?? "",
    });
    setError("");
  }, [vendedor]);

  const set = <K extends keyof typeof form>(campo: K, valor: string) => {
    setForm((f) => ({ ...f, [campo]: valor }));
    setError("");
  };

  const guardar = () => {
    if (!vendedor) return;
    iniciar(async () => {
      const r = await editarVendedor({ vendedor_id: vendedor.id, ...form });
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      onGuardado(r.mensaje);
    });
  };

  return (
    <Modal
      abierto={vendedor !== null}
      onCerrar={onCerrar}
      eyebrow={vendedor ? `EDITAR · ${vendedor.codigo}` : "EDITAR"}
      titulo="Datos del vendedor"
      subtitulo="La comisión, el factor y el tope se editan en la tabla: se guardan versionados y no se pisan."
      error={error}
      pie={
        <>
          <Boton variante="ghost" onClick={onCerrar} disabled={enviando}>
            Cancelar
          </Boton>
          <Boton onClick={guardar} disabled={enviando}>
            {enviando ? "Guardando…" : "Guardar cambios"}
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

        {/* Pegado al nombre porque es su alternativa en el papel, no un dato
            de contacto. Mismo criterio que el alta. */}
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
          <input
            value={form.ciudad}
            onChange={(e) => set("ciudad", e.target.value)}
            list="ciudades-conocidas"
            placeholder="San Pedro Sula"
            autoComplete="off"
            className={CLASE_CONTROL_MODAL}
          />
          {/* La misma lista que el alta; el `id` se comparte a propósito, y el
              navegador la resuelve una sola vez esté donde esté en el árbol. */}
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

        <p className="col-span-full text-meta text-secundario leading-[1.55] m-0">
          El código <strong>{vendedor?.codigo}</strong> no se puede cambiar: está impreso en
          los tickets ya emitidos y es el usuario con el que entra el vendedor. Cada campo que
          se modifique queda en auditoría con su valor anterior.
        </p>
      </div>
    </Modal>
  );
}
