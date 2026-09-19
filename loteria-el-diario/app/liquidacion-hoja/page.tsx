import { redirect } from "next/navigation";

import { VistaHoja } from "@/app/(admin)/liquidacion/vista-hoja";
import { sesionVigente } from "@/lib/sesion-vigente";

export const dynamic = "force-dynamic";

/**
 * La hoja de un vendedor, SIN el shell administrativo, para embeberla en el
 * modal de la pestaña de saldos.
 *
 * Vive fuera del grupo `(admin)` a propósito: así no hereda la barra lateral ni
 * el aviso de versión —dentro de un iframe estorbarían— y sólo trae el
 * contenido de la hoja. Reusa `VistaHoja` en modo `modal`, que es la MISMA hoja
 * de siempre (pagar, saldar, imprimir, saldo inicial, reversar cortes); no se
 * duplica ni una línea de su lógica.
 *
 * La guarda de rol se repite aquí porque al salir del grupo `(admin)` ya no
 * pasa por su layout: sin sesión de administrador, a login. Bajo `service_role`
 * la base no recorta por rol, así que esta comprobación es la que manda.
 */
export default async function HojaModalPage({
  searchParams,
}: PageProps<"/liquidacion-hoja">) {
  const sesion = await sesionVigente();
  if (!sesion) redirect("/login");
  if (sesion.rol !== "administrador") redirect("/tablero");

  const params = await searchParams;

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-fondo min-h-[100dvh]">
      <VistaHoja params={params} modal />
    </div>
  );
}
