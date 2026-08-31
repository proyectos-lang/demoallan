import { redirect } from "next/navigation";

import { PuntoDeVenta } from "@/components/pos/punto-de-venta";
import { TarjetaNota } from "@/components/ui/tarjeta";
import type { DatosPos, SorteoPos, VendedorPos } from "@/lib/pos/use-pos";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Vender, y nada más.
 *
 * Esta pantalla llevaba debajo todo el resumen del día: comisión, tres
 * indicadores, la tabla sorteo por sorteo y los tickets. Con la rejilla de cien
 * números delante eso son miles de píxeles de desplazamiento en la pantalla
 * cuyo único trabajo, mientras hay alguien esperando, es registrar.
 *
 * El resumen se mudó a «Mis ventas del día» y los informes a «Liquidaciones»;
 * a los dos se llega por el menú.
 */
export default async function MiVentaPage() {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();

  // El vendedor sale de la SESIÓN y no de la petición: es la diferencia entre
  // vender a nombre propio y a nombre de cualquiera.
  const { data: vendedorFila } = await supabase
    .from("vendedor")
    .select(
      "id, codigo, nombre, parametro_vendedor!inner(comision, factor_pago, tope_por_numero, vigente_hasta)",
    )
    .eq("id", vendedorId)
    .is("parametro_vendedor.vigente_hasta", null)
    .maybeSingle();

  return <Vender vendedorFila={vendedorFila} vendedorId={vendedorId} />;
}

/** El punto de venta, atado a este vendedor. */
async function Vender({
  vendedorFila,
  vendedorId,
}: {
  vendedorFila: unknown;
  vendedorId: string;
}) {
  const supabase = await crearClienteServidor();

  const { data: sorteo } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, hora_cierre, estado")
    .eq("estado", "abierto")
    .gt("hora_cierre", new Date().toISOString())
    .order("hora_cierre")
    .limit(1)
    .maybeSingle();

  if (!sorteo) {
    return (
      <TarjetaNota>
        No hay ningún sorteo abierto en este momento. En cuanto abra el siguiente podrá seguir
        registrando ventas desde aquí.
      </TarjetaNota>
    );
  }

  const v = vendedorFila as
    | {
        id: string;
        codigo: string;
        nombre: string;
        parametro_vendedor:
          | { comision: number; factor_pago: number; tope_por_numero: number }
          | { comision: number; factor_pago: number; tope_por_numero: number }[];
      }
    | null;

  if (!v) {
    return (
      <TarjetaNota>
        Su cuenta no tiene parámetros vigentes, así que todavía no puede vender. Avise a
        administración.
      </TarjetaNota>
    );
  }

  const p = Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor;

  const vendedores: VendedorPos[] = [
    {
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre,
      comision: Number(p.comision),
      factor_pago: Number(p.factor_pago),
      tope_por_numero: Number(p.tope_por_numero),
    },
  ];

  const { data: cupos } = await supabase
    .from("cupo_numero")
    .select("numero, limite_casa, vendido")
    .eq("sorteo_id", sorteo.id);

  const disponibleCasa = new Array(100).fill(0);
  for (const c of cupos ?? []) {
    disponibleCasa[c.numero] = Number(c.limite_casa) - Number(c.vendido);
  }

  // Sólo lo suyo: pedir el agregado de todo el sorteo sería traer el consumo de
  // los otros veintinueve vendedores, que a él no le incumbe.
  const { data: propio } = await supabase.rpc("fn_vendido_por_vendedor", {
    p_sorteo_id: sorteo.id,
  });

  const vendidoPropio: Record<string, number[]> = { [vendedorId]: new Array(100).fill(0) };
  for (const l of propio ?? []) {
    if (l.r_vendedor_id === vendedorId) {
      vendidoPropio[vendedorId][l.r_numero] += Number(l.r_vendido);
    }
  }

  const sorteoPos: SorteoPos = {
    id: sorteo.id,
    fecha: sorteo.fecha,
    hora: sorteo.hora,
    hora_cierre: sorteo.hora_cierre,
    estado: sorteo.estado,
  };

  const datos: DatosPos = {
    sorteo: sorteoPos,
    sorteos: [sorteoPos],
    vendedores,
    disponibleCasa,
    vendidoPropio,
    propio: true,
  };

  return <PuntoDeVenta datos={datos} />;
}
