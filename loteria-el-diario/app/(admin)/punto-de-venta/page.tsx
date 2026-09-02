import { CapturaTotales, type CapturaExistente } from "@/components/pos/captura-totales";
import { ModoCaptura } from "@/components/pos/modo-captura";
import { PuntoDeVenta } from "@/components/pos/punto-de-venta";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaHonduras } from "@/lib/format";
import type { DatosPos, SorteoPos, VendedorPos } from "@/lib/pos/use-pos";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function PuntoDeVentaPage({
  searchParams,
}: PageProps<"/punto-de-venta">) {
  const supabase = await crearClienteServidor();
  const sesion = await sesionActual();

  // Sólo administración puede registrar con la venta ya cerrada. Se decide
  // aquí, del rol de la sesión, y se vuelve a decidir en la acción: lo que
  // viaja al navegador es para pintar, no para autorizar.
  const puedeForzar = sesion?.rol === "administrador";

  const params = await searchParams;
  const elegido = typeof params.sorteo === "string" ? params.sorteo : null;

  /*
   * Dos modos de captura, y sólo para administración.
   *
   * `totales` es para el vendedor que no pasó por el portal. No es una venta
   * normal —no lleva números, no consume cupo— así que no comparte pantalla
   * con la rejilla: se elige uno u otro, y el que elige es quien puede.
   */
  const porTotales = puedeForzar && params.modo === "totales";

  /*
   * Qué sorteos se ofrecen.
   *
   * Para vendedor y digitador, el de siempre: el abierto que cierra antes, y
   * sólo si su cierre sigue en el futuro. Ofrecerles uno cuya venta ya cerró
   * sería dejar que teclearan un ticket entero para descubrir el rechazo al
   * confirmar.
   *
   * Para administración, los tres del día, con su estado. Es lo que hace
   * posible registrar la apuesta rezagada de las once pasadas las once.
   */
  const consulta = supabase
    .from("sorteo")
    .select("id, fecha, hora, hora_cierre, estado")
    .order("hora_cierre");

  const { data: crudos } = puedeForzar
    ? await consulta.eq("fecha", fechaHonduras()).in("estado", ["abierto", "cerrado", "liquidado"])
    : await consulta.eq("estado", "abierto").gt("hora_cierre", new Date().toISOString()).limit(1);

  const sorteos: SorteoPos[] = (crudos ?? []).map((s) => ({
    id: s.id,
    fecha: s.fecha,
    hora: s.hora,
    hora_cierre: s.hora_cierre,
    estado: s.estado,
  }));

  /*
   * Por omisión, el que está vendiendo; si no hay ninguno abierto, el primero
   * de la lista.
   *
   * Se mira el estado y no la hora. Entre que la venta cierra y que el ciclo
   * marca el sorteo como `cerrado` pasan hasta cinco minutos, y en esa franja
   * lo que un administrador quiere delante es justamente ese sorteo: es donde
   * cae la apuesta rezagada. Comparar contra la hora aquí, además, sería una
   * lectura impura dentro del render.
   */
  const sorteo =
    sorteos.find((s) => s.id === elegido) ??
    sorteos.find((s) => s.estado === "abierto") ??
    sorteos[0];

  if (!sorteo) {
    return (
      <Pagina>
        <EncabezadoPagina
          titulo="Punto de venta"
          subtitulo="Captura de tickets con validación de cupo en vivo."
        />
        <TarjetaNota>
          No hay ningún sorteo abierto en este momento, así que no se puede vender. El ciclo
          automático programa y abre los del día cada cinco minutos; si hace falta forzarlo,{" "}
          <code>node supabase/programar-dia.mjs</code>.
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

  /*
   * Las capturas por totales vivas de este sorteo.
   *
   * Se piden siempre que el modo esté disponible, no sólo cuando está activo:
   * son a lo sumo treinta filas y así el contador de la pestaña puede avisar
   * de que hay capturas sin que haya que entrar a mirarlas.
   */
  const { data: capturasCrudas } = puedeForzar
    ? await supabase
        .from("venta_total")
        .select("id, vendedor_id, venta, premios, comision_congelada")
        .eq("sorteo_id", sorteo.id)
        .is("anulado_en", null)
    : { data: null };

  const capturas: CapturaExistente[] = (capturasCrudas ?? []).map((c) => {
    const v = vendedores.find((x) => x.id === c.vendedor_id);
    return {
      id: c.id,
      vendedorId: c.vendedor_id,
      vendedor: v ? `${v.codigo} · ${v.nombre}` : "—",
      venta: Number(c.venta),
      premios: Number(c.premios),
      comision: Number(c.venta) * Number(c.comision_congelada),
    };
  });

  const datos: DatosPos = {
    sorteo,
    sorteos,
    vendedores,
    disponibleCasa,
    vendidoPropio,
    puedeForzar,
  };

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Punto de venta"
        subtitulo={
          porTotales
            ? "Venta y premio de un vendedor que no registró por el portal, sin el detalle de números."
            : "Captura de tickets con validación de cupo en vivo. Registrar número y monto debe costar el mínimo de toques posible."
        }
      />

      {puedeForzar && (
        <div className="mb-4">
          <ModoCaptura
            modo={porTotales ? "totales" : "detalle"}
            sorteoId={sorteo.id}
            capturas={capturas.length}
          />
        </div>
      )}

      {porTotales ? (
        <CapturaTotales sorteo={sorteo} vendedores={vendedores} capturas={capturas} />
      ) : (
        <PuntoDeVenta datos={datos} />
      )}
    </Pagina>
  );
}
