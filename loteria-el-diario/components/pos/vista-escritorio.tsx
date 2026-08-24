"use client";

import { useRouter } from "next/navigation";

import {
  AvisoFueraDeHora,
  BannerCupo,
  ListaTanda,
  PildoraEstado,
  Recibo,
  SelectorSorteo,
  TicketEnCurso,
} from "@/components/pos/piezas";
import { cn } from "@/lib/cn";
import { countdownHasta, fmt, hora12, pad2 } from "@/lib/format";
import { ATAJOS, CUPO_BAJO, MONTOS_RAPIDOS, type Pos } from "@/lib/pos/use-pos";

const MODOS: { id: "teclado" | "rapida" | "rejilla"; etiqueta: string }[] = [
  { id: "teclado", etiqueta: "Número y monto" },
  { id: "rapida", etiqueta: "Línea rápida" },
  { id: "rejilla", etiqueta: "Rejilla 00–99" },
];

/**
 * Punto de venta en escritorio.
 *
 * Antes esta pantalla era una ILUSTRACIÓN DE TELÉFONO: un marco de 404 px con
 * una pantalla simulada de 780 px, y al lado una columna de texto explicando el
 * flujo. Servía para enseñar la maqueta, no para vender: en un monitor de 1440
 * px se usaba menos de un tercio del ancho y el operador tecleaba en una
 * ventana del tamaño de un móvil.
 *
 * Aquí manda el teclado físico. Los campos son `<input>` de verdad, Enter
 * avanza de número a monto y de monto a «agregar», y la rejilla 00–99 —que en
 * un teléfono compite por espacio— se gana su sitio como mapa de cupo, que es
 * la información que un operador de mesa quiere tener a la vista.
 */
export function VistaEscritorio({ pos }: { pos: Pos }) {
  const router = useRouter();
  const { datos, vendedor } = pos;
  if (!vendedor) return null;

  const irASorteo = (id: string) => {
    // El cupo disponible es del sorteo, así que cambiar de sorteo cambia los
    // datos del servidor. Se navega en vez de recargar en el cliente: de paso
    // limpia el carrito, que es lo correcto — sus líneas se validaron contra
    // otro cupo.
    router.push(`/punto-de-venta?sorteo=${id}`);
  };

  return (
    <div className="hidden lg:flex flex-col gap-4">
      {/* --- Barra del sorteo --- */}
      <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-4 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <span className="block text-th font-semibold tracking-th text-secundario mb-[6px]">
            SORTEO DESTINO
          </span>
          {datos.sorteos.length > 1 ? (
            <SelectorSorteo
              sorteos={datos.sorteos}
              actual={datos.sorteo}
              onElegir={irASorteo}
              className="min-w-[220px]"
            />
          ) : (
            <span className="flex items-center gap-[10px]">
              <span className="text-h2 font-semibold tracking-sutil">
                {hora12(datos.sorteo.hora)}
              </span>
              <PildoraEstado estado={datos.sorteo.estado} />
            </span>
          )}
        </div>

        {!datos.propio && (
          <div>
            <span className="block text-th font-semibold tracking-th text-secundario mb-[6px]">
              VENDEDOR
            </span>
            <select
              value={pos.vendedorId}
              onChange={(e) => pos.cambiarVendedor(e.target.value)}
              className="min-w-[240px] px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none bg-superficie"
            >
              {datos.vendedores.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.nombre} · {v.codigo}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <span className="block text-th font-semibold tracking-th text-secundario mb-[6px]">
            {pos.cerrada ? "VENTA" : "CIERRA EN"}
          </span>
          <span
            className={cn(
              "block text-h2 font-semibold",
              pos.cerrada ? "text-cuerpo" : "text-negativo",
            )}
          >
            {!pos.montado
              ? "—"
              : pos.cerrada
                ? "cerrada"
                : countdownHasta(pos.ahora, datos.sorteo.hora_cierre)}
          </span>
        </div>

        <div className="ml-auto text-meta text-secundario leading-[1.5] text-right">
          factor {vendedor.factor_pago.toFixed(2)} · comisión{" "}
          {(vendedor.comision * 100).toFixed(2)}%
          <br />
          tope por número {fmt(vendedor.tope_por_numero)}
        </div>
      </div>

      <AvisoFueraDeHora pos={pos} />

      {pos.recibo ? (
        <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-8 max-w-[520px] mx-auto w-full">
          <Recibo pos={pos} />
        </div>
      ) : (
        <div className="flex gap-4 items-start">
          {/* ---- Captura ---- */}
          <div className="flex-1 min-w-0 bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex flex-col gap-4">
            <div className="flex gap-1 bg-riel rounded-banner p-1 self-start">
              {MODOS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => pos.setModo(m.id)}
                  className={cn(
                    "border-0 rounded-chip px-4 py-[9px] text-meta font-medium cursor-pointer",
                    pos.modo === m.id
                      ? "bg-superficie text-tinta shadow-tab"
                      : "bg-transparent text-secundario",
                  )}
                >
                  {m.etiqueta}
                </button>
              ))}
            </div>

            {pos.modo === "teclado" && <CamposNumeroMonto pos={pos} />}
            {pos.modo === "rapida" && <LineaRapida pos={pos} />}
            {pos.modo === "rejilla" && <Rejilla pos={pos} />}

            <BannerCupo pos={pos} />

            <button
              disabled={!pos.puedeAgregar}
              onClick={() => pos.agregar(pos.numeroActual!, pos.montoNum)}
              className={cn(
                "rounded-pos py-[14px] text-pos font-semibold border-0",
                pos.puedeAgregar
                  ? "bg-tinta text-white cursor-pointer"
                  : "bg-riel text-mudo cursor-not-allowed",
              )}
            >
              Agregar al ticket
            </button>
          </div>

          {/* ---- Ticket y tanda ---- */}
          <div className="flex-none w-[420px] bg-superficie border border-borde rounded-card shadow-card flex flex-col">
            <div className="px-[22px] py-5 flex-1">
              <TicketEnCurso pos={pos} />
              <ListaTanda pos={pos} />

              {pos.carrito.length > 0 && (
                <button
                  onClick={pos.cerrarTicket}
                  className="w-full mt-3 rounded-pos py-[11px] text-tabla font-semibold border border-borde-campo bg-superficie text-tinta cursor-pointer hover:bg-panel"
                >
                  Cerrar este ticket y empezar otro
                </button>
              )}
            </div>

            <div className="flex-none border-t border-riel px-[22px] pt-[13px] pb-5">
              {pos.errorVenta && (
                <p className="text-meta text-negativo mt-0 mb-2">{pos.errorVenta}</p>
              )}
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-tabla text-secundario">
                  {pos.ticketsPorRegistrar <= 1
                    ? "Total del ticket"
                    : `Total · ${pos.ticketsPorRegistrar} tickets`}
                </span>
                <span className="text-h1 font-semibold tracking-titular">
                  {fmt(pos.totalTanda)}
                </span>
              </div>
              <button
                disabled={pos.ticketsPorRegistrar === 0 || pos.enviando || pos.bloqueada}
                onClick={pos.confirmar}
                className={cn(
                  "w-full rounded-pos py-[15px] text-pos-lg font-semibold border-0",
                  pos.ticketsPorRegistrar > 0 && !pos.enviando && !pos.bloqueada
                    ? "bg-acento text-white cursor-pointer"
                    : "bg-riel text-mudo cursor-not-allowed",
                )}
              >
                {pos.enviando
                  ? "Registrando…"
                  : pos.bloqueada
                    ? "Venta cerrada"
                    : pos.ticketsPorRegistrar > 1
                      ? "Confirmar y registrar"
                      : "Confirmar venta"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-panel border border-borde rounded-card px-[17px] py-[15px] text-meta text-cuerpo leading-[1.55]">
        Lo que se ve mientras se teclea es orientativo. La validación que manda ocurre al
        confirmar, dentro de la misma transacción que inserta los tickets y con la fila de
        cupo bloqueada: dos vendedores que compran el mismo número en el mismo segundo no
        pueden exceder el tope entre ambos. Menos de {fmt(CUPO_BAJO)} disponibles se avisa en
        ámbar; agotado, el monto se bloquea.
      </div>
    </div>
  );
}

/**
 * Los dos campos, con `<input>` reales.
 *
 * Enter encadena: del número salta al monto, y del monto agrega la línea y
 * vuelve al número. Es la diferencia entre teclear una hoja de veinte apuestas
 * sin soltar el teclado y hacerlo a base de clics.
 */
function CamposNumeroMonto({ pos }: { pos: Pos }) {
  return (
    <div className="flex gap-4">
      <label className="block flex-1">
        <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario mb-[6px]">
          NÚMERO
        </span>
        <input
          value={pos.numero}
          onChange={(e) => pos.setNumero(e.target.value.replace(/\D/g, "").slice(0, 2))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if ((pos.disp ?? 0) > 0) pos.setFoco("monto");
          }}
          onFocus={() => pos.setFoco("numero")}
          inputMode="numeric"
          placeholder="00"
          autoFocus
          className={cn(
            "w-full px-4 py-3 rounded-pos border-2 text-display font-semibold outline-none bg-superficie",
            pos.foco === "numero" ? "border-acento" : "border-borde-pos",
          )}
        />
      </label>

      <label className="block flex-[1.2]">
        <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario mb-[6px]">
          MONTO (L)
        </span>
        <input
          value={pos.monto}
          onChange={(e) => pos.setMonto(e.target.value.replace(/\D/g, "").slice(0, 5))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (pos.puedeAgregar) pos.agregar(pos.numeroActual!, pos.montoNum);
          }}
          onFocus={() => pos.setFoco("monto")}
          inputMode="numeric"
          placeholder="0"
          disabled={(pos.disp ?? 0) <= 0}
          className={cn(
            "w-full px-4 py-3 rounded-pos border-2 text-display font-semibold outline-none bg-superficie",
            pos.foco === "monto" ? "border-acento" : "border-borde-pos",
            (pos.disp ?? 0) <= 0 && "opacity-50",
          )}
        />
      </label>

      <div className="flex-none">
        <span className="block text-eyebrow font-semibold tracking-eyebrow text-secundario mb-[6px]">
          MONTOS FRECUENTES
        </span>
        <div className="grid grid-cols-2 gap-2">
          {MONTOS_RAPIDOS.map((m) => (
            <button
              key={m}
              onClick={() => (pos.disp ?? 0) > 0 && pos.setMonto(String(m))}
              className={cn(
                "rounded-pos px-4 py-[10px] text-tabla font-semibold border cursor-pointer",
                String(m) === pos.monto
                  ? "bg-acento text-white border-acento"
                  : "bg-superficie text-tinta border-borde-pos",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function LineaRapida({ pos }: { pos: Pos }) {
  return (
    <div>
      <p className="text-micro text-secundario mb-3 mt-0">
        Escriba <strong className="font-semibold">número espacio monto</strong> y presione
        Enter. Acepta «47 50», «47-50» o «47x50».
      </p>
      <input
        value={pos.rapidaTexto}
        onChange={(e) => {
          pos.setRapidaTexto(e.target.value.replace(/[^\d\s\-x,]/g, "").slice(0, 10));
          pos.setRapidaOk(null);
          pos.setRapidaAviso("");
        }}
        onKeyDown={(e) => e.key === "Enter" && pos.enviarRapida()}
        placeholder="47 50"
        className={cn(
          "w-full px-[18px] py-4 rounded-card border-2 text-rapida font-semibold tracking-rapida outline-none bg-superficie",
          pos.rapidaOk === false
            ? "border-negativo"
            : pos.rapidaOk === true
              ? "border-positivo-vivo"
              : "border-borde-pos",
        )}
      />
      {pos.rapidaAviso && (
        <div
          className={cn(
            "rounded-banner px-[13px] py-[11px] text-tabla font-medium mt-3",
            pos.rapidaOk === false
              ? "bg-negativo-fondo text-negativo-texto"
              : "bg-positivo-fondo text-positivo-texto",
          )}
        >
          {pos.rapidaAviso}
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-4">
        {ATAJOS.map(([n, m]) => (
          <button
            key={`${n}-${m}`}
            onClick={() => pos.setRapidaTexto(`${n} ${m}`)}
            className="rounded-atajo px-[15px] py-[10px] text-card font-medium border border-borde-campo bg-superficie cursor-pointer"
          >
            {n} × {m}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * La rejilla completa, que en escritorio es sobre todo un MAPA DE CUPO: de un
 * vistazo se ve dónde queda sitio y dónde no, que es la pregunta que se hace
 * quien vigila la exposición de la casa.
 */
function Rejilla({ pos }: { pos: Pos }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-micro text-secundario">
          Toque el número y luego el monto. El color es el cupo que le queda.
        </span>
        <span className="text-ganador font-semibold">{pos.numero.padEnd(2, "–")}</span>
      </div>
      <div className="grid grid-cols-10 gap-[3px]">
        {Array.from({ length: 100 }, (_, n) => {
          const dp = pos.disponible[n];
          const sel = pos.numeroActual === n;
          return (
            <button
              key={n}
              onClick={() => {
                pos.setNumero(pad2(n));
                pos.setMonto("");
                pos.setFoco("monto");
              }}
              title={`${pad2(n)} · disponible ${fmt(dp)}`}
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

      <div className="grid grid-cols-4 gap-2 mt-3">
        {MONTOS_RAPIDOS.map((m) => (
          <button
            key={m}
            onClick={() => (pos.disp ?? 0) > 0 && pos.setMonto(String(m))}
            className={cn(
              "rounded-pos py-[14px] text-pos-lg font-semibold border cursor-pointer",
              String(m) === pos.monto
                ? "bg-acento text-white border-acento"
                : "bg-superficie text-tinta border-borde-pos",
            )}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
