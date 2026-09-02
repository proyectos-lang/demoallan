"use client";

import { Printer } from "lucide-react";
import { useRef } from "react";

import { Boton } from "@/components/ui/boton";
import { documentoLiquidacion, type HojaImpresa } from "@/components/liquidacion/imprimible";

/**
 * Imprime la hoja de liquidación en un documento aparte.
 *
 * POR QUÉ UN MARCO Y NO `window.print()` A SECAS. La aplicación ya tiene un
 * bloque `@media print` para el ticket térmico, y ahí `@page` fija el papel en
 * 58 mm. `@page` es del documento entero —no se puede acotar a un elemento—,
 * así que dos formatos de papel obligan a dos documentos. El marco lleva su
 * propio A4 y no se cruza con el rollo.
 *
 * EL MARCO NO SE DESMONTA. Se crea una vez y se reutiliza. `print()` no
 * bloquea en todos los navegadores, y quitar el marco justo después es
 * exactamente el fallo que dejaba el ticket en blanco en los Android: la hoja
 * desaparecía antes de que el motor terminara de dibujarla. Vale más un
 * elemento de 0 × 0 colgado del documento que volver a esa caza.
 */
export function BotonImprimir({
  hoja,
  disabled,
}: {
  hoja: HojaImpresa;
  disabled?: boolean;
}) {
  const marco = useRef<HTMLIFrameElement | null>(null);

  const imprimir = () => {
    if (!marco.current) {
      const i = document.createElement("iframe");
      /*
       * `data-impresion` para que la regla de impresión de la aplicación
       * —`body > *:not([data-impresion])` — no lo apague. Y fuera de la vista
       * con posición y tamaño, no con `display:none`: un marco sin caja no
       * siempre se puede imprimir.
       */
      i.setAttribute("data-impresion", "");
      i.setAttribute("aria-hidden", "true");
      i.title = "Hoja de liquidación para imprimir";
      i.style.cssText =
        "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
      document.body.appendChild(i);
      marco.current = i;
    }

    const i = marco.current;
    i.onload = () => {
      const v = i.contentWindow;
      if (!v) return;
      v.focus();
      v.print();
    };
    i.srcdoc = documentoLiquidacion(hoja);
  };

  return (
    <Boton variante="ghost" onClick={imprimir} disabled={disabled}>
      <Printer size={15} strokeWidth={2} absoluteStrokeWidth />
      Imprimir hoja
    </Boton>
  );
}
