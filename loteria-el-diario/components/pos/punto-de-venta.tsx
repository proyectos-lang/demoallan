"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { registrarTicket, type LineaVenta } from "@/app/(admin)/punto-de-venta/acciones";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, horaHonduras, pad2 } from "@/lib/format";

export type VendedorPos = {
  id: string;
  codigo: string;
  nombre: string;
  /** Fracción, como en la base. */
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

export type DatosPos = {
  sorteo: { id: string; hora: string; hora_cierre: string };
  vendedores: VendedorPos[];
  /** Por número: lo que le queda a la casa. */
  disponibleCasa: number[];
  /** Por vendedor y número: lo que ese vendedor ya vendió. */
  vendidoPropio: Record<string, number[]>;
  /**
   * Modo del propio vendedor: el selector desaparece porque el vendedor sale
   * de la sesión, no de una lista. Quién vende de verdad lo decide el servidor
   * en la acción de registro; esto es sólo la interfaz.
   */
  propio?: boolean;
};

type Modo = "teclado" | "rapida" | "rejilla";
type Foco = "numero" | "monto";

const MODOS: { id: Modo; etiqueta: string }[] = [
  { id: "teclado", etiqueta: "Teclado" },
  { id: "rapida", etiqueta: "Línea rápida" },
  { id: "rejilla", etiqueta: "Rejilla 00–99" },
];

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "←"];
const MONTOS_RAPIDOS = [10, 20, 50, 100];
const ATAJOS: [number, number][] = [
  [47, 50],
  [23, 20],
  [88, 100],
  [5, 10],
];

/** Umbral bajo el cual el cupo se pinta en ámbar, como el prototipo. */
const CUPO_BAJO = 300;

export function PuntoDeVenta({ datos }: { datos: DatosPos }) {
  const [vendedorId, setVendedorId] = useState(datos.vendedores[0]?.id ?? "");
  const [modo, setModo] = useState<Modo>("teclado");
  const [numero, setNumero] = useState("");
  const [monto, setMonto] = useState("");
  const [foco, setFoco] = useState<Foco>("numero");
  const [carrito, setCarrito] = useState<LineaVenta[]>([]);
  const [rapidaTexto, setRapidaTexto] = useState("");
  const [rapidaAviso, setRapidaAviso] = useState("");
  const [rapidaOk, setRapidaOk] = useState<boolean | null>(null);
  const [ticket, setTicket] = useState<{ folio: string; lineas: LineaVenta[]; total: number } | null>(null);
  const [errorVenta, setErrorVenta] = useState("");
  const [ahora, setAhora] = useState(() => Date.now());
  const [enviando, iniciar] = useTransition();

  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const vendedor = datos.vendedores.find((v) => v.id === vendedorId) ?? datos.vendedores[0];

  /**
   * Cupo disponible por número: el mínimo entre lo que le queda a la casa y lo
   * que le queda al vendedor, descontando además lo que ya lleva en el carrito
   * pero todavía no ha confirmado.
   */
  const disponible = useMemo(() => {
    const propio = datos.vendidoPropio[vendedorId] ?? new Array(100).fill(0);
    const enCarrito = new Array(100).fill(0);
    for (const l of carrito) enCarrito[l.numero] += l.monto;

    return Array.from({ length: 100 }, (_, n) =>
      Math.max(
        0,
        Math.min(
          datos.disponibleCasa[n] - enCarrito[n],
          (vendedor?.tope_por_numero ?? 0) - propio[n] - enCarrito[n],
        ),
      ),
    );
  }, [datos, vendedorId, carrito, vendedor]);

  const numeroActual = numero.length === 2 ? parseInt(numero, 10) : null;
  const disp = numeroActual != null ? disponible[numeroActual] : null;
  const montoNum = parseInt(monto || "0", 10);
  const totalTicket = carrito.reduce((a, l) => a + l.monto, 0);
  const puedeAgregar = disp != null && disp > 0 && montoNum > 0 && montoNum <= disp;

  const banner =
    disp == null
      ? { texto: "Ingrese un número de dos dígitos para ver el cupo disponible.", clase: "bg-chip text-cuerpo" }
      : disp <= 0
        ? { texto: `Cupo agotado en el ${pad2(numeroActual!)}: no se acepta monto.`, clase: "bg-negativo-fondo text-negativo-texto" }
        : disp < CUPO_BAJO
          ? { texto: `Cupo bajo en el ${pad2(numeroActual!)}: disponible ${fmt(disp)}.`, clase: "bg-ambar-fondo text-ambar-texto" }
          : { texto: `Disponible en el ${pad2(numeroActual!)}: ${fmt(disp)}.`, clase: "bg-positivo-fondo text-positivo-texto" };

  const limpiarEntrada = () => {
    setNumero("");
    setMonto("");
    setFoco("numero");
    setRapidaTexto("");
  };

  const agregar = (n: number, m: number) => {
    setCarrito((c) => [...c, { numero: n, monto: m }]);
    limpiarEntrada();
    setErrorVenta("");
  };

  const tecla = (k: string) => {
    const actual = foco === "numero" ? numero : monto;
    const set = foco === "numero" ? setNumero : setMonto;

    if (k === "C") return set("");
    if (k === "←") return set(actual.slice(0, -1));

    if (foco === "numero") {
      // Ventana deslizante de dos dígitos: teclear un tercero corre el número.
      const nuevo = (numero + k).slice(-2);
      setNumero(nuevo);
      setMonto("");
      // Sólo salta al monto si ese número tiene cupo; si no, se queda para
      // que el vendedor corrija sin descubrir el rechazo al final.
      const libre = nuevo.length === 2 && disponible[parseInt(nuevo, 10)] > 0;
      setFoco(libre ? "monto" : "numero");
      return;
    }

    if (monto.length < 5 && (disp ?? 0) > 0) setMonto(monto + k);
  };

  const enviarRapida = () => {
    const m = rapidaTexto.trim().match(/^(\d{1,2})\s*[\s\-x,]\s*(\d{1,5})$/);
    if (!m) {
      setRapidaOk(false);
      return setRapidaAviso("Formato: número espacio monto. Ejemplo: 47 50");
    }
    const n = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const dp = disponible[n];

    if (dp <= 0) {
      setRapidaOk(false);
      return setRapidaAviso(`Cupo agotado en el ${pad2(n)}.`);
    }
    if (mo > dp) {
      setRapidaOk(false);
      return setRapidaAviso(`Máximo vendible en el ${pad2(n)}: ${fmt(dp)}.`);
    }
    agregar(n, mo);
    setRapidaOk(true);
    setRapidaAviso(`${pad2(n)} × ${fmt(mo)} agregado. Siga escribiendo.`);
  };

  const confirmar = () => {
    if (!carrito.length || !vendedor) return;
    setErrorVenta("");

    const enviar = (coord?: { lat: number; lng: number }) =>
      iniciar(async () => {
        const r = await registrarTicket(datos.sorteo.id, vendedor.id, carrito, coord);
        if (!r.ok) return setErrorVenta(r.mensaje);
        setTicket({ folio: r.folio, lineas: carrito, total: r.total });
        setCarrito([]);
        limpiarEntrada();
      });

    // La coordenada es dato operativo, no un requisito: si el vendedor no da
    // permiso, la venta se registra igual.
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => enviar({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => enviar(),
        { timeout: 4000 },
      );
    } else {
      enviar();
    }
  };

  if (!vendedor) {
    return <p className="text-tabla text-secundario">No hay vendedores activos.</p>;
  }

  return (
    <div className="flex flex-wrap gap-[26px] items-start">
      {/* ---- Columna del teléfono ---- */}
      <div className="flex-none w-[404px] max-w-full flex flex-col gap-[14px]">
        <div className="flex gap-1 bg-riel rounded-banner p-1">
          {MODOS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModo(m.id)}
              className={cn(
                "flex-1 border-0 rounded-chip px-2 py-[9px] text-meta font-medium cursor-pointer",
                modo === m.id ? "bg-superficie text-tinta shadow-tab" : "bg-transparent text-secundario",
              )}
            >
              {m.etiqueta}
            </button>
          ))}
        </div>

        <div className="bg-tinta rounded-marco p-[11px] shadow-telefono">
          <div className="bg-panel rounded-pantalla h-[780px] overflow-hidden flex flex-col">
            {/* Barra de estado */}
            <div className="flex items-center justify-between px-5 pt-4 pb-2 text-meta">
              <span className="font-medium">
                {horaHonduras(new Date(ahora))}
              </span>
              <span className="flex items-center gap-[6px]">
                <span className="text-positivo-vivo font-medium">en línea</span>
                <span className="w-[22px] h-[10px] border-[1.5px] border-secundario rounded-[4px] inline-block" />
              </span>
            </div>

            {/* Cabecera del sorteo */}
            <div className="bg-superficie border-b border-riel px-5 py-3">
              <div className="flex items-start justify-between">
                <span className="block">
                  <span className="block text-th font-semibold tracking-th text-secundario">
                    SORTEO DESTINO
                  </span>
                  <span className="block text-pos-lg font-semibold tracking-sutil">
                    {datos.sorteo.hora} · hoy
                  </span>
                </span>
                <span className="block text-right">
                  <span className="block text-th text-secundario">cierra en</span>
                  <span className="block text-pos-lg font-semibold text-negativo">
                    {countdownHasta(ahora, datos.sorteo.hora_cierre)}
                  </span>
                </span>
              </div>
              <div className="text-label text-secundario mt-[6px]">
                {vendedor.nombre} · {vendedor.codigo} · factor {vendedor.factor_pago.toFixed(2)} ·
                comisión {(vendedor.comision * 100).toFixed(2)}%
              </div>
            </div>

            {ticket ? (
              /* ---- Venta registrada ---- */
              <div className="flex-1 flex flex-col px-5 py-6 overflow-y-auto">
                <div className="flex flex-col items-center">
                  <span className="w-16 h-16 rounded-full bg-positivo-fondo text-positivo-vivo text-rapida font-semibold flex items-center justify-center">
                    ✓
                  </span>
                  <span className="text-exito font-semibold mt-3">Venta registrada</span>
                </div>

                <div className="border border-dashed border-borde-punteado rounded-pos p-4 mt-5">
                  <div className="text-center text-th font-semibold tracking-th text-secundario">
                    LOTERÍA EL DIARIO
                  </div>
                  <div className="text-center text-meta text-secundario mt-1">{ticket.folio}</div>
                  <div className="mt-3 flex flex-col gap-[6px]">
                    {ticket.lineas.map((l, i) => (
                      <div key={i} className="flex justify-between text-tabla">
                        <span className="font-semibold">{pad2(l.numero)}</span>
                        <span>{fmt(l.monto, false)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between border-t border-borde-punteado mt-3 pt-2 text-tabla font-semibold">
                    <span>TOTAL</span>
                    <span>{fmt(ticket.total, false)}</span>
                  </div>
                </div>

                <div className="flex gap-[10px] mt-auto pt-5">
                  <button
                    onClick={() => setTicket(null)}
                    className="flex-1 border-0 bg-acento text-white rounded-pos py-4 text-pos font-semibold cursor-pointer"
                  >
                    Nueva venta
                  </button>
                  <button
                    onClick={() => window.print()}
                    className="border border-borde-campo bg-superficie text-cuerpo rounded-pos px-5 py-4 text-pos cursor-pointer"
                  >
                    Imprimir
                  </button>
                </div>
              </div>
            ) : (
              /* ---- Captura ---- */
              <div className="flex-1 flex flex-col min-h-0">
                {modo === "teclado" && (
                  <div className="pt-4">
                    <div className="flex gap-[10px] px-5 mb-3">
                      <button
                        onClick={() => setFoco("numero")}
                        className={cn(
                          "flex-1 text-left bg-superficie rounded-pos px-[14px] py-[11px] border-2 cursor-pointer",
                          foco === "numero" ? "border-acento" : "border-borde-pos",
                        )}
                      >
                        <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                          NÚMERO
                        </span>
                        <span className="block text-display font-semibold">
                          {numero.padEnd(2, "–")}
                        </span>
                      </button>
                      <button
                        onClick={() => (disp ?? 0) > 0 && setFoco("monto")}
                        className={cn(
                          "flex-[1.2] text-left bg-superficie rounded-pos px-[14px] py-[11px] border-2 cursor-pointer",
                          foco === "monto" ? "border-acento" : "border-borde-pos",
                          (disp ?? 0) <= 0 && "opacity-50",
                        )}
                      >
                        <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario">
                          MONTO (L)
                        </span>
                        <span className="block text-display font-semibold">{monto || "0"}</span>
                      </button>
                    </div>

                    <div className={cn("mx-5 mb-3 rounded-banner px-[13px] py-[11px] text-tabla font-medium leading-[1.4]", banner.clase)}>
                      {banner.texto}
                    </div>

                    <div className="grid grid-cols-3 gap-[9px] px-5">
                      {TECLAS.map((k) => (
                        <button
                          key={k}
                          onClick={() => tecla(k)}
                          className={cn(
                            "border border-borde-campo rounded-pos py-[15px] text-tecla font-semibold bg-superficie cursor-pointer active:bg-acento-suave",
                            (k === "C" || k === "←") && "text-negativo",
                          )}
                        >
                          {k}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-4 gap-2 px-5 mt-3">
                      {MONTOS_RAPIDOS.map((m) => (
                        <button
                          key={m}
                          onClick={() => (disp ?? 0) > 0 && setMonto(String(m))}
                          className={cn(
                            "rounded-pos py-[10px] text-tabla font-semibold border cursor-pointer",
                            String(m) === monto
                              ? "bg-acento text-white border-acento"
                              : "bg-superficie text-tinta border-borde-pos",
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    <button
                      disabled={!puedeAgregar}
                      onClick={() => agregar(numeroActual!, montoNum)}
                      className={cn(
                        "mx-5 mt-3 rounded-pos py-4 text-pos font-semibold border-0",
                        puedeAgregar ? "bg-tinta text-white cursor-pointer" : "bg-riel text-mudo cursor-not-allowed",
                      )}
                    >
                      Agregar al ticket
                    </button>
                  </div>
                )}

                {modo === "rapida" && (
                  <div className="pt-4 px-5">
                    <p className="text-micro text-secundario mb-3 mt-0">
                      Escriba <strong className="font-semibold">número espacio monto</strong> y
                      presione Enter.
                    </p>
                    <input
                      value={rapidaTexto}
                      onChange={(e) => {
                        setRapidaTexto(e.target.value.replace(/[^\d\s\-x,]/g, "").slice(0, 10));
                        setRapidaOk(null);
                        setRapidaAviso("");
                      }}
                      onKeyDown={(e) => e.key === "Enter" && enviarRapida()}
                      placeholder="47 50"
                      className={cn(
                        "w-full px-[18px] py-4 rounded-card border-2 text-rapida font-semibold tracking-rapida outline-none bg-superficie",
                        rapidaOk === false
                          ? "border-negativo"
                          : rapidaOk === true
                            ? "border-positivo-vivo"
                            : "border-borde-pos",
                      )}
                    />
                    <div
                      className={cn(
                        "rounded-banner px-[13px] py-[11px] text-tabla font-medium mt-3",
                        rapidaOk === false
                          ? "bg-negativo-fondo text-negativo-texto"
                          : rapidaOk === true
                            ? "bg-positivo-fondo text-positivo-texto"
                            : "bg-chip text-cuerpo",
                      )}
                    >
                      {rapidaAviso ||
                        "Acepta «47 50», «47-50» o «47x50». El cupo se valida al presionar Enter."}
                    </div>
                    <button
                      onClick={enviarRapida}
                      className="w-full mt-3 rounded-pos py-4 text-pos font-semibold border-0 bg-tinta text-white cursor-pointer"
                    >
                      Agregar línea (Enter)
                    </button>
                    <div className="flex flex-wrap gap-2 mt-4">
                      {ATAJOS.map(([n, m]) => (
                        <button
                          key={`${n}-${m}`}
                          onClick={() => setRapidaTexto(`${n} ${m}`)}
                          className="rounded-atajo px-[15px] py-[10px] text-card font-medium border border-borde-campo bg-superficie cursor-pointer"
                        >
                          {n} × {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {modo === "rejilla" && (
                  <div className="pt-4 px-5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-micro text-secundario">
                        Toque el número, luego el monto
                      </span>
                      <span className="text-ganador font-semibold">
                        {numero.padEnd(2, "–")}
                      </span>
                    </div>
                    <div className="grid grid-cols-10 gap-[3px]">
                      {Array.from({ length: 100 }, (_, n) => {
                        const dp = disponible[n];
                        const sel = numeroActual === n;
                        return (
                          <button
                            key={n}
                            onClick={() => {
                              setNumero(pad2(n));
                              setMonto("");
                              setFoco("monto");
                            }}
                            className={cn(
                              "aspect-square rounded-celda text-th font-medium border-[1.5px] p-0 cursor-pointer",
                              sel
                                ? "bg-tinta text-white border-tinta"
                                : dp <= 0
                                  ? "bg-negativo-fondo text-negativo-texto border-negativo-borde"
                                  : dp < CUPO_BAJO
                                    ? "bg-ambar-fondo text-tinta border-borde-pos"
                                    : "bg-superficie text-tinta border-borde-pos",
                            )}
                          >
                            {pad2(n)}
                          </button>
                        );
                      })}
                    </div>

                    <div className={cn("rounded-banner px-3 py-[10px] text-meta font-medium mt-3", banner.clase)}>
                      {banner.texto}
                    </div>

                    <div className="grid grid-cols-4 gap-2 mt-3">
                      {MONTOS_RAPIDOS.map((m) => (
                        <button
                          key={m}
                          onClick={() => (disp ?? 0) > 0 && setMonto(String(m))}
                          className={cn(
                            "rounded-pos py-[14px] text-pos-lg font-semibold border cursor-pointer",
                            String(m) === monto
                              ? "bg-acento text-white border-acento"
                              : "bg-superficie text-tinta border-borde-pos",
                          )}
                        >
                          {m}
                        </button>
                      ))}
                    </div>

                    <button
                      disabled={!puedeAgregar}
                      onClick={() => agregar(numeroActual!, montoNum)}
                      className={cn(
                        "w-full mt-3 rounded-pos py-4 text-pos font-semibold border-0",
                        puedeAgregar ? "bg-tinta text-white cursor-pointer" : "bg-riel text-mudo cursor-not-allowed",
                      )}
                    >
                      Agregar al ticket
                    </button>
                  </div>
                )}

                {/* Ticket en curso */}
                <div className="flex-1 overflow-y-auto px-5 mt-4 min-h-0">
                  <div className="text-eyebrow font-semibold tracking-ticket text-secundario mb-2">
                    TICKET EN CURSO · {carrito.length} {carrito.length === 1 ? "LÍNEA" : "LÍNEAS"}
                  </div>
                  {carrito.length === 0 ? (
                    <div className="border border-dashed border-borde-punteado rounded-pos p-[18px] text-center text-meta text-mudo">
                      Sin líneas todavía
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {carrito.map((l, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-[11px] bg-superficie border border-riel rounded-pos px-3 py-[10px]"
                        >
                          <span className="w-9 text-pos-xl font-semibold">{pad2(l.numero)}</span>
                          <span className="flex-1 text-micro text-secundario">
                            premio si acierta {fmt(l.monto * vendedor.factor_pago)}
                          </span>
                          <span className="text-h2 font-semibold">{fmt(l.monto, false)}</span>
                          <button
                            onClick={() => setCarrito((c) => c.filter((_, j) => j !== i))}
                            className="border-0 bg-transparent text-negativo text-exito leading-none px-1 cursor-pointer"
                            aria-label={`Quitar línea ${pad2(l.numero)}`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Pie */}
                <div className="border-t border-riel bg-superficie px-5 pt-[13px] pb-4">
                  {errorVenta && (
                    <p className="text-meta text-negativo mt-0 mb-2">{errorVenta}</p>
                  )}
                  <div className="flex items-baseline justify-between mb-3">
                    <span className="text-tabla text-secundario">Total del ticket</span>
                    <span className="text-h1 font-semibold tracking-titular">
                      {fmt(totalTicket)}
                    </span>
                  </div>
                  <button
                    disabled={carrito.length === 0 || enviando}
                    onClick={confirmar}
                    className={cn(
                      "w-full rounded-pos py-[17px] text-pos-lg font-semibold border-0",
                      carrito.length > 0 && !enviando
                        ? "bg-acento text-white cursor-pointer"
                        : "bg-riel text-mudo cursor-not-allowed",
                    )}
                  >
                    {enviando ? "Registrando…" : "Confirmar venta"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- Columna explicativa ---- */}
      <div className="flex-1 min-w-[380px] flex flex-col gap-4">
        <div>
          <h1 className="text-h1 font-semibold tracking-titular m-0">Punto de venta</h1>
          <p className="text-base text-cuerpo leading-[1.6] max-w-[56ch] mt-[6px] mb-0">
            Captura de tickets con validación de cupo en vivo. Registrar número y monto debe
            costar el mínimo de toques posible: la velocidad de captura manda sobre la elegancia
            del formulario.
          </p>
        </div>

        {!datos.propio && (
        <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">Vendedor</h2>
          <p className="text-meta text-secundario mt-[5px] mb-3">
            En el dispositivo del vendedor esto viene de su sesión. Aquí se elige para poder
            probar cualquier ruta.
          </p>
          <select
            value={vendedorId}
            onChange={(e) => {
              setVendedorId(e.target.value);
              setCarrito([]);
              limpiarEntrada();
              setTicket(null);
            }}
            className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie"
          >
            {datos.vendedores.map((v) => (
              <option key={v.id} value={v.id}>
                {v.nombre} · {v.codigo}
              </option>
            ))}
          </select>
        </div>
        )}

        <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">
            Retroalimentación de cupo en vivo
          </h2>
          <div className="flex flex-col gap-3 mt-3">
            {[
              { color: "var(--color-positivo-vivo)", texto: "Cupo holgado: el monto se acepta sin más." },
              { color: "var(--color-ambar)", texto: `Menos de ${fmt(CUPO_BAJO)} disponibles: se avisa antes de teclear el monto.` },
              { color: "var(--color-negativo)", texto: "Cupo agotado: el campo de monto se bloquea, para que el rechazo no aparezca al final del ticket." },
            ].map((r) => (
              <div key={r.texto} className="flex gap-[10px]">
                <span
                  className="w-2 h-2 rounded-full flex-none mt-[6px]"
                  style={{ background: r.color }}
                />
                <span className="text-tabla text-cuerpo leading-[1.5]">{r.texto}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-panel border border-borde rounded-card px-[17px] py-[15px] text-meta text-cuerpo leading-[1.55]">
          Lo que se ve mientras se teclea es orientativo. La validación que manda ocurre al
          confirmar, dentro de la misma transacción que inserta el ticket y con la fila de cupo
          bloqueada: dos vendedores que compran el mismo número en el mismo segundo no pueden
          exceder el tope entre ambos.
        </div>
      </div>
    </div>
  );
}
