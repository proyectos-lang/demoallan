"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CalendarDays,
  KeyRound,
  Menu,
  Receipt,
  Smartphone,
  X,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";

type Modulo = {
  href: string;
  etiqueta: string;
  detalle: string;
  Icono: LucideIcon;
};

const MODULOS: Modulo[] = [
  {
    href: "/mi-venta",
    etiqueta: "Vender",
    detalle: "Registrar tickets del sorteo abierto",
    Icono: Smartphone,
  },
  {
    href: "/mi-dia",
    etiqueta: "Mis ventas del día",
    detalle: "Comisión de hoy, sorteo por sorteo y sus tickets",
    Icono: CalendarDays,
  },
  {
    href: "/mi-reporte",
    etiqueta: "Liquidaciones e informes",
    detalle: "Día, semana o el rango que elija, y qué le han pagado",
    Icono: Receipt,
  },
  {
    href: "/clave",
    etiqueta: "Cambiar contraseña",
    detalle: "",
    Icono: KeyRound,
  },
];

/**
 * El menú del vendedor.
 *
 * Antes eran dos pestañas fijas en la cabecera. Con tres módulos y sitio para
 * más, unas pestañas se quedan sin ancho en un teléfono; y sobre todo, el punto
 * de venta necesita la pantalla entera — cada fila fija que se le quita a la
 * rejilla es una que hay que recorrer con el pulgar.
 *
 * Se abre desde arriba a la izquierda y ocupa toda la pantalla mientras está
 * abierto: los objetivos son grandes y no hay que apuntar.
 */
export function MenuVendedor({ nombre, codigo }: { nombre: string; codigo: string }) {
  const ruta = usePathname();
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    if (!abierto) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [abierto]);

  const actual = MODULOS.find(
    (m) => ruta === m.href || ruta.startsWith(`${m.href}/`),
  );

  return (
    <>
      <button
        onClick={() => setAbierto(true)}
        aria-label="Abrir el menú"
        aria-expanded={abierto}
        className="w-10 h-10 flex-none rounded-campo flex items-center justify-center bg-nav-chip"
      >
        <Menu size={20} color="var(--color-nav-titulo)" strokeWidth={2} absoluteStrokeWidth />
      </button>

      {abierto && (
        <div className="fixed inset-0 z-40 flex flex-col bg-nav-fondo">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-nav-linea">
            <span className="block min-w-0 flex-1">
              <span className="block text-meta font-semibold text-nav-titulo truncate">
                {nombre}
              </span>
              <span className="block text-th text-nav-seccion">Vendedor · {codigo}</span>
            </span>
            <button
              onClick={() => setAbierto(false)}
              aria-label="Cerrar el menú"
              className="w-10 h-10 flex-none rounded-campo flex items-center justify-center bg-nav-chip"
            >
              <X size={20} color="var(--color-nav-titulo)" strokeWidth={2} absoluteStrokeWidth />
            </button>
          </div>

          <nav className="flex flex-col gap-1 p-3 overflow-y-auto">
            {MODULOS.map(({ href, etiqueta, detalle, Icono }) => {
              const activo = href === actual?.href;
              return (
                <Link
                  key={href}
                  href={href}
                  // Sin precarga, como la barra del panel administrativo: cada
                  // una de estas pantallas agrega en la base y precargarlas
                  // todas al abrir el menú saldría caro.
                  prefetch={false}
                  // Se cierra al navegar. Va en el gesto y no en un efecto
                  // sobre la ruta: el layout no se vuelve a montar al cambiar
                  // de pantalla, y un efecto que llama a setState encadena un
                  // render de más.
                  onClick={() => setAbierto(false)}
                  aria-current={activo ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 px-3 py-[14px] rounded-campo",
                    activo ? "bg-nav-activo" : "bg-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "w-9 h-9 flex-none rounded-chip flex items-center justify-center",
                      activo ? "bg-white/15" : "bg-nav-chip",
                    )}
                  >
                    <Icono
                      size={17}
                      color={activo ? "#fff" : "var(--color-nav-item)"}
                      strokeWidth={2}
                      absoluteStrokeWidth
                    />
                  </span>
                  <span className="block min-w-0">
                    <span
                      className={cn(
                        "block text-card font-semibold",
                        activo ? "text-nav-titulo" : "text-nav-item",
                      )}
                    >
                      {etiqueta}
                    </span>
                    {detalle && (
                      <span className="block text-label text-nav-seccion leading-[1.4] mt-[2px]">
                        {detalle}
                      </span>
                    )}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </>
  );
}

/** El nombre de la pantalla en la que se está, para la cabecera. */
export function TituloVendedor() {
  const ruta = usePathname();
  const actual = MODULOS.find((m) => ruta === m.href || ruta.startsWith(`${m.href}/`));
  return (
    <span className="block text-meta font-semibold text-nav-titulo truncate">
      {actual?.etiqueta ?? "Lotería El Diario"}
    </span>
  );
}
