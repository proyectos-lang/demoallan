import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Tarjeta: la superficie base de toda la aplicación.
 * `#fff` + borde `#e6ecf4` + radio 14 + sombra de 1px. Nada más.
 */
export function Tarjeta({
  children,
  className,
  padding = "20px 22px",
}: {
  children: ReactNode;
  className?: string;
  /** El prototipo usa varios paddings según la densidad de la tarjeta. */
  padding?: string;
}) {
  return (
    <div
      className={cn(
        "bg-superficie border border-borde rounded-card shadow-card",
        className,
      )}
      style={{ padding }}
    >
      {children}
    </div>
  );
}

/**
 * Tarjeta de nota: el bloque gris explicativo que aparece al pie de varias
 * pantallas. Mismo borde, fondo `#f8fafc` y texto más pequeño.
 */
export function TarjetaNota({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-panel border border-borde rounded-card text-meta text-cuerpo leading-[1.55] px-[17px] py-[15px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Encabezado de sección dentro de una tarjeta: título, subtítulo opcional y un
 * bloque de meta alineado a la derecha que envuelve en pantallas estrechas.
 */
export function EncabezadoSeccion({
  titulo,
  subtitulo,
  meta,
  tamano = "grande",
}: {
  titulo: string;
  subtitulo?: string;
  meta?: ReactNode;
  /** `grande` = 15px (tarjetas anchas) · `chico` = 14px (columnas laterales). */
  tamano?: "grande" | "chico";
}) {
  return (
    <div className="flex justify-between items-start flex-wrap gap-3">
      <div>
        <h2
          className={cn(
            "font-semibold m-0",
            tamano === "grande"
              ? "text-h2 tracking-sutil"
              : "text-card",
          )}
        >
          {titulo}
        </h2>
        {subtitulo && (
          <p className="text-meta text-secundario mt-[5px] mb-0">{subtitulo}</p>
        )}
      </div>
      {meta && <div className="text-meta text-secundario">{meta}</div>}
    </div>
  );
}
