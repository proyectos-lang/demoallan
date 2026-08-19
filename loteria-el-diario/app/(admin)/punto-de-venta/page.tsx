import { PuntoDeVenta, type DatosPos, type VendedorPos } from "@/components/pos/punto-de-venta";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function PuntoDeVentaPage() {
  const supabase = await crearClienteServidor();

  // El sorteo contra el que se vende ahora: el abierto que cierra antes, pero
  // sólo si su cierre sigue en el futuro.
  //
  // El filtro por hora no sobra: hoy nada pasa un sorteo de `abierto` a
  // `cerrado` al llegar la hora (eso será un proceso automático). Sin él, la
  // pantalla ofrecería vender en un sorteo cuya venta ya cerró, y el rechazo
  // aparecería recién al confirmar el ticket.
  const { data: sorteo } = await supabase
    .from("sorteo")
    .select("id, hora, hora_cierre")
    .eq("estado", "abierto")
    .gt("hora_cierre", new Date().toISOString())
    .order("hora_cierre")
    .limit(1)
    .maybeSingle();

  if (!sorteo) {
    return (
      <Pagina>
        <EncabezadoPagina
          titulo="Punto de venta"
          subtitulo="Captura de tickets con validación de cupo en vivo."
        />
        <TarjetaNota>
          No hay ningún sorteo abierto en este momento, así que no se puede vender. Los sorteos
          del día se programan con <code>node supabase/programar-dia.mjs</code>; más adelante lo
          hará un proceso automático a la hora de apertura.
        </TarjetaNota>
      </Pagina>
    );
  }

  const { data: vendedoresCrudos } = await supabase
    .from("vendedor")
    .select(
      "id, codigo, nombre, parametro_vendedor!inner(comision, factor_pago, tope_por_numero, vigente_hasta)",
    )
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");

  const vendedores: VendedorPos[] = (vendedoresCrudos ?? []).map((v) => {
    const p = Array.isArray(v.parametro_vendedor) ? v.parametro_vendedor[0] : v.parametro_vendedor;
    return {
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre,
      comision: Number(p.comision),
      factor_pago: Number(p.factor_pago),
      tope_por_numero: Number(p.tope_por_numero),
    };
  });

  // Cupo de la casa: 100 filas por sorteo.
  const { data: cupos } = await supabase
    .from("cupo_numero")
    .select("numero, limite_casa, vendido")
    .eq("sorteo_id", sorteo.id);

  const disponibleCasa = new Array(100).fill(0);
  for (const c of cupos ?? []) {
    disponibleCasa[c.numero] = Number(c.limite_casa) - Number(c.vendido);
  }

  // Lo ya vendido por cada vendedor en cada número, para el segundo nivel de
  // tope. Agregado en la base: son a lo sumo 30 x 100 filas. Antes se traían las
  // ~10.000 líneas del sorteo para sumarlas aquí, y con el histórico completo
  // la pantalla tardaba casi nueve segundos en abrir.
  const { data: lineas } = await supabase.rpc("fn_vendido_por_vendedor", {
    p_sorteo_id: sorteo.id,
  });

  const vendidoPropio: Record<string, number[]> = {};
  for (const v of vendedores) vendidoPropio[v.id] = new Array(100).fill(0);
  for (const l of lineas ?? []) {
    const porNumero = vendidoPropio[l.r_vendedor_id];
    if (porNumero) porNumero[l.r_numero] += Number(l.r_vendido);
  }

  const datos: DatosPos = {
    sorteo: { id: sorteo.id, hora: sorteo.hora, hora_cierre: sorteo.hora_cierre },
    vendedores,
    disponibleCasa,
    vendidoPropio,
  };

  return (
    <Pagina>
      <PuntoDeVenta datos={datos} />
    </Pagina>
  );
}
