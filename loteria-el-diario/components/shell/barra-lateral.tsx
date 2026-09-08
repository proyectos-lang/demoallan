"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlignLeft,
  ClipboardList,
  Menu,
  X,
  FlaskConical,
  LayoutDashboard,
  MapPin,
  Receipt,
  ScanText,
  SlidersHorizontal,
  Smartphone,
  Table,
  TrendingUp,
  Trophy,
  UserSearch,
  type LucideIcon,
} from "lucide-react";

import { BotonesApp } from "@/components/shell/instalar";
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
      {
        href: "/informe",
        etiqueta: "Informe de gerencia",
        Icono: ClipboardList,
        color: "var(--color-nav-i-informe)",
      },
      {
        href: "/analisis",
        etiqueta: "Análisis de resultados",
        Icono: TrendingUp,
        color: "var(--color-nav-i-analisis)",
      },
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
  const [abierta, setAbierta] = useState(false);
  /*
   * Si la pantalla es de las que esconden la barra.
   *
   * Arranca en `false` —el mismo valor en el servidor y en el cliente— y se
   * corrige al montar: leer el ancho durante el render daría dos resultados
   * distintos y React avisaría del desajuste de hidratación.
   */
  const [esMovil, setEsMovil] = useState(false);

  useEffect(() => {
    const consulta = window.matchMedia("(max-width: 1023.98px)");
    const sincronizar = () => setEsMovil(consulta.matches);
    sincronizar();
    consulta.addEventListener("change", sincronizar);
    return () => consulta.removeEventListener("change", sincronizar);
  }, []);

  /*
   * El cajón se cierra al cambiar de pantalla.
   *
   * En un teléfono el menú tapa la página entera: si siguiera abierto después
   * de tocar un enlace, el administrador llegaría a la pantalla nueva sin
   * verla, con el menú por encima, y tendría que cerrarlo a mano cada vez.
   */
  useEffect(() => {
    setAbierta(false);
  }, [ruta]);

  /*
   * Con el cajón abierto no se hace scroll por detrás.
   *
   * Sin esto, arrastrar sobre el menú mueve la página de abajo: se cierra el
   * cajón y uno aparece en otro punto de una pantalla que no eligió.
   */
  useEffect(() => {
    if (!abierta) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, [abierta]);

  // Se recorta antes de pintar para no dejar secciones vacías con su título.
  const secciones = SECCIONES.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.roles || i.roles.includes(rol)),
  })).filter((s) => s.items.length > 0);

  return (
    <>
      {/*
        La cabecera móvil: el único sitio desde donde se abre el menú.

        En escritorio no existe (`lg:hidden`) porque allí la barra está siempre
        a la vista. `safe-area-inset-top` NO es adorno: con `viewportFit:
        "cover"` la página llega al borde de la pantalla, y en un iPhone
        instalado este botón quedaba DEBAJO del reloj — se veía, pero el toque
        se lo comía la barra de estado. Es el mismo arreglo que ya se hizo en
        el portal del vendedor.
      */}
      <header
        className="lg:hidden flex-none bg-nav-fondo px-3 py-2 flex items-center gap-3 sticky top-0 z-40"
        style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
      >
        <button
          type="button"
          onClick={() => setAbierta(true)}
          aria-label="Abrir el menú"
          aria-expanded={abierta}
          className="w-10 h-10 flex-none rounded-campo bg-nav-chip flex items-center justify-center"
        >
          <Menu size={19} color="var(--color-nav-item)" strokeWidth={2} absoluteStrokeWidth />
        </button>

        <span className="block min-w-0 flex-1">
          <span className="block text-meta font-semibold text-nav-titulo truncate">
            {SECCIONES.flatMap((s) => s.items).find(
              (i) => ruta === i.href || ruta.startsWith(`${i.href}/`),
            )?.etiqueta ?? "Sistema de Control de Tickets"}
          </span>
          <span className="block text-th text-nav-seccion truncate">{nombre}</span>
        </span>

        <span className="w-8 h-8 flex-none rounded-full bg-nav-chip text-nav-titulo text-meta font-semibold flex items-center justify-center">
          {iniciales}
        </span>
      </header>

      {/*
        El velo. Sólo en móvil y sólo con el cajón abierto: da dónde tocar para
        cerrar y separa visualmente el menú de la pantalla que hay debajo.
      */}
      {abierta && (
        <button
          type="button"
          aria-label="Cerrar el menú"
          onClick={() => setAbierta(false)}
          className="lg:hidden fixed inset-0 z-40 bg-black/45"
        />
      )}

      <aside
        className={cn(
          "w-[262px] flex-none bg-nav-fondo flex flex-col overflow-y-auto",
          /*
            UNA sola barra, colocada de dos maneras.

            En escritorio es una columna del layout, como siempre. En móvil se
            saca del flujo y se desliza desde la izquierda, así que el
            contenido recupera el ancho completo de la pantalla: eran 128px de
            390 los que quedaban para trabajar.

            Se renderiza siempre —no se monta y desmonta— para que no haya dos
            copias del menú que mantener, y para que la transición tenga desde
            dónde animar.
          */
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50",
          "max-lg:transition-transform max-lg:duration-200",
          abierta ? "max-lg:translate-x-0 max-lg:shadow-2xl" : "max-lg:-translate-x-full",
        )}
        /*
         * Cerrado, el cajón no debe ser alcanzable con el teclado ni por un
         * lector de pantalla: sigue en el árbol, pero fuera de servicio. Sin
         * esto, tabular desde la cabecera recorre doce enlaces invisibles
         * antes de llegar al contenido.
         *
         * Sólo cuenta en móvil: en escritorio la barra está siempre a la
         * vista, y `abierta` no se toca ahí. Por eso se ata al ancho con una
         * media query en vez de a `abierta` a secas — si no, en escritorio la
         * barra quedaría inerte con el cajón «cerrado», que es su estado
         * normal.
         */
        inert={!abierta && esMovil ? true : undefined}
      >
        {/* Cerrar, sólo en móvil: en escritorio la barra no se cierra. */}
        <button
          type="button"
          onClick={() => setAbierta(false)}
          aria-label="Cerrar el menú"
          className="lg:hidden absolute top-3 right-3 w-9 h-9 rounded-campo bg-nav-chip flex items-center justify-center"
          style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
        >
          <X size={17} color="var(--color-nav-item)" strokeWidth={2} absoluteStrokeWidth />
        </button>

      {/* Marca */}
      <div className="flex items-center gap-[11px] px-[18px] pt-5 pb-[18px]">
        <span
          className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
          style={{ background: "var(--gradiente-logo)" }}
        >
          <AlignLeft size={20} color="#fff" strokeWidth={2} absoluteStrokeWidth />
        </span>
        <span className="block text-card font-semibold tracking-sutil text-nav-titulo leading-[1.25]">
          Sistema de Control
          <br />
          de Tickets
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

      <BotonesApp variante="oscuro" className="mt-auto px-[10px] pb-2" />

      {/* Usuario */}
      <div className="flex items-center gap-[10px] px-[18px] py-[14px] border-t border-nav-linea">
        <span className="w-8 h-8 flex-none rounded-full bg-nav-chip text-nav-titulo text-meta font-semibold flex items-center justify-center">
          {iniciales}
        </span>
        <span className="block min-w-0">
          <span className="block text-meta font-medium truncate text-nav-titulo">{nombre}</span>
          <span className="block text-th truncate text-nav-seccion">{ETIQUETA_ROL[rol] ?? rol}</span>
        </span>
      </div>
      </aside>
    </>
  );
}
