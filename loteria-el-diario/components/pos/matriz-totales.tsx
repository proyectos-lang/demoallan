"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { guardarMatrizTotales, type FilaMatriz } from "@/app/(admin)/punto-de-venta/acciones";
import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";
import { fmt, hora12, jornada } from "@/lib/format";
import type { SorteoPos } from "@/lib/pos/use-pos";

/** Sólo dígitos y un punto. Un importe no admite otra cosa. */
const limpiar = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

type Celda = { venta: string; premiado: string };

/**
 * Capturar por totales el padrón entero, en una tabla.
 *
 * POR QUÉ UNA MATRIZ Y NO UN FORMULARIO POR VENDEDOR
 * --------------------------------------------------
 * La hoja de papel de la que se copia tiene forma de tabla: una línea por
 * vendedor, dos cifras. Capturar de uno en uno obligaba a elegir vendedor,
 * teclear, confirmar y volver a empezar —102 vueltas para un día completo, y
 * ya hubo un sorteo con 67 capturas—.
 *
 * SE RECORRE CON EL TECLADO, que es lo que hace rápido teclear cien filas:
 * flechas arriba y abajo para cambiar de vendedor, izquierda y derecha entre
 * venta y premiado, Enter para bajar. Las flechas horizontales sólo saltan de
 * casilla con el cursor en el extremo del texto: dentro de una cifra a medio
 * corregir tienen que seguir moviendo el cursor.
 *
 * LO QUE YA ESTÁ CAPTURADO VIENE RELLENO. Así se ve de un vistazo qué falta, y
 * corregir un dedazo es teclear encima en vez de ir a otra pantalla.
 *
 * NUNCA SE TOCA LA VENTA DEL VENDEDOR. Los tickets con números que él registró
 * son otra fuente y conviven con la captura. La columna «suyo» está para
 * avisar: a quien ya vendió por su teléfono, capturarle además sumaría dos
 * veces.
 */
export function MatrizTotales({
  sorteo,
  sorteos,
  fecha,
  filas,
  onCambiarSorteo,
}: {
  sorteo: SorteoPos;
  sorteos: SorteoPos[];
  fecha: string;
  filas: FilaMatriz[];
  onCambiarSorteo: (fecha: string, sorteoId: string) => void;
}) {
  const router = useRouter();
  const [celdas, setCeldas] = useState<Record<string, Celda>>({});
  const [soloSinVenta, setSoloSinVenta] = useState(false);
  const [busca, setBusca] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [enviando, iniciar] = useTransition();

  // Al cambiar de sorteo, las casillas se rellenan con lo que ya tenga cada
  // uno. Sin esto seguiría en pantalla lo tecleado para el sorteo anterior.
  useEffect(() => {
    const inicial: Record<string, Celda> = {};
    for (const f of filas) {
      inicial[f.vendedorId] = {
        venta: f.venta !== null && f.venta !== 0 ? String(f.venta) : "",
        premiado: f.premiado !== null && f.premiado !== 0 ? String(f.premiado) : "",
      };
    }
    setCeldas(inicial);
    setError("");
    setAviso("");
  }, [filas]);

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return filas.filter((f) => {
      // Quien ya vendió por su teléfono normalmente no necesita captura.
      if (soloSinVenta && f.tickets > 0) return false;
      if (!q) return true;
      return [f.codigo, f.vendedor].some((c) => c.toLowerCase().includes(q));
    });
  }, [filas, soloSinVenta, busca]);

  const valor = (id: string, campo: keyof Celda) => celdas[id]?.[campo] ?? "";

  const editar = (id: string, campo: keyof Celda, v: string) => {
    setCeldas((c) => ({ ...c, [id]: { ...(c[id] ?? { venta: "", premiado: "" }), [campo]: limpiar(v) } }));
    setError("");
    setAviso("");
  };

  /*
   * El teclado. Cada casilla se identifica por fila y columna, y el salto se
   * hace buscando el elemento por su `data`: guardar cien referencias sería
   * más código para el mismo resultado.
   */
  const caja = useRef<HTMLDivElement>(null);

  const irA = (indice: number, campo: keyof Celda) => {
    const destino = visibles[indice];
    if (!destino) return;
    const el = caja.current?.querySelector<HTMLInputElement>(
      `input[data-id="${destino.vendedorId}"][data-campo="${campo}"]`,
    );
    el?.focus();
    el?.select();
  };

  const alTeclear = (
    e: React.KeyboardEvent<HTMLInputElement>,
    indice: number,
    campo: keyof Celda,
  ) => {
    const campoEl = e.currentTarget;
    const alFinal = campoEl.selectionStart === campoEl.value.length;
    const alPrincipio = campoEl.selectionStart === 0;

    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      irA(indice + 1, campo);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      irA(indice - 1, campo);
      return;
    }
    // Horizontales: sólo saltan desde el extremo, para no estorbar al corregir
    // una cifra a medio teclear.
    if (e.key === "ArrowRight" && campo === "venta" && alFinal) {
      e.preventDefault();
      irA(indice, "premiado");
      return;
    }
    if (e.key === "ArrowLeft" && campo === "premiado" && alPrincipio) {
      e.preventDefault();
      irA(indice, "venta");
    }
  };

  /** Lo tecleado, con su cuenta hecha: es lo que se va a guardar. */
  const resumen = useMemo(() => {
    let venta = 0;
    let premios = 0;
    let cuantas = 0;
    let cambian = 0;
    for (const f of filas) {
      const c = celdas[f.vendedorId];
      const v = Number(c?.venta || 0);
      const p = Number(c?.premiado || 0);
      if (v === 0 && p === 0) continue;
      cuantas += 1;
      venta += v;
      premios += p * f.factor;
      // Lo que de verdad cambia respecto a lo guardado.
      if (v !== (f.venta ?? 0) || p !== (f.premiado ?? 0)) cambian += 1;
    }
    return { venta, premios, cuantas, cambian };
  }, [filas, celdas]);

  const guardar = () => {
    iniciar(async () => {
      const r = await guardarMatrizTotales(
        sorteo.id,
        filas.map((f) => ({
          vendedorId: f.vendedorId,
          venta: Number(celdas[f.vendedorId]?.venta || 0),
          premiado: Number(celdas[f.vendedorId]?.premiado || 0),
        })),
      );
      if (!r.ok) {
        setError(r.mensaje);
        return;
      }
      setAviso(r.mensaje);
      router.refresh();
    });
  };

  const CLASE_CELDA =
    "w-full px-2 py-[7px] border rounded-campo text-base text-right outline-none bg-superficie text-tinta tabular-nums focus:border-acento";

  return (
    <div className="flex flex-col gap-4" ref={caja}>
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex flex-col gap-4">
        <div>
          <h2 className="text-h2 font-semibold tracking-sutil m-0">Captura por totales</h2>
          <p className="text-meta text-secundario mt-[5px] mb-0 leading-[1.5]">
            El padrón entero en una tabla: se baja con las flechas y se guarda todo junto.
            Se teclea lo que le jugaron al número que salió, no lo pagado — el factor lo
            aplica el sistema.
          </p>
        </div>

        {/*
          El aviso de siempre: una captura por totales no consume cupo, así que
          la exposición de la casa queda incompleta. Es una decisión tomada, no
          un descuido, pero quien captura tiene que verla cada vez.
        */}
        <p className="text-meta text-ambar-texto bg-ambar-fila-sucia rounded-card px-3 py-2 m-0 leading-[1.5]">
          Una captura por totales <strong>no consume cupo</strong>: no se sabe a qué números
          jugó, así que el tope por número no protege esta venta.
        </p>

        {/* --- Fecha y sorteo: lo único que se elige --- */}
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Fecha</span>
            <input
              type="date"
              value={fecha}
              onChange={(e) => onCambiarSorteo(e.target.value, "")}
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            />
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Sorteo</span>
            <select
              value={sorteo.id}
              onChange={(e) => onCambiarSorteo(fecha, e.target.value)}
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            >
              {sorteos.map((s) => (
                <option key={s.id} value={s.id}>
                  {jornada(s.hora)} · {hora12(s.hora)} · {s.estado}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Buscar vendedor
            </span>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Alias o código"
              className="w-full px-3 py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie text-tinta"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-meta text-cuerpo cursor-pointer self-start">
          <input
            type="checkbox"
            checked={soloSinVenta}
            onChange={(e) => setSoloSinVenta(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-acento)]"
          />
          {/* Quien ya vendió por su teléfono no suele necesitar captura, y
              teclearle una sumaría su día dos veces. */}
          Ocultar a los que ya vendieron por el portal
        </label>
      </div>

      {/* --- La matriz --- */}
      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        <div className="overflow-auto max-h-[62dvh]">
          <table className="w-full border-collapse text-tabla">
            <thead className="sticky top-0 z-10 bg-tinte">
              <tr>
                {["VENDEDOR", "VENTA TOTAL", "VALOR PREMIADO", "SUYO", "PREMIO PAGADO"].map(
                  (h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                        i === 0 ? "text-left pl-4 pr-3" : "text-right px-3",
                        i === 4 && "pr-4",
                      )}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {visibles.map((f, i) => {
                const v = Number(valor(f.vendedorId, "venta") || 0);
                const p = Number(valor(f.vendedorId, "premiado") || 0);
                const tecleado = v > 0 || p > 0;
                const yaEstaba = f.venta !== null;
                return (
                  <tr
                    key={f.vendedorId}
                    className={cn(tecleado && "bg-positivo-fondo/40")}
                  >
                    <td className="border-b border-fondo py-[5px] pl-4 pr-3">
                      <span className="block text-cuerpo truncate max-w-[220px]">
                        {f.vendedor}
                      </span>
                      <span className="block text-label text-mudo">
                        {f.codigo}
                        {yaEstaba && " · ya capturado"}
                      </span>
                    </td>
                    <td className="border-b border-fondo py-[5px] px-3 w-[130px]">
                      <input
                        data-id={f.vendedorId}
                        data-campo="venta"
                        inputMode="decimal"
                        value={valor(f.vendedorId, "venta")}
                        onChange={(e) => editar(f.vendedorId, "venta", e.target.value)}
                        onKeyDown={(e) => alTeclear(e, i, "venta")}
                        onFocus={(e) => e.currentTarget.select()}
                        placeholder="0"
                        className={cn(
                          CLASE_CELDA,
                          tecleado ? "border-acento-suave" : "border-borde-campo",
                        )}
                      />
                    </td>
                    <td className="border-b border-fondo py-[5px] px-3 w-[130px]">
                      <input
                        data-id={f.vendedorId}
                        data-campo="premiado"
                        inputMode="decimal"
                        value={valor(f.vendedorId, "premiado")}
                        onChange={(e) => editar(f.vendedorId, "premiado", e.target.value)}
                        onKeyDown={(e) => alTeclear(e, i, "premiado")}
                        onFocus={(e) => e.currentTarget.select()}
                        placeholder="0"
                        className={cn(
                          CLASE_CELDA,
                          tecleado ? "border-acento-suave" : "border-borde-campo",
                        )}
                      />
                    </td>
                    {/*
                      Lo que vendió por su teléfono. No se puede tocar desde
                      aquí —es su venta, con números y folio— y se muestra para
                      avisar: capturarle además sumaría su día dos veces.
                    */}
                    <td
                      className={cn(
                        "border-b border-fondo py-[5px] px-3 text-right tabular-nums",
                        f.tickets > 0 ? "text-ambar-texto" : "text-mudo",
                      )}
                    >
                      {f.tickets > 0 ? fmt(f.ventaPropia, false) : "—"}
                    </td>
                    <td className="border-b border-fondo py-[5px] px-3 pr-4 text-right tabular-nums text-secundario">
                      {p > 0 ? fmt(p * f.factor, false) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visibles.length === 0 && (
          <p className="text-meta text-secundario px-4 py-5 m-0">
            Ningún vendedor coincide con el filtro.
          </p>
        )}

        {/* --- El pie: la cuenta y el guardado --- */}
        <div className="px-4 py-3 bg-tinte border-t border-riel flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-6 flex-wrap">
            <Cifra
              etiqueta="CON CIFRA"
              valor={`${resumen.cuantas} de ${filas.length}`}
            />
            <Cifra etiqueta="VENTA" valor={fmt(resumen.venta)} />
            <Cifra
              etiqueta="PREMIO PAGADO"
              valor={resumen.premios > 0 ? fmt(resumen.premios) : "—"}
            />
          </div>
          <div className="flex items-center gap-3">
            {resumen.cambian === 0 && resumen.cuantas > 0 && (
              <span className="text-meta text-secundario">Nada que guardar</span>
            )}
            <Boton onClick={guardar} disabled={enviando || resumen.cambian === 0}>
              {enviando
                ? "Guardando…"
                : `Guardar ${resumen.cambian || ""} ${
                    resumen.cambian === 1 ? "fila" : "filas"
                  }`.trim()}
            </Boton>
          </div>
        </div>
      </div>

      {error && (
        <p className="text-meta text-negativo bg-negativo-fondo rounded-card px-3 py-2 m-0">
          {error}
        </p>
      )}
      {aviso && (
        <p className="text-meta text-positivo-texto bg-positivo-fondo rounded-card px-3 py-2 m-0">
          {aviso}
        </p>
      )}
    </div>
  );
}

function Cifra({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <span className="block text-th font-semibold tracking-th text-secundario">
        {etiqueta}
      </span>
      <span className="block text-cta font-semibold tabular-nums mt-[2px]">{valor}</span>
    </div>
  );
}
