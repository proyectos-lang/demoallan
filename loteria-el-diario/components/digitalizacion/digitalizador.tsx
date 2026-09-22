"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";
import { fmt, hora12, pad2, rotulo } from "@/lib/format";
import {
  confirmarLote,
  digitalizarHoja,
  rechazarLote,
  type LineaPropuesta,
} from "@/app/(admin)/digitalizacion/acciones";

const CONFIANZA_BAJA = 0.85;

export type OpcionVendedor = { id: string; nombre: string; alias?: string | null; codigo: string };
export type OpcionSorteo = { id: string; fecha: string; hora: string };

type Fila = LineaPropuesta & { corregida?: boolean };

const CLASE_CONTROL =
  "px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie";

export function Digitalizador({
  vendedores,
  sorteos,
  propio = false,
}: {
  vendedores: OpcionVendedor[];
  sorteos: OpcionSorteo[];
  /**
   * Modo del propio vendedor: no elige a nombre de quién sube la hoja —sale de
   * su sesión— y el total del papel deja de ser opcional. Quien tiene la hoja
   * delante es él, así que suplirlo con la lectura del modelo sería quitar el
   * control justo donde puede fallar la lectura.
   */
  propio?: boolean;
}) {
  const [vendedor, setVendedor] = useState(vendedores[0]?.id ?? "");
  const [sorteo, setSorteo] = useState(sorteos[0]?.id ?? "");
  const [total, setTotal] = useState("");
  // Subir sin teclear el total: se aprueba si las tres lecturas coinciden. Sólo
  // admin/digitador (no el vendedor, que tiene el papel delante).
  const [sinTotal, setSinTotal] = useState(false);
  // Cuando el cuadre lo aprobó la triple coincidencia y no un total tecleado.
  const [porLecturas, setPorLecturas] = useState(false);
  const [vistaPrevia, setVistaPrevia] = useState<string | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);

  const [loteId, setLoteId] = useState<string | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [encabezado, setEncabezado] = useState<{ nombre: string; fecha: string; franja: string } | null>(null);
  const [declarado, setDeclarado] = useState<number | null>(null);
  const [costo, setCosto] = useState(0);
  const [mensaje, setMensaje] = useState<{ texto: string; tipo: "ok" | "error" | "neutro" }>({
    texto: "",
    tipo: "neutro",
  });
  const [trabajando, iniciar] = useTransition();
  const inputArchivo = useRef<HTMLInputElement>(null);

  const suma = useMemo(
    () => filas.reduce((a, f) => a + (parseInt(f.monto || "0", 10) || 0), 0),
    [filas],
  );
  const diferencia = declarado === null ? null : suma - declarado;
  const cuadra = diferencia === 0;
  const porRevisar = filas.filter((f) => f.confianza < CONFIANZA_BAJA && !f.corregida).length;

  const elegirArchivo = (f: File | null) => {
    setArchivo(f);
    setVistaPrevia(f ? URL.createObjectURL(f) : null);
    reiniciarLote();
  };

  const reiniciarLote = () => {
    setLoteId(null);
    setFilas([]);
    setAvisos([]);
    setEncabezado(null);
    setDeclarado(null);
    setPorLecturas(false);
    setCosto(0);
    setMensaje({ texto: "", tipo: "neutro" });
  };

  // El total se pide salvo que se marque «subir sin total» (sólo admin/digitador).
  const exigeTotal = propio || !sinTotal;

  const leer = () => {
    if (!archivo) return setMensaje({ texto: "Seleccione la fotografía de la hoja.", tipo: "error" });
    if (exigeTotal && !total) {
      return setMensaje({
        texto: "Escriba el total de la hoja antes de leerla: sin él no hay control de cuadre.",
        tipo: "error",
      });
    }

    const datos = new FormData();
    datos.set("hoja", archivo);
    datos.set("vendedor", vendedor);
    datos.set("sorteo", sorteo);
    // Sin total sólo si se pidió expresamente; si no, va el tecleado.
    datos.set("total", exigeTotal ? total : "");

    iniciar(async () => {
      const r = await digitalizarHoja(datos);
      if (!r.ok) return setMensaje({ texto: r.mensaje, tipo: "error" });

      setLoteId(r.loteId);
      setFilas(r.lineas);
      setAvisos(r.avisos);
      setEncabezado(r.encabezado);
      setDeclarado(r.totalDeclarado);
      setPorLecturas(r.aprobadoPorLecturas);
      setCosto(r.costoUsd);
      setMensaje(
        r.aprobadoPorLecturas
          ? {
              texto:
                "Cuadre aprobado por las tres lecturas: coincidieron en todos los renglones, así que la suma es el total.",
              tipo: "ok",
            }
          : { texto: "", tipo: "neutro" },
      );
    });
  };

  const editar = (i: number, campo: "numero" | "monto", valor: string) => {
    const limpio = valor.replace(/\D/g, "").slice(0, campo === "numero" ? 2 : 6);
    setFilas((f) =>
      f.map((x, j) => (j === i ? { ...x, [campo]: limpio, corregida: true } : x)),
    );
    setMensaje({ texto: "", tipo: "neutro" });
  };

  /** Al elegir una variante, la celda queda resuelta por decisión humana. */
  const elegirVariante = (i: number, variante: string) => {
    const [numero, monto] = variante.split(":");
    setFilas((f) =>
      f.map((x, j) => (j === i ? { ...x, numero, monto, corregida: true } : x)),
    );
  };

  const confirmar = () => {
    if (!loteId || !cuadra) return;
    iniciar(async () => {
      const r = await confirmarLote(
        loteId,
        filas.map((f) => ({ numero: Number(f.numero), monto: Number(f.monto) })),
      );
      if (!r.ok) return setMensaje({ texto: r.mensaje, tipo: "error" });
      setMensaje({
        texto: `Lote validado: ${r.lineas} líneas registradas en el ticket ${r.folio}, canal ocr, imagen vinculada como respaldo.`,
        tipo: "ok",
      });
      setLoteId(null);
      setFilas([]);
      setArchivo(null);
      setVistaPrevia(null);
      setTotal("");
      if (inputArchivo.current) inputArchivo.current.value = "";
    });
  };

  const rechazar = () => {
    if (!loteId) return;
    iniciar(async () => {
      const r = await rechazarLote(loteId, "descartado por el operador");
      setMensaje({ texto: r.mensaje, tipo: r.ok ? "neutro" : "error" });
      if (r.ok) reiniciarLote();
    });
  };

  // Los renglones dudosos primero: es donde el operador tiene que mirar.
  const orden = useMemo(
    () =>
      filas
        .map((f, i) => ({ f, i }))
        .sort((a, b) => a.f.confianza - b.f.confianza || a.i - b.i),
    [filas],
  );

  return (
    <div className="flex flex-col gap-[14px]">
      {/* --- Carga --- */}
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
        <div className="flex gap-4 flex-wrap items-end">
          {!propio && (
            <label className="block">
              <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
              <select
                value={vendedor}
                onChange={(e) => setVendedor(e.target.value)}
                className={cn(CLASE_CONTROL, "min-w-[240px]")}
              >
                {vendedores.map((v) => (
                  <option key={v.id} value={v.id}>
                    {rotulo(v)} · {v.codigo}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Sorteo destino
            </span>
            <select
              value={sorteo}
              onChange={(e) => setSorteo(e.target.value)}
              className={CLASE_CONTROL}
            >
              {sorteos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fecha} · {hora12(s.hora)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Total de la hoja (L){propio && <span className="text-negativo"> ·  obligatorio</span>}
            </span>
            <input
              value={sinTotal && !propio ? "" : total}
              onChange={(e) => setTotal(e.target.value.replace(/\D/g, "").slice(0, 7))}
              inputMode="numeric"
              disabled={sinTotal && !propio}
              placeholder={sinTotal && !propio ? "lo dan las lecturas" : propio ? "el que sumó" : "contado"}
              className={cn(CLASE_CONTROL, "w-[140px] text-right", sinTotal && !propio && "opacity-50")}
            />
          </label>

          {/* Subir sin total: sólo admin/digitador. El cuadre lo aprueba la
              triple coincidencia de las lecturas. El vendedor no lo ve: a él se
              le exige el total siempre. */}
          {!propio && (
            <label className="flex items-center gap-2 pb-[9px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sinTotal}
                onChange={(e) => {
                  setSinTotal(e.target.checked);
                  reiniciarLote();
                }}
                className="w-4 h-4 accent-[var(--color-acento)]"
              />
              <span className="text-meta text-cuerpo">
                Subir sin total{" "}
                <span className="text-mudo">(aprueba si las 3 lecturas coinciden)</span>
              </span>
            </label>
          )}

          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">Hoja</span>
            <input
              ref={inputArchivo}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => elegirArchivo(e.target.files?.[0] ?? null)}
              className="text-meta text-cuerpo file:mr-3 file:px-[13px] file:py-[7px] file:rounded-campo file:border file:border-borde-campo file:bg-superficie file:text-cuerpo file:text-meta file:cursor-pointer"
            />
          </label>

          <Boton onClick={leer} disabled={trabajando || !archivo || (exigeTotal && !total)}>
            {trabajando && !loteId ? "Leyendo…" : "Leer hoja"}
          </Boton>
        </div>

        <p className="text-meta text-secundario leading-[1.55] mt-3 mb-0 max-w-[80ch]">
          {sinTotal && !propio
            ? "Sin total tecleado, la hoja se aprueba sólo si las tres lecturas coinciden en todos los renglones —ahí la suma es segura—. Si alguna difiere, tendrás que teclear el total o revisar los renglones marcados."
            : "Las hojas observadas no traen el total escrito, así que hay que teclearlo: es lo único que permite detectar un renglón que la lectura omitió. Sin él la confirmación queda bloqueada."}
        </p>
      </div>

      {mensaje.texto && (
        <div
          className={cn(
            "rounded-card px-[17px] py-[15px] text-tabla border",
            mensaje.tipo === "error"
              ? "bg-negativo-fondo border-negativo-borde text-negativo-texto"
              : mensaje.tipo === "ok"
                ? "bg-positivo-fondo border-positivo-borde text-positivo-texto"
                : "bg-panel border-borde text-cuerpo",
          )}
        >
          {mensaje.texto}
        </div>
      )}

      {filas.length > 0 && (
        <div className="flex gap-[18px] flex-wrap lg:flex-nowrap items-start">
          {/* --- Hoja original ---
              En móvil va DESPUÉS de la revisión (`order-2`): lo primero es
              cuadrar y registrar los números; la foto es respaldo, se mira si
              hace falta. En escritorio recupera su sitio a la izquierda. */}
          <div className="order-2 lg:order-1 w-full lg:flex-1 lg:min-w-[320px] lg:max-w-[400px] bg-superficie border border-borde rounded-card shadow-card px-[18px] py-4">
            <h2 className="text-card font-semibold m-0">Hoja original</h2>
            {vistaPrevia && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={vistaPrevia}
                alt="Hoja manuscrita digitalizada"
                className="w-full h-auto rounded-pos border border-borde mt-3"
              />
            )}

            {encabezado && (encabezado.nombre || encabezado.fecha || encabezado.franja) && (
              <div className="mt-3 text-meta text-cuerpo leading-[1.6]">
                Cabecera leída: <strong className="font-semibold">{encabezado.nombre || "—"}</strong>
                {encabezado.fecha && ` · ${encabezado.fecha}`}
                {encabezado.franja && ` · ${encabezado.franja}`}
              </div>
            )}

            <div className="border-t border-riel mt-3 pt-3 flex flex-col gap-2">
              {[
                ["Renglones leídos", String(filas.length)],
                ["A revisar", String(porRevisar)],
                ["Costo de este lote", `$${costo.toFixed(4)}`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between text-meta">
                  <span className="text-secundario">{k}</span>
                  <strong className="font-semibold">{v}</strong>
                </div>
              ))}
            </div>

            <p className="text-label text-mudo leading-[1.55] mt-3 mb-0">
              La hoja se lee tres veces. Lo que se marca para revisión no es lo que el modelo dice
              dudar, sino donde las lecturas no coincidieron entre sí.
            </p>
          </div>

          {/* --- Revisión --- */}
          <div className="order-1 lg:order-2 w-full lg:flex-1 min-w-0 lg:min-w-[520px] bg-superficie border border-borde rounded-card shadow-card px-3 sm:px-[18px] py-4">
            <div className="flex justify-between items-baseline flex-wrap gap-2">
              <h2 className="text-h2 font-semibold tracking-sutil m-0">Renglones extraídos</h2>
              <button
                onClick={() =>
                  setFilas((f) => [...f, { numero: "", monto: "", confianza: 1, grupo: 0, corregida: true }])
                }
                className="border border-borde-campo bg-superficie text-acento-fuerte rounded-campo px-[13px] py-[7px] text-meta font-semibold cursor-pointer hover:bg-panel"
              >
                + Agregar línea omitida
              </button>
            </div>

            {avisos.length > 0 && (
              <div className="bg-ambar-fondo text-ambar-texto rounded-banner px-[13px] py-[11px] text-meta mt-3 flex flex-col gap-1">
                {avisos.map((a) => (
                  <span key={a}>{a}</span>
                ))}
              </div>
            )}

            {/* La cabecera de columnas sólo desde `sm`: en móvil la fila es
                condensada (número · monto · acción) y no se alinea a estas
                columnas anchas. */}
            <div className="hidden sm:flex gap-[10px] text-eyebrow font-semibold tracking-eyebrow text-mudo mt-4 px-[10px]">
              <span className="w-[70px]">FILA</span>
              <span className="w-[78px]">NÚMERO</span>
              <span className="w-[96px] text-right">MONTO (L)</span>
              <span className="flex-1">ESTADO</span>
            </div>

            <div className="flex flex-col gap-[6px] mt-2 max-h-[520px] overflow-y-auto">
              {orden.map(({ f, i }) => {
                const dudosa = f.confianza < CONFIANZA_BAJA && !f.corregida;
                return (
                  <div
                    key={i}
                    className={cn(
                      "rounded-banner border px-2 sm:px-[10px] py-2 sm:py-[9px]",
                      // En móvil, la fila condensada; desde `sm`, la de columnas.
                      "flex flex-wrap sm:flex-nowrap items-center gap-x-2 sm:gap-[10px] gap-y-1",
                      dudosa
                        ? "bg-negativo-fila border-negativo-borde"
                        : "bg-tinte border-riel",
                    )}
                  >
                    {/* Etiqueta de fila: fina en móvil, columna fija en escritorio. */}
                    <span className="w-auto sm:w-[70px] text-label text-mudo whitespace-nowrap">
                      {f.grupo > 0 ? `#${f.grupo}` : "+"}
                    </span>
                    {/* NÚMERO y MONTO, todo en una línea. Angostos en móvil para
                        que quepan número, monto y la × sin desbordar. */}
                    <input
                      value={f.numero}
                      onChange={(e) => editar(i, "numero", e.target.value)}
                      inputMode="numeric"
                      aria-label="Número"
                      placeholder="nº"
                      className="w-[54px] sm:w-[78px] px-2 sm:px-[10px] py-2 sm:py-[6px] rounded-campo border border-borde-campo text-pos font-semibold text-center sm:text-left outline-none bg-superficie"
                    />
                    <span className="text-mudo text-meta sm:hidden">×</span>
                    <input
                      value={f.monto}
                      onChange={(e) => editar(i, "monto", e.target.value)}
                      inputMode="numeric"
                      aria-label="Monto"
                      placeholder="L"
                      className="flex-1 sm:flex-none min-w-0 w-auto sm:w-[96px] px-2 sm:px-[10px] py-2 sm:py-[6px] rounded-campo border border-borde-campo text-pos font-semibold text-right outline-none bg-superficie"
                    />
                    <button
                      onClick={() => setFilas((x) => x.filter((_, j) => j !== i))}
                      className="border-0 bg-transparent text-negativo text-modal leading-none px-1 cursor-pointer order-last sm:order-none"
                      aria-label="Descartar renglón"
                    >
                      ×
                    </button>
                    {/* El ESTADO: en escritorio ocupa su columna; en móvil pasa a
                        una segunda línea SÓLO cuando hay algo que resolver
                        (dudoso o corregido), para no gastar alto en «coinciden». */}
                    <span
                      className={cn(
                        "text-meta w-full sm:w-auto sm:flex-1 order-last",
                        // En móvil se oculta cuando las tres lecturas coinciden:
                        // no aporta y alarga la lista.
                        !f.corregida && !(dudosa && f.alternativas) && "hidden sm:block",
                      )}
                    >
                      {f.corregida ? (
                        <span className="text-positivo">corregido por el operador</span>
                      ) : dudosa && f.alternativas ? (
                        <span className="flex items-center gap-2 flex-wrap">
                          <span className="text-negativo-texto">las lecturas difieren:</span>
                          {f.alternativas.map((alt) => (
                            <button
                              key={alt}
                              onClick={() => elegirVariante(i, alt)}
                              className="rounded-celda border border-negativo-borde bg-superficie px-2 py-2 sm:py-[3px] text-meta font-semibold cursor-pointer hover:bg-panel"
                            >
                              {pad2(alt.split(":")[0])} × {alt.split(":")[1] || "—"}
                            </button>
                          ))}
                        </span>
                      ) : (
                        <span className="text-secundario">las tres lecturas coinciden</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* --- Cuadre --- */}
            <div
              className={cn(
                "rounded-pos px-[17px] py-[15px] mt-4 border flex justify-between items-center flex-wrap gap-4",
                cuadra
                  ? "bg-positivo-fondo border-positivo-borde text-positivo-texto"
                  : "bg-negativo-fondo border-negativo-borde text-negativo-texto",
              )}
            >
              <span className="text-tabla font-medium max-w-[42ch]">
                {cuadra
                  ? porLecturas
                    ? "Cuadre aprobado por las tres lecturas: coincidieron en todos los renglones."
                    : "Cuadre correcto: la suma coincide con el total declarado."
                  : "Descuadre: revise renglones omitidos o montos mal leídos."}
              </span>
              <span className="flex gap-4 sm:gap-5 text-meta sm:text-tabla flex-wrap">
                <span>
                  suma <strong className="font-semibold">{fmt(suma, false)}</strong>
                </span>
                <span>
                  declarado <strong className="font-semibold">{fmt(declarado ?? 0, false)}</strong>
                </span>
                <span>
                  diferencia{" "}
                  <strong className="font-semibold">
                    {diferencia !== null && diferencia > 0 ? "+" : ""}
                    {fmt(diferencia ?? 0, false)}
                  </strong>
                </span>
              </span>
            </div>

            <div className="flex gap-[10px] mt-4 flex-wrap">
              <Boton
                tamano="lg"
                variante="oscuro"
                onClick={confirmar}
                disabled={!cuadra || trabajando}
                className="flex-1 min-w-[230px]"
              >
                {trabajando ? "Registrando…" : "Confirmar y crear tickets"}
              </Boton>
              <Boton variante="ghost" onClick={rechazar} disabled={trabajando}>
                Rechazar lote
              </Boton>
            </div>

            {!cuadra && diferencia !== null && (
              <p className="text-meta text-negativo mt-3 mb-0">
                {diferencia < 0
                  ? `Faltan ${fmt(-diferencia)} para cuadrar: probablemente un renglón sin leer.`
                  : `Sobran ${fmt(diferencia)}: revise si un monto se leyó de más.`}{" "}
                La confirmación queda bloqueada mientras la suma no coincida.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
