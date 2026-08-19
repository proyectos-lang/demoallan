import Link from "next/link";
import { redirect } from "next/navigation";
import { AlignLeft, KeyRound, LogOut } from "lucide-react";

import { salir } from "@/app/login/acciones";
import { iniciales } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";

/**
 * Shell del vendedor.
 *
 * Nada de barra lateral: el vendedor tiene una sola pantalla y trabaja de pie,
 * casi siempre en un teléfono. Una cabecera delgada con su nombre y la salida
 * es todo lo que necesita, y deja la altura libre para el teclado numérico.
 */
export default async function VendedorLayout({ children }: LayoutProps<"/">) {
  const sesion = await sesionActual();

  if (!sesion) redirect("/login");

  // Se repite la comprobación del proxy a propósito: desde que RLS no recorta
  // por rol, un descuido de enrutado ya no lo ataja la base.
  if (sesion.rol !== "vendedor") redirect("/tablero");
  if (!sesion.vendedor_id) redirect("/login");

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex-none bg-nav-fondo px-4 py-3 flex items-center gap-3">
        <span
          className="w-8 h-8 flex-none rounded-banner flex items-center justify-center"
          style={{ background: "var(--gradiente-logo)" }}
        >
          <AlignLeft size={17} color="#fff" strokeWidth={2} absoluteStrokeWidth />
        </span>

        <span className="block min-w-0 flex-1">
          <span className="block text-meta font-semibold text-nav-titulo truncate">
            {sesion.nombre}
          </span>
          <span className="block text-th text-nav-seccion">Vendedor</span>
        </span>

        <Link
          href="/clave"
          className="w-9 h-9 flex-none rounded-campo flex items-center justify-center bg-nav-chip"
          aria-label="Cambiar contraseña"
        >
          <KeyRound size={16} color="var(--color-nav-item)" strokeWidth={2} absoluteStrokeWidth />
        </Link>

        <form action={salir} className="flex-none">
          <button
            type="submit"
            className="w-9 h-9 rounded-campo flex items-center justify-center bg-nav-chip"
            aria-label="Salir"
          >
            <LogOut size={16} color="var(--color-nav-item)" strokeWidth={2} absoluteStrokeWidth />
          </button>
        </form>

        <span className="w-8 h-8 flex-none rounded-full bg-nav-activo text-nav-titulo text-meta font-semibold flex items-center justify-center">
          {iniciales(sesion.nombre) || sesion.nombre.slice(0, 2).toUpperCase()}
        </span>
      </header>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
