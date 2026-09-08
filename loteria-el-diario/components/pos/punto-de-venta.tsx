"use client";

import { TicketImpreso } from "@/components/pos/ticket-impreso";
import { VistaEscritorio } from "@/components/pos/vista-escritorio";
import { VistaVendedorEscritorio } from "@/components/pos/vista-vendedor-escritorio";
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
export function PuntoDeVenta({
  datos,
  perfil = "administracion",
}: {
  datos: DatosPos;
  /*
   * Quién está vendiendo, y por tanto qué vista de escritorio se pinta.
   *
   * «administracion» conserva la de siempre: tres modos de captura y el
   * selector de vendedor, que es lo que hace falta para registrar a nombre de
   * otro y para corregir a mano.
   *
   * «vendedor» pinta la rejilla de 5 en 5 con decenas y marcar varios — EL
   * MISMO flujo que ya usa en el teléfono. Un vendedor que se sienta en una
   * laptop no debería tener que aprender otra forma de trabajar; el estado y
   * las acciones son los mismos en las dos, así que no pueden comportarse
   * distinto por accidente.
   *
   * En móvil no cambia nada: las dos comparten `VistaMovil`.
   */
  perfil?: "administracion" | "vendedor";
}) {
  const pos = usePos(datos);

  if (!pos.vendedor) {
    return <p className="text-tabla text-secundario">No hay vendedores activos.</p>;
  }

  return (
    <>
      {perfil === "vendedor" ? (
        <VistaVendedorEscritorio pos={pos} />
      ) : (
        <VistaEscritorio pos={pos} />
      )}
      <VistaMovil pos={pos} />

      {/*
        La hoja que sale por la impresora, UNA sola vez.

        Va aquí y no dentro del recibo porque el recibo se pinta dos veces —una
        por vista— y colgaba dos hojas de `document.body`: el papel salía con
        todo repetido. Aquí arriba sólo hay un sitio donde ponerla.
      */}
      {pos.recibo && pos.vendedor && (
        <TicketImpreso
          modo="impresion"
          tickets={pos.recibo.tickets}
          sorteo={pos.datos.sorteo}
          vendedor={pos.vendedor}
          soloFolio={pos.soloFolio}
        />
      )}
    </>
  );
}
