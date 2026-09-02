"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  anularVentaPorTotales,
  registrarVentaPorTotales,
} from "@/app/(admin)/punto-de-venta/acciones";
import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";
import { fmt, hora12, jornada } from "@/lib/format";
import type { SorteoPos, VendedorPos } from "@/lib/pos/use-pos";

export type CapturaExistente = {
  id: string;
  vendedorId: string;
  vendedor: string;
  venta: number;
  premios: number;
  comision: number;
};

const CLASE_CAMPO =
  "w-full px-3 py-[11px] border border-borde-campo rounded-campo text-pos text-right outline-none bg-superficie text-tinta";

/** Sólo dígitos y un punto. Un importe no admite otra cosa. */
function limpiar(v: string): string {
  return v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
}

/**
 * Captura por totales: venta y premio, sin número por número.
 *
 * Es la puerta para cuando el vendedor no usó el portal —trabajó en papel y
 * entrega su cuenta al final del día—. Sin esto, ese día no existe en el
 * sistema y todos los indicadores mienten por omisión.
 *
 * LO QUE ESTA PANTALLA TIENE QUE DECIR, Y DICE
 * --------------------------------------------
 * Una captura por totales NO consume cupo, porque no se sabe a qué números
 * jugó. Eso significa que la exposición de la casa en ese sorteo queda
 * incompleta y el tope por número no protege esa venta. Es una decisión
 * tomada, no un descuido, pero quien captura tiene que verla cada vez: por eso
 * el aviso es fijo y no se puede cerrar.
 *
 * SE TECLEA LO PREMIADO, NO LO PAGADO. El vendedor apunta en su hoja cuánto le
 * jugaron al número que salió; multiplicar por el factor es aritmética, y la
 * aritmética la hace la máquina. Pedir el premio ya multiplicado obligaba a
 * quien captura a sacar la calculadora y a acertar con el factor de ESE
 * vendedor, que no es 70 para todos.
 *
 * El resultado se acepta tal cual: sin números no hay con qué contrastarlo
 * contra el ganador, así que la responsabilidad de lo premiado es de quien
 * teclea. Queda auditado y se puede anular.
 */
export function CapturaTotales({
  sorteo,
  sorteos,
  fecha,
  vendedores,
  capturas,
}: {
  sorteo: SorteoPos;
  /** Los tres del día elegido, con su estado. */
  sorteos: SorteoPos[];
  fecha: string;
  vendedores: VendedorPos[];
  capturas: CapturaExistente[];
}) {
  const router = useRouter();
  const [vendedorId, setVendedorId] = useState("");
  const [venta, setVenta] = useState("");
  const [premiado, setPremiado] = useState("");
  const [nota, setNota] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [enviando, iniciar] = useTransition();

  /*
   * La fecha y el sorteo viven en la dirección, no en estado local.
   *
   * Cambiarlos tiene que volver a pedir al servidor las capturas de ESE
   * sorteo: si sólo cambiara un estado de React, la lista de abajo seguiría
   * enseñando las del sorteo anterior y se anularía la que no era.
   */
  const irA = (nuevaFecha: string, nuevoSorteo: string) => {
    const p = new URLSearchParams({ modo: "totales", fecha: nuevaFecha });
    if (nuevoSorteo) p.set("sorteo", nuevoSorteo);
    iniciar(() => router.push(`/punto-de-venta?${p.toString()}`));
  };

  const vendedor = vendedores.find((v) => v.id === vendedorId);
  const nVenta = Number(venta || 0);
  const nPremiado = Number(premiado || 0);

  /*
   * El premio pagado sale de multiplicar lo premiado por el factor del
   * vendedor, que es lo que hace la base con cada línea ganadora. Aquí se
   * calcula sólo para enseñarlo antes de confirmar; lo que viaja al servidor es
   * este mismo número, porque `venta_total` guarda el premio ya pagado —así la
   * liquidación suma sin tener que saber de dónde vino cada parte.
   */
  const factor = vendedor?.factor_pago ?? 0;
  const nPremios = nPremiado * factor;

  // La misma cuenta que hará la base, para que no haya sorpresa al confirmar.
  const comision = vendedor ? nVenta * vendedor.comision : 0;
  const saldo = nVenta - comision - nPremios;
  const listo = Boolean(vendedorId) && (nVenta > 0 || nPremiado > 0);

  const registrar = () => {
    setError("");
    setAviso("");
    iniciar(async () => {
      const r = await registrarVentaPorTotales(sorteo.id, vendedorId, nVenta, nPremios, nota);
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso(r.mensaje);
      setVenta("");
      setPremiado("");
      setNota("");
      setVendedorId("");
    });
  };

  const anular = (id: string) => {
    setError("");
    setAviso("");
    iniciar(async () => {
      const r = await anularVentaPorTotales(id);
      if (!r.ok) setError(r.mensaje);
      else setAviso(r.mensaje);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex flex-col gap-4">
        <div>
          <h2 className="text-h2 font-semibold tracking-sutil m-0">Captura por totales</h2>
          <p className="text-meta text-secundario mt-[5px] mb-0 leading-[1.5]">
            Para el vendedor que no registró por el portal: se anota lo que vendió y cuánto le
            jugaron al número que salió, sin el detalle. El premio pagado lo calcula el sistema
            con el factor del vendedor. Entra en la liquidación como cualquier otra venta.
          </p>
        </div>

        {/*
          Aviso fijo y sin cerrar: es la consecuencia de la decisión de diseño,
          y quien captura debe verla cada vez, no una sola.
        */}
        <p className="text-meta text-ambar-texto bg-ambar-fondo rounded-banner px-[13px] py-[10px] m-0 leading-[1.5]">
          Esta captura <strong>no consume cupo</strong>: como no se sabe a qué números jugó, el
          mapa de exposición del sorteo queda incompleto y el tope por número no protege esta
          venta. Lo premiado se registra tal cual, sin contrastarlo con el número ganador.
        </p>

        {/*
          A qué sorteo pertenece. Se elige aquí y no se hereda de la rejilla:
          el caso normal de esta pantalla es regularizar algo de ayer, y la
          fecha por omisión —hoy— casi nunca es la buena.
        */}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))] pb-4 border-b border-riel">
          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Fecha</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => e.target.value && irA(e.target.value, "")}
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            />
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Sorteo</span>
            <select
              value={sorteo.id}
              onChange={(e) => irA(fecha, e.target.value)}
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            >
              {sorteos.map((s) => (
                <option key={s.id} value={s.id}>
                  {jornada(s.hora)} · {hora12(s.hora)} · {s.estado}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
            <select
              value={vendedorId}
              onChange={(e) => setVendedorId(e.target.value)}
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            >
              <option value="">Elija un vendedor…</option>
              {vendedores.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.codigo} · {v.nombre}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Venta total
            </span>
            <input
              inputMode="decimal"
              value={venta}
              onChange={(e) => setVenta(limpiar(e.target.value))}
              placeholder="0"
              className={CLASE_CAMPO}
            />
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Valor premiado{" "}
              <span className="text-mudo">(lo que le jugaron al ganador)</span>
            </span>
            <input
              inputMode="decimal"
              value={premiado}
              onChange={(e) => setPremiado(limpiar(e.target.value))}
              placeholder="0"
              className={CLASE_CAMPO}
            />
            {vendedor && nPremiado > 0 && (
              <span className="block text-label text-secundario mt-[5px]">
                × {factor.toFixed(0)} de factor = {fmt(nPremios)} de premio pagado
              </span>
            )}
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Nota <span className="text-mudo">(opcional)</span>
            </span>
            <input
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Entregó hoja escrita…"
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            />
          </label>
        </div>

        {/* La cuenta, antes de confirmar: la comisión sale del parámetro del
            vendedor, no se teclea. */}
        {vendedor && (
          <div className="bg-panel border border-borde rounded-card px-4 py-3 grid gap-x-8 gap-y-[6px] [grid-template-columns:1fr_auto] items-baseline">
            <span className="text-tabla text-cuerpo">Venta</span>
            <span className="text-tabla text-right font-medium">{fmt(nVenta, false)}</span>

            <span className="text-tabla text-cuerpo">
              Comisión{" "}
              <span className="text-label text-mudo">
                ({(vendedor.comision * 100).toFixed(2)} %, vigente)
              </span>
            </span>
            <span className="text-tabla text-right font-medium">{fmt(comision, false)}</span>

            <span className="text-tabla text-cuerpo">
              Premio pagado{" "}
              <span className="text-label text-mudo">
                ({fmt(nPremiado, false)} × {factor.toFixed(0)})
              </span>
            </span>
            <span className="text-tabla text-right font-medium">{fmt(nPremios, false)}</span>

            <span className="text-eyebrow font-semibold tracking-seccion text-secundario border-t border-riel pt-2">
              {saldo >= 0 ? "EL VENDEDOR ENTREGA" : "LA EMPRESA LE ENTREGA"}
            </span>
            <span
              className={cn(
                "text-h1 font-semibold tracking-titular text-right border-t border-riel pt-2",
                saldo < 0 && "text-negativo",
              )}
            >
              {fmt(Math.abs(saldo))}
            </span>
          </div>
        )}

        {error && <p className="text-meta text-negativo m-0">{error}</p>}
        {aviso && (
          <p className="text-tabla text-positivo-texto bg-positivo-fondo rounded-banner px-[13px] py-[10px] m-0">
            {aviso}
          </p>
        )}

        <div className="flex items-center gap-[10px] flex-wrap">
          {sorteo.estado === "liquidado" && (
            <span className="text-meta text-ambar-texto">
              Ese sorteo ya está liquidado: la captura se sumará y su liquidación se rehará en el
              acto.
            </span>
          )}
          <Boton onClick={registrar} disabled={!listo || enviando} className="ml-auto">
            {enviando ? "Registrando…" : "Registrar"}
          </Boton>
        </div>
      </div>

      {capturas.length > 0 && (
        <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
          <div className="px-[18px] py-[13px] border-b border-riel">
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              Capturas de este sorteo
            </h2>
            <p className="text-meta text-secundario mt-[4px] mb-0">
              Para corregir una, se anula y se vuelve a registrar: no se edita, para que quede el
              rastro de lo que dijo antes.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-tabla min-w-[620px]">
              <thead>
                <tr className="bg-tinte">
                  {["VENDEDOR", "VENTA", "COMISIÓN", "PREMIO", "SALDO", ""].map((th, i) => (
                    <th
                      key={th || "acciones"}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                        i === 0 ? "text-left pl-4 pr-3" : i === 5 ? "pr-4" : "text-right px-3",
                      )}
                    >
                      {th}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {capturas.map((c) => {
                  const s = c.venta - c.comision - c.premios;
                  return (
                    <tr key={c.id}>
                      <td className="border-b border-fondo py-[9px] pl-4 pr-3 font-medium">
                        {c.vendedor}
                      </td>
                      <td className="border-b border-fondo py-[9px] px-3 text-right">
                        {fmt(c.venta, false)}
                      </td>
                      <td className="border-b border-fondo py-[9px] px-3 text-right text-cuerpo">
                        {fmt(c.comision, false)}
                      </td>
                      <td className="border-b border-fondo py-[9px] px-3 text-right text-cuerpo">
                        {fmt(c.premios, false)}
                      </td>
                      <td
                        className={cn(
                          "border-b border-fondo py-[9px] px-3 text-right font-semibold",
                          s < 0 && "text-negativo",
                        )}
                      >
                        {fmt(s, false)}
                      </td>
                      <td className="border-b border-fondo py-[9px] pr-4 text-right">
                        <button
                          type="button"
                          onClick={() => anular(c.id)}
                          disabled={enviando}
                          className="text-meta text-negativo font-medium"
                        >
                          anular
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
