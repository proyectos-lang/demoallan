import { redirect } from "next/navigation";

import { BarraLateral } from "@/components/shell/barra-lateral";
import { iniciales } from "@/lib/format";
import { inicioSegunRol, sesionActual } from "@/lib/sesion";

const ETIQUETA_ROL: Record<string, string> = {
  administrador: "Administrador",
  auditor: "Auditor",
  digitador: "Digitador",
  vendedor: "Vendedor",
};

/**
 * Shell administrativo: barra lateral fija de 262px y contenido con su propio
 * scroll. El prototipo no tiene nada `sticky`; los dos paneles simplemente
 * hacen scroll por separado.
 */
export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const sesion = await sesionActual();

  // El proxy ya redirige sin sesión; esto cubre el caso de que alguien llegue
  // por otra vía y evita renderizar el shell sin identidad. La comprobación se
  // repite a propósito: desde que RLS no recorta por rol, un descuido aquí ya
  // no lo ataja la base.
  if (!sesion) redirect("/login");

  // Un vendedor no tiene nada que hacer en las pantallas administrativas: están
  // hechas para ver a todo el padrón.
  if (sesion.rol === "vendedor") redirect(inicioSegunRol(sesion.rol));

  return (
    <div className="flex h-screen overflow-hidden">
      <BarraLateral
        nombre={sesion.nombre}
        rol={ETIQUETA_ROL[sesion.rol] ?? sesion.rol}
        iniciales={iniciales(sesion.nombre) || sesion.nombre.slice(0, 2).toUpperCase()}
      />
      <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
    </div>
  );
}
