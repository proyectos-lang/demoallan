import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";

import { salir } from "@/app/login/acciones";
import { MenuVendedor, TituloVendedor } from "@/components/vendedor/menu-vendedor";
import { iniciales } from "@/lib/format";
import { sesionVigente } from "@/lib/sesion-vigente";

/**
 * Shell del vendedor.
 *
 * Nada de barra lateral: el vendedor tiene una sola pantalla y trabaja de pie,
 * casi siempre en un teléfono. Una cabecera delgada con su nombre y la salida
 * es todo lo que necesita, y deja la altura libre para el teclado numérico.
 */
export default async function VendedorLayout({ children }: LayoutProps<"/">) {
  // Si al vendedor lo inactivaron o lo eliminaron mientras tenía la pantalla
  // abierta, aquí es donde se entera: `sesionVigente` borra la cookie y la
  // siguiente navegación cae en /login.
  const sesion = await sesionVigente();

  if (!sesion) redirect("/login");

  // Se repite la comprobación del proxy a propósito: desde que RLS no recorta
  // por rol, un descuido de enrutado ya no lo ataja la base.
  if (sesion.rol !== "vendedor") redirect("/tablero");
  if (!sesion.vendedor_id) redirect("/login");

  return (
    /*
     * `100dvh` y no `100vh`: en un móvil la barra de direcciones se recoge y
     * se despliega, y con `vh` el pie del punto de venta —el subtotal y el
     * botón de confirmar— quedaba debajo de ella.
     *
     * `overflow-x-hidden` porque el shell administrativo lo tiene y éste no:
     * cualquier ancho fijo que se pase de los 360px de un teléfono hacía que
     * la página se pudiera arrastrar en horizontal.
     */
    <div className="min-h-[100dvh] flex flex-col overflow-x-hidden">
      {/*
        La cabecera se queda en lo mínimo: menú, dónde estoy y salir.

        Antes llevaba además el logotipo, el acceso a la clave y las iniciales,
        más una fila de pestañas debajo. Eran unos noventa píxeles fijos en una
        pantalla donde la rejilla de cien números ya obliga a desplazarse; lo
        que no es imprescindible se fue al menú.
      */}
      <header className="flex-none bg-nav-fondo px-3 py-2 flex items-center gap-3">
        <MenuVendedor
          nombre={sesion.nombre}
          codigo={iniciales(sesion.nombre) || sesion.nombre.slice(0, 2).toUpperCase()}
        />

        <span className="block min-w-0 flex-1">
          <TituloVendedor />
          <span className="block text-th text-nav-seccion truncate">{sesion.nombre}</span>
        </span>

        <form action={salir} className="flex-none">
          <button
            type="submit"
            className="w-10 h-10 rounded-campo flex items-center justify-center bg-nav-chip"
            aria-label="Salir"
          >
            <LogOut size={17} color="var(--color-nav-item)" strokeWidth={2} absoluteStrokeWidth />
          </button>
        </form>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">{children}</main>
    </div>
  );
}
