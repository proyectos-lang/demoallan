import { redirect } from "next/navigation";

import { BarraLateral } from "@/components/shell/barra-lateral";
import { iniciales } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

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
  const supabase = await crearClienteServidor();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // El proxy ya redirige sin sesión; esto cubre el caso de que alguien llegue
  // por otra vía y evita renderizar el shell sin identidad.
  if (!user) redirect("/login");

  const { data: perfil } = await supabase
    .from("usuario_perfil")
    .select("nombre, rol")
    .eq("id", user.id)
    .single();

  // Usuario autenticado pero sin perfil: no tiene rol, así que no tiene
  // permisos sobre nada. Mejor devolverlo al login que mostrar un shell vacío.
  if (!perfil) redirect("/login");

  const nombre = perfil.nombre ?? user.email ?? "";

  return (
    <div className="flex h-screen overflow-hidden">
      <BarraLateral
        nombre={nombre}
        rol={ETIQUETA_ROL[perfil.rol] ?? perfil.rol}
        iniciales={iniciales(nombre) || nombre.slice(0, 2).toUpperCase()}
      />
      <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
    </div>
  );
}
