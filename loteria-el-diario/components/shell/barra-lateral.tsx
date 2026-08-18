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
  /** Cada item lleva su propio color de trazo en el prototipo. */
  color: string;
};

const SECCIONES: { titulo: string; items: Item[] }[] = [
  {
    titulo: "OPERACIÓN",
    items: [
      { href: "/tablero", etiqueta: "Tablero de control", Icono: LayoutDashboard, color: "#2563eb" },
      { href: "/punto-de-venta", etiqueta: "Punto de venta", Icono: Smartphone, color: "#0d9488" },
      { href: "/resultados", etiqueta: "Sorteos y resultados", Icono: Trophy, color: "#d97706" },
      { href: "/digitalizacion", etiqueta: "Digitalización IA", Icono: ScanText, color: "#7c3aed" },
    ],
  },
  {
    titulo: "ANÁLISIS",
    items: [
      { href: "/reportes", etiqueta: "Reportes", Icono: Table, color: "#0891b2" },
      { href: "/control", etiqueta: "Control de vendedores", Icono: UserSearch, color: "#e11d48" },
      { href: "/geo", etiqueta: "Geo-referenciación", Icono: MapPin, color: "#059669" },
      { href: "/simulador", etiqueta: "Simulador", Icono: FlaskConical, color: "#4f46e5" },
    ],
  },
  {
    titulo: "CONFIGURACIÓN",
    items: [
      { href: "/vendedores", etiqueta: "Vendedores y límites", Icono: SlidersHorizontal, color: "#ea580c" },
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
    <aside className="w-[262px] flex-none bg-superficie border-r border-borde flex flex-col overflow-y-auto">
      {/* Marca */}
      <div className="flex items-center gap-[11px] px-[18px] pt-5 pb-4">
        <span
          className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
          style={{ background: "var(--gradiente-logo)" }}
        >
          <AlignLeft size={20} color="#fff" strokeWidth={2} absoluteStrokeWidth />
        </span>
        <span className="block">
          <span className="block text-h2 font-semibold tracking-sutil">
            Lotería El Diario
          </span>
          <span className="block text-label text-secundario mt-[2px]">
            Cortés · Honduras
          </span>
        </span>
      </div>

      {SECCIONES.map((seccion, i) => (
        <div key={seccion.titulo}>
          <div
            className={cn(
              "px-[18px] pb-2 text-eyebrow font-semibold tracking-seccion text-mudo",
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
                  className={cn(
                    "flex items-center gap-[11px] px-[10px] py-2 rounded-campo text-base font-medium",
                    activo
                      ? "bg-acento-suave text-acento-fuerte"
                      : "text-tinta-nav hover:bg-chip",
                  )}
                >
                  <span
                    className={cn(
                      "w-7 h-7 flex-none rounded-chip flex items-center justify-center",
                      activo ? "bg-superficie" : "bg-chip",
                    )}
                  >
                    <Icono size={15} color={color} strokeWidth={2} absoluteStrokeWidth />
                  </span>
                  {etiqueta}
                </Link>
              );
            })}
          </nav>
        </div>
      ))}

      {/* Usuario */}
      <div className="mt-auto flex items-center gap-[10px] px-[18px] py-[14px] border-t border-riel">
        <span className="w-8 h-8 flex-none rounded-full bg-acento-suave text-acento-fuerte text-meta font-semibold flex items-center justify-center">
          {iniciales}
        </span>
        <span className="block min-w-0">
          <span className="block text-meta font-medium truncate">{nombre}</span>
          <span className="block text-th text-secundario truncate">{rol}</span>
        </span>
      </div>
    </aside>
  );
}
