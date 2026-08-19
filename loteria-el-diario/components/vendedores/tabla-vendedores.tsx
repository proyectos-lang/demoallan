"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { Modal } from "@/components/ui/modal";
import { ModalNuevoVendedor } from "@/components/vendedores/modal-nuevo-vendedor";
import { fmt, iniciales } from "@/lib/format";
import { cn } from "@/lib/cn";
import { guardarParametros, type Cambio } from "@/app/(admin)/vendedores/acciones";
import { crearAcceso, restablecerAcceso } from "@/app/(admin)/vendedores/acceso";

export type FilaVendedor = {
  id: string;
  codigo: string;
  nombre: string;
  identidad: string | null;
  telefono: string | null;
  correo: string | null;
  zona: string;
  color: string;
  /** Usuario de acceso, o `null` si todavía no tiene cuenta. */
  usuario: string | null;
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
  // Credenciales recién generadas. Se muestran UNA vez: la contraseña no se
  // guarda en claro en ningún sitio, así que si se cierra sin anotarla hay que
  // restablecerla.
  const [credenciales, setCredenciales] = useState<{
    nombre: string;
    usuario: string;
    contrasena: string;
  } | null>(null);
  const [dandoAcceso, iniciarAcceso] = useTransition();

  const pedirAcceso = (fila: FilaVendedor) => {
    iniciarAcceso(async () => {
      const r = fila.usuario
        ? await restablecerAcceso(fila.id)
        : await crearAcceso(fila.id);
      if (!r.ok) {
        setAviso({ texto: r.mensaje, tipo: "error" });
        return;
      }
      setCredenciales({ nombre: fila.nombre, usuario: r.usuario, contrasena: r.contrasena });
      setAviso({ texto: "", tipo: "neutro" });
    });
  };

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
        onCreado={(mensaje, acceso) => {
          setModalAbierto(false);
          setAviso({ texto: mensaje, tipo: "ok" });
          if (acceso) setCredenciales(acceso);
        }}
      />

      {/* Las credenciales se enseñan UNA vez. La contraseña no se guarda en
          claro en ninguna parte —en la base sólo hay su bcrypt—, así que si se
          cierra esto sin anotarla, la única salida es restablecerla. */}
      <Modal
        abierto={credenciales !== null}
        titulo="Acceso del vendedor"
        onCerrar={() => setCredenciales(null)}
        pie={
          <Boton onClick={() => setCredenciales(null)}>Ya la anoté</Boton>
        }
      >
        {credenciales && (
          <div className="flex flex-col gap-4">
            <p className="text-base text-cuerpo leading-[1.6] m-0">
              Entregue estos datos a <strong>{credenciales.nombre}</strong>. Al entrar por
              primera vez tendrá que cambiar la contraseña, así que nadie más podrá usarla
              después.
            </p>

            <div className="bg-panel border border-borde rounded-card px-[18px] py-4 flex flex-col gap-3">
              {[
                { etiqueta: "USUARIO", valor: credenciales.usuario },
                { etiqueta: "CONTRASEÑA", valor: credenciales.contrasena },
              ].map((c) => (
                <div key={c.etiqueta}>
                  <span className="block text-eyebrow font-semibold tracking-seccion text-mudo">
                    {c.etiqueta}
                  </span>
                  <span className="block text-h1 font-semibold tracking-sutil mt-[2px]">
                    {c.valor}
                  </span>
                </div>
              ))}
            </div>

            <p className="text-meta text-secundario leading-[1.55] m-0">
              Esta contraseña no se vuelve a mostrar: sólo se guarda su huella cifrada. Si se
              pierde, use «restablecer clave» en la fila del vendedor.
            </p>
          </div>
        )}
      </Modal>

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
                  "ACCESO",
                ].map((th, i) => (
                  <th
                    key={th}
                    className={cn(
                      "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                      i >= 3 && i <= 6 ? "text-right" : "text-left",
                      i === 0 ? "pl-4 pr-3" : i === 7 ? "pl-3 pr-4" : "px-3",
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
                  <td className="border-b border-fondo py-[11px] px-3 text-right">
                    <span className="block font-semibold">{exposicion(fila)}</span>
                    <span className="block text-label text-mudo">tope × factor</span>
                  </td>
                  <td className="border-b border-fondo py-[11px] pl-3 pr-4">
                    {fila.usuario ? (
                      <span className="block">
                        <span className="block text-label font-medium">{fila.usuario}</span>
                        <button
                          type="button"
                          onClick={() => pedirAcceso(fila)}
                          disabled={dandoAcceso}
                          className="text-label text-acento font-medium disabled:text-mudo"
                        >
                          restablecer clave
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => pedirAcceso(fila)}
                        disabled={dandoAcceso}
                        className="text-label font-medium px-[10px] py-[5px] rounded-campo border border-borde-campo bg-superficie hover:bg-panel disabled:bg-riel disabled:text-mudo"
                      >
                        crear acceso
                      </button>
                    )}
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
