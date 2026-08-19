"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlignLeft,
  FlaskConical,
  LayoutDashboard,
  MapPin,
  ScanText,
  SlidersHorizontal,
  Smartphone,
  Table,
  Trophy,
  UserSearch,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";

type Item = {
  href: string;
  etiqueta: string;
  Icono: LucideIcon;
  /**
   * Cada item lleva su propio color de trazo, que es lo que permite localizar
   * una sección de un vistazo. Sobre el marino se usan las variantes claras:
   * los tonos originales del prototipo se eligieron contra un chip claro y
   * cuatro de ellos no llegaban a 3:1 aquí.
   */
  color: string;
};

const SECCIONES: { titulo: string; items: Item[] }[] = [
  {
    titulo: "OPERACIÓN",
    items: [
      { href: "/tablero", etiqueta: "Tablero de control", Icono: LayoutDashboard, color: "var(--color-nav-i-tablero)" },
      { href: "/punto-de-venta", etiqueta: "Punto de venta", Icono: Smartphone, color: "var(--color-nav-i-pos)" },
      { href: "/resultados", etiqueta: "Sorteos y resultados", Icono: Trophy, color: "var(--color-nav-i-sorteos)" },
      { href: "/digitalizacion", etiqueta: "Digitalización IA", Icono: ScanText, color: "var(--color-nav-i-ocr)" },
    ],
  },
  {
    titulo: "ANÁLISIS",
    items: [
      { href: "/reportes", etiqueta: "Reportes", Icono: Table, color: "var(--color-nav-i-reportes)" },
      { href: "/control", etiqueta: "Control de vendedores", Icono: UserSearch, color: "var(--color-nav-i-control)" },
      { href: "/geo", etiqueta: "Geo-referenciación", Icono: MapPin, color: "var(--color-nav-i-geo)" },
      { href: "/simulador", etiqueta: "Simulador", Icono: FlaskConical, color: "var(--color-nav-i-simulador)" },
    ],
  },
  {
    titulo: "CONFIGURACIÓN",
    items: [
      { href: "/vendedores", etiqueta: "Vendedores y límites", Icono: SlidersHorizontal, color: "var(--color-nav-i-vendedores)" },
    ],
  },
];

export function BarraLateral({
  nombre,
  rol,
  iniciales,
}: {
  nombre: string;
  rol: string;
  iniciales: string;
}) {
  const ruta = usePathname();

  return (
    <aside className="w-[262px] flex-none bg-nav-fondo flex flex-col overflow-y-auto">
      {/* Marca */}
      <div className="flex items-center gap-[11px] px-[18px] pt-5 pb-[18px]">
        <span
          className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
          style={{ background: "var(--gradiente-logo)" }}
        >
          <AlignLeft size={20} color="#fff" strokeWidth={2} absoluteStrokeWidth />
        </span>
        <span className="block text-h2 font-semibold tracking-sutil text-nav-titulo">
          Lotería El Diario
        </span>
      </div>

      {SECCIONES.map((seccion, i) => (
        <div key={seccion.titulo}>
          <div
            className={cn(
              "px-[18px] pb-2 text-eyebrow font-semibold tracking-seccion text-nav-seccion",
              i === 0 ? "pt-0" : "pt-[10px]",
            )}
          >
            {seccion.titulo}
          </div>
          <nav className="flex flex-col gap-[2px] px-[10px] pb-2">
            {seccion.items.map(({ href, etiqueta, Icono, color }) => {
              const activo = ruta === href || ruta.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={activo ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-[11px] px-[10px] py-2 rounded-campo text-base font-medium",
                    activo
                      ? "bg-nav-activo text-nav-titulo font-semibold"
                      : "text-nav-item hover:bg-nav-hover",
                  )}
                >
                  <span
                    className={cn(
                      "w-7 h-7 flex-none rounded-chip flex items-center justify-center",
                      activo ? "bg-white/15" : "bg-nav-chip",
                    )}
                  >
                    {/* El activo va en blanco: sobre el relleno azul, el color
                        propio del item competiría con el fondo en vez de
                        destacar. */}
                    <Icono
                      size={15}
                      color={activo ? "#fff" : color}
                      strokeWidth={2}
                      absoluteStrokeWidth
                    />
                  </span>
                  {etiqueta}
                </Link>
              );
            })}
          </nav>
        </div>
      ))}

      {/* Usuario */}
      <div className="mt-auto flex items-center gap-[10px] px-[18px] py-[14px] border-t border-nav-linea">
        <span className="w-8 h-8 flex-none rounded-full bg-nav-chip text-nav-titulo text-meta font-semibold flex items-center justify-center">
          {iniciales}
        </span>
        <span className="block min-w-0">
          <span className="block text-meta font-medium truncate text-nav-titulo">{nombre}</span>
          <span className="block text-th truncate text-nav-seccion">{rol}</span>
        </span>
      </div>
    </aside>
  );
}
