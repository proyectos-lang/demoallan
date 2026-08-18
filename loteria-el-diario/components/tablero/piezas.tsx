import { cn } from "@/lib/cn";
import { fmtK } from "@/lib/format";

/**
 * Tarjeta de KPI.
 *
 * La fila del tablero se lee como una ecuación: venta − comisiones − premios =
 * utilidad. Los glifos `−` y `=` van posicionados en el canalón de 26 px que
 * separa las tarjetas, no dentro de ellas — de ahí el `left:-20px`.
 */
export function TarjetaKpi({
  etiqueta,
  valor,
  pie,
  punto,
  operador,
  oscura = false,
}: {
  etiqueta: string;
  valor: string;
  pie?: string;
  punto?: string;
  /** Glifo que se dibuja en el canalón anterior. */
  operador?: "−" | "=";
  oscura?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative rounded-card px-[22px] py-5 border",
        oscura ? "bg-navy border-navy shadow-card-oscura" : "bg-superficie border-borde shadow-card",
      )}
    >
      {operador && (
        <span
          className="absolute text-modal text-mudo select-none"
          style={{ left: -20, top: "50%", transform: "translate(-50%,-50%)" }}
          aria-hidden
        >
          {operador}
        </span>
      )}
      <span className="flex items-center gap-2">
        {punto && (
          <span
            className="w-2 h-2 rounded-punto flex-none"
            style={{ background: punto }}
          />
        )}
        <span className={cn("text-meta font-medium", oscura ? "text-navy-etiqueta" : "text-cuerpo")}>
          {etiqueta}
        </span>
      </span>
      <span
        className={cn(
          "block text-kpi font-semibold tracking-titular whitespace-nowrap mt-1",
          oscura && "text-white",
        )}
      >
        {valor}
      </span>
      {pie && (
        <span className={cn("block text-label mt-1", oscura ? "text-navy-pie" : "text-secundario")}>
          {pie}
        </span>
      )}
    </div>
  );
}

/** Barra horizontal proporcional. Pista gris, relleno del color de la serie. */
export function BarraVendedor({
  nombre,
  valor,
  maximo,
  color,
  detalle,
  negativo = false,
}: {
  nombre: string;
  valor: number;
  maximo: number;
  color: string;
  detalle?: string;
  negativo?: boolean;
}) {
  const ancho = maximo > 0 ? Math.round((Math.abs(valor) / maximo) * 100) : 0;

  return (
    <div>
      <div className="flex justify-between items-baseline mb-[6px]">
        <span className="text-tabla font-medium">{nombre}</span>
        <span
          className={cn("text-tabla font-semibold", negativo && "text-negativo")}
          style={negativo ? undefined : { color }}
        >
          {fmtK(valor)}
        </span>
      </div>
      <span className="block h-[9px] rounded-barra bg-chip overflow-hidden">
        <span
          className="block h-[9px] rounded-barra"
          style={{ width: `${ancho}%`, background: negativo ? "var(--color-negativo)" : color }}
        />
      </span>
      {detalle && <span className="block text-label text-mudo mt-1">{detalle}</span>}
    </div>
  );
}
