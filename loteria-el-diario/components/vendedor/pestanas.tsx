"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

const PESTANAS = [
  { href: "/mi-venta", etiqueta: "Vender" },
  { href: "/mi-reporte", etiqueta: "Mi reporte" },
];

/**
 * Las dos pantallas del vendedor.
 *
 * No es una barra lateral —el vendedor trabaja de pie, con una mano— sino dos
 * pestañas del ancho de la pantalla, con objetivo de toque grande. Vender va
 * primero porque es a lo que se entra.
 */
export function PestanasVendedor() {
  const ruta = usePathname();

  return (
    <nav className="flex-none bg-superficie border-b border-riel flex">
      {PESTANAS.map(({ href, etiqueta }) => {
        const activa = ruta === href || ruta.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            prefetch={false}
            aria-current={activa ? "page" : undefined}
            className={cn(
              "flex-1 text-center py-3 text-base font-medium border-b-2",
              activa
                ? "border-acento text-acento-fuerte"
                : "border-transparent text-secundario",
            )}
          >
            {etiqueta}
          </Link>
        );
      })}
    </nav>
  );
}
