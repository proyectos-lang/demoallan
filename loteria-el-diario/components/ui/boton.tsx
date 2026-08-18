import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

type Variante = "primario" | "oscuro" | "ghost" | "destructivo";
type Tamano = "sm" | "md" | "lg" | "xl";

const VARIANTES: Record<Variante, string> = {
  // Azul de acento. Es el CTA por defecto.
  primario: "border-0 bg-acento text-white font-semibold",
  // Tinta. El prototipo lo reserva para acciones que consuman el paso actual:
  // "Agregar al ticket", "Agregar línea", "Confirmar y liquidar".
  oscuro: "border-0 bg-tinta text-white font-semibold",
  ghost:
    "border border-borde-campo bg-superficie text-cuerpo hover:bg-panel",
  destructivo:
    "border-0 bg-transparent text-negativo leading-none px-1 py-0",
};

const TAMANOS: Record<Tamano, string> = {
  sm: "px-[13px] py-[7px] text-meta",
  md: "px-5 py-3 text-base",
  lg: "px-[26px] py-[14px] text-cta",
  xl: "px-4 py-4 text-pos",
};

const RADIOS: Record<Tamano, string> = {
  sm: "rounded-campo",
  md: "rounded-boton",
  lg: "rounded-banner",
  xl: "rounded-pos",
};

export function Boton({
  children,
  variante = "primario",
  tamano = "md",
  className,
  disabled,
  ...props
}: {
  children: ReactNode;
  variante?: Variante;
  tamano?: Tamano;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  // El patrón de deshabilitado es universal en el prototipo y no cambia con la
  // variante: misma geometría, fondo #eef2f7 y texto #94a3b8. No usar opacity.
  const apagado = disabled && variante !== "ghost" && variante !== "destructivo";

  return (
    <button
      disabled={disabled}
      className={cn(
        "cursor-pointer",
        RADIOS[tamano],
        TAMANOS[tamano],
        apagado
          ? "border-0 bg-riel text-mudo font-semibold cursor-not-allowed"
          : VARIANTES[variante],
        disabled && !apagado && "cursor-not-allowed",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Botón cuadrado de icono. Dos calibres en el prototipo: 34×34 para los
 * steppers de fecha (‹ ›) y 36×38 para los ± del simulador.
 */
export function BotonIcono({
  children,
  acento = false,
  className,
  ...props
}: {
  children: ReactNode;
  /** `true` pinta el glifo de azul y lo agranda, como los ± del simulador. */
  acento?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "flex items-center justify-center border border-borde-campo bg-superficie rounded-campo cursor-pointer hover:bg-panel",
        acento
          ? "w-9 h-[38px] text-acento text-pos-lg font-semibold"
          : "w-[34px] h-[34px] text-cuerpo text-h2",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
