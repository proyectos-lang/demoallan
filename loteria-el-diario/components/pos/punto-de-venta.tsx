"use client";

import { VistaEscritorio } from "@/components/pos/vista-escritorio";
import { VistaMovil } from "@/components/pos/vista-movil";
import { usePos, type DatosPos } from "@/lib/pos/use-pos";

export type { DatosPos, SorteoPos, VendedorPos } from "@/lib/pos/use-pos";

/**
 * Punto de venta.
 *
 * Un solo estado —`usePos`— y dos disposiciones. Las dos se renderizan
 * siempre y se ocultan con `lg:hidden` / `hidden lg:flex`, en vez de medir el
 * viewport con `matchMedia`: el servidor no sabe el ancho de la pantalla, así
 * que decidir en JavaScript significaría pintar una vista y cambiarla al
 * hidratar. Se paga un poco de DOM de más y se evita el parpadeo.
 *
 * `lg` (64rem) es el primer breakpoint del proyecto. Hasta ahora no había
 * ninguno, y por eso el punto de venta se veía igual —maqueta de teléfono
 * incluida— en un monitor y en un teléfono.
 */
export function PuntoDeVenta({ datos }: { datos: DatosPos }) {
  const pos = usePos(datos);

  if (!pos.vendedor) {
    return <p className="text-tabla text-secundario">No hay vendedores activos.</p>;
  }

  return (
    <>
      <VistaEscritorio pos={pos} />
      <VistaMovil pos={pos} />
    </>
  );
}
