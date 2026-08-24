"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlignLeft,
  FlaskConical,
  LayoutDashboard,
  MapPin,
  Receipt,
  ScanText,
  SlidersHorizontal,
  Smartphone,
  Table,
  Trophy,
  UserSearch,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";
import type { RolUsuario } from "@/lib/supabase/tipos";

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
  /**
   * Quién ve el item. Sin `roles`, lo ve cualquier perfil administrativo, que
   * es como se comportaban las nueve secciones originales.
   *
   * El recorte de aquí es de presentación: quita el enlace de la vista, no
   * cierra la ruta. Quien la cierra es `permitida()` en `proxy.ts`, y la
   * guarda de la propia página. Las tres cosas tienen que decir lo mismo.
   */
  roles?: RolUsuario[];
};

const SECCIONES: { titulo: string; items: Item[] }[] = [
  {
    titulo: "OPERACIÓN",
    items: [
      { href: "/tablero", etiqueta: "Tablero de control", Icono: LayoutDashboard, color: "var(--color-nav-i-tablero)" },
      { href: "/punto-de-venta", etiqueta: "Punto de venta", Icono: Smartphone, color: "var(--color-nav-i-pos)" },
      { href: "/resultados", etiqueta: "Sorteos y resultados", Icono: Trophy, color: "var(--color-nav-i-sorteos)" },
      {
        href: "/liquidacion",
        etiqueta: "Liquidación semanal",
        Icono: Receipt,
        color: "var(--color-nav-i-liquidacion)",
        // Aquí se cierran cuentas y se entrega dinero: no es una pantalla de
        // consulta y no la abre ni el auditor ni el digitador.
        roles: ["administrador"],
      },
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

const ETIQUETA_ROL: Record<RolUsuario, string> = {
  administrador: "Administrador",
  auditor: "Auditor",
  digitador: "Digitador",
  vendedor: "Vendedor",
};

export function BarraLateral({
  nombre,
  rol,
  iniciales,
}: {
  nombre: string;
  /** El rol crudo, no la etiqueta: la barra necesita decidir con él. */
  rol: RolUsuario;
  iniciales: string;
}) {
  const ruta = usePathname();

  // Se recorta antes de pintar para no dejar secciones vacías con su título.
  const secciones = SECCIONES.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.roles || i.roles.includes(rol)),
  })).filter((s) => s.items.length > 0);

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

      {secciones.map((seccion, i) => (
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
                  /*
                   * Sin precarga, a propósito.
                   *
                   * Next precarga por omisión todo enlace que entre en pantalla.
                   * Con nueve pantallas administrativas en la barra, cada
                   * navegación disparaba nueve renderizados completos a la vez
                   * —cada uno agregando cientos de miles de líneas— y varios
                   * superaban el límite de tiempo de la base. El síntoma era un
                   * «A server error occurred» al entrar, y la causa no estaba en
                   * la pantalla que se pedía sino en las ocho que nadie pidió.
                   *
                   * El costo de quitarla es que la navegación empieza al hacer
                   * clic en vez de estar ya empezada. Es un intercambio claro
                   * mientras una pantalla cueste segundos y no milisegundos.
                   */
                  prefetch={false}
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
          <span className="block text-th truncate text-nav-seccion">{ETIQUETA_ROL[rol] ?? rol}</span>
        </span>
      </div>
    </aside>
  );
}
