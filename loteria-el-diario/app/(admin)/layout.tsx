import { redirect } from "next/navigation";

import { AvisoVersion } from "@/components/shell/aviso-version";
import { BarraLateral } from "@/components/shell/barra-lateral";
import { iniciales } from "@/lib/format";
import { inicioSegunRol } from "@/lib/sesion";
import { sesionVigente } from "@/lib/sesion-vigente";

/**
 * Shell administrativo: barra lateral fija de 262px y contenido con su propio
 * scroll. El prototipo no tiene nada `sticky`; los dos paneles simplemente
 * hacen scroll por separado.
 */
export default async function AdminLayout({ children }: LayoutProps<"/">) {
  // `sesionVigente` y no `sesionActual`: la cookie va firmada pero no se puede
  // revocar, así que una cuenta desactivada seguiría entrando hasta doce horas.
  const sesion = await sesionVigente();

  // El proxy ya redirige sin sesión; esto cubre el caso de que alguien llegue
  // por otra vía y evita renderizar el shell sin identidad. La comprobación se
  // repite a propósito: desde que RLS no recorta por rol, un descuido aquí ya
  // no lo ataja la base.
  if (!sesion) redirect("/login");

  // Un vendedor no tiene nada que hacer en las pantallas administrativas: están
  // hechas para ver a todo el padrón.
  if (sesion.rol === "vendedor") redirect(inicioSegunRol(sesion.rol));

  return (
    /*
     * En escritorio, dos columnas: barra y contenido, cada una con su scroll.
     * En móvil, una sola columna —cabecera arriba y contenido debajo—, porque
     * la barra pasa a ser un cajón que se sale del flujo.
     *
     * `100dvh` y no `h-screen` en móvil: la barra de direcciones se recoge y
     * se despliega, y con la altura fija el pie de las tablas quedaba debajo
     * de ella. Es la misma razón por la que el portal del vendedor ya lo usa.
     */
    <div className="flex flex-col lg:flex-row h-[100dvh] lg:h-screen overflow-hidden">
      <BarraLateral
        nombre={sesion.nombre}
        rol={sesion.rol}
        iniciales={iniciales(sesion.nombre) || sesion.nombre.slice(0, 2).toUpperCase()}
      />
      <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>

      {/* El mismo aviso que ve el vendedor: administración también deja la
          pantalla abierta el día entero. */}
      <AvisoVersion />
    </div>
  );
}
