"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { MatrizTotales } from "@/components/pos/matriz-totales";
import type { FilaMatriz } from "@/app/(admin)/punto-de-venta/acciones";
import type { SorteoPos } from "@/lib/pos/use-pos";

/**
 * El envoltorio de la matriz: sólo sabe llevar la fecha y el sorteo a la
 * dirección.
 *
 * Existe porque la matriz necesita estado de cliente —cien casillas que se
 * teclean— pero las filas las trae el servidor, y cambiar de sorteo tiene que
 * volver a pedirlas: si sólo cambiara un estado de React, la tabla seguiría
 * enseñando lo capturado del sorteo anterior y se guardaría en el que no era.
 */
export function PanelTotales({
  sorteo,
  sorteos,
  fecha,
  filas,
}: {
  sorteo: SorteoPos;
  sorteos: SorteoPos[];
  fecha: string;
  filas: FilaMatriz[];
}) {
  const router = useRouter();
  const [, iniciar] = useTransition();

  const irA = (nuevaFecha: string, nuevoSorteo: string) => {
    const p = new URLSearchParams({ modo: "totales", fecha: nuevaFecha });
    if (nuevoSorteo) p.set("sorteo", nuevoSorteo);
    iniciar(() => router.push(`/punto-de-venta?${p.toString()}`));
  };

  return (
    <MatrizTotales
      sorteo={sorteo}
      sorteos={sorteos}
      fecha={fecha}
      filas={filas}
      onCambiarSorteo={irA}
    />
  );
}
