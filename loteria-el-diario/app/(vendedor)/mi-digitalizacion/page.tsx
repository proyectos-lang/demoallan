import { redirect } from "next/navigation";

import {
  Digitalizador,
  type OpcionSorteo,
  type OpcionVendedor,
} from "@/components/digitalizacion/digitalizador";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { mesNombre } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Digitalizar ventas escritas, desde el portal del vendedor.
 *
 * Es el mismo módulo del panel administrativo, con dos diferencias que lo
 * cambian todo:
 *
 *   · NO SE ELIGE A NOMBRE DE QUIÉN. El vendedor sale de la sesión, y la
 *     acción de servidor ignora lo que mande el navegador. Antes ese id venía
 *     de un desplegable, que es exactamente lo que un vendedor no debe tener.
 *
 *   · EL TOTAL DE LA HOJA ES OBLIGATORIO. En el panel puede suplirlo la
 *     lectura del modelo si logró leer el pie del papel. Aquí no: quien tiene
 *     la hoja delante es el vendedor, y el cuadre es suyo. Suplirlo con la
 *     lectura sería quitar el control justo donde la lectura puede fallar.
 *
 * El cuadre lo hace él mismo: corrige los renglones que el modelo leyó con
 * poca confianza y confirma sólo cuando la suma da igual al total que escribió.
 * La base lo vuelve a comprobar antes de crear un solo ticket.
 */
export default async function MiDigitalizacionPage() {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();

  const [{ data: vendedor }, { data: sorteos }] = await Promise.all([
    supabase.from("vendedor").select("id, nombre, codigo").eq("id", vendedorId).maybeSingle(),
    // Sólo tiene sentido digitalizar hacia un sorteo que aún admite ventas: los
    // tickets se crean por la misma puerta que una venta móvil, y esa puerta
    // exige que el sorteo esté abierto.
    supabase
      .from("sorteo")
      .select("id, fecha, hora")
      .eq("estado", "abierto")
      .gt("hora_cierre", new Date().toISOString())
      .order("hora_cierre"),
  ]);

  const opcionesSorteo: OpcionSorteo[] = (sorteos ?? []).map((s) => {
    const [, m, d] = s.fecha.split("-").map(Number);
    return { id: s.id, fecha: `${d} ${mesNombre(m - 1)}`, hora: s.hora };
  });

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-[1120px] mx-auto">
      <div>
        <h1 className="text-h1 font-semibold tracking-titular m-0">Digitalizar ventas escritas</h1>
        <p className="text-meta text-secundario mt-[5px] mb-0 leading-[1.55] max-w-[70ch]">
          Fotografíe su hoja, escriba el total que sumó y revise lo que se leyó. Las apuestas se
          registran a su nombre, y sólo cuando la suma cuadre con el total que escribió.
        </p>
      </div>

      {!vendedor ? (
        <TarjetaNota>Su cuenta no está enlazada a ningún vendedor. Avise a administración.</TarjetaNota>
      ) : opcionesSorteo.length === 0 ? (
        <TarjetaNota>
          No hay ningún sorteo abierto al que enviar las apuestas. Una hoja digitalizada crea
          tickets por la misma puerta que una venta desde el teléfono, y esa puerta exige un
          sorteo en venta.
        </TarjetaNota>
      ) : (
        <Digitalizador
          vendedores={[vendedor as OpcionVendedor]}
          sorteos={opcionesSorteo}
          propio
        />
      )}
    </div>
  );
}
