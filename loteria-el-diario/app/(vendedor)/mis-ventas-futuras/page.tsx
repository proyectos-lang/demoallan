import { redirect } from "next/navigation";

import { PuntoDeVenta } from "@/components/pos/punto-de-venta";
import {
  SelectorFuturo,
  type SorteoDisponible,
} from "@/components/vendedor/selector-futuro";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { esSorteo, fechaLarga, hora12, hoyHonduras, iso } from "@/lib/format";
import type { DatosPos, SorteoPos, VendedorPos } from "@/lib/pos/use-pos";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Cuántos días se ofrecen a la vez en el selector de franjas. */
const VENTANA = 30;

/**
 * Ventas futuras: apostar hoy a un sorteo de más tarde o de otro día.
 *
 * POR QUÉ ESTÁ APARTE DE «VENDER»
 * -------------------------------
 * La pantalla de vender tiene un trabajo y uno solo: registrar rápido lo que
 * alguien está pidiendo AHORA, contra el sorteo que está abierto. Meterle un
 * calendario obligaría a elegir día en cada venta corriente, que es la
 * inmensa mayoría.
 *
 * Aquí la pregunta es otra —«quiero jugar el 15 al número tal»— y merece su
 * propio gesto: primero se elige el día, después la franja, y sólo entonces
 * aparece la rejilla.
 *
 * EL SORTEO PUEDE NO EXISTIR TODAVÍA
 * ----------------------------------
 * El ciclo automático sólo siembra hoy y mañana. Para vender al 15 de octubre
 * hay que crear ese sorteo, y `fn_asegurar_sorteo` lo hace en el momento de
 * registrar, no antes: así no hay mil sorteos abiertos a la vez y el resto del
 * sistema sigue sabiendo cuál es el de ahora.
 *
 * De ahí que el selector muestre días sin sorteo creado como vendibles: lo que
 * se ofrece es la FRANJA de esa fecha, y el sorteo aparece cuando alguien la
 * usa de verdad.
 */
export default async function VentasFuturasPage({
  searchParams,
}: PageProps<"/mis-ventas-futuras">) {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();
  const params = await searchParams;

  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  const hoy = iso(hoyHonduras());
  const pedida = texto("dia");
  // Nunca hacia atrás: un sorteo que ya pasó no admite apuestas, y ofrecerlo
  // sólo produce un rechazo que el vendedor no entiende.
  const fecha = FECHA.test(pedida) && pedida >= hoy ? pedida : hoy;
  const horaPedida = texto("hora");
  const hora = esSorteo(horaPedida) ? horaPedida : "";

  // Los sorteos de la ventana, existan o no. Se pide el rango entero de una
  // vez: son noventa filas y evita una consulta por cada cambio de día.
  const hasta = new Date(`${hoy}T00:00:00`);
  hasta.setDate(hasta.getDate() + VENTANA);

  const { data: disponibles, error } = await supabase.rpc("fn_sorteos_disponibles", {
    p_desde: hoy,
    p_hasta: iso(hasta),
  });

  /*
   * Si la base todavía no tiene la migración, se dice — no se revienta.
   *
   * PostgREST devuelve PGRST202 cuando la función no existe. El despliegue de
   * la aplicación y el de la base son dos gestos distintos que no llegan a la
   * vez, y una pantalla que se cae con «no se pudo cargar» no da ninguna pista
   * de qué falta.
   */
  if (error) {
    return (
      <TarjetaNota>
        {error.code === "PGRST202"
          ? "Las ventas futuras todavía no están habilitadas en la base de datos. Avise a administración."
          : `No se pudieron cargar los sorteos: ${error.message}`}
      </TarjetaNota>
    );
  }

  const sorteos: SorteoDisponible[] = (disponibles ?? []).map((s) => ({
    fecha: s.r_fecha,
    hora: s.r_hora,
    vendible: s.r_vendible,
    motivo: s.r_vendible
      ? null
      : s.r_estado === "liquidado"
        ? "ya se jugó"
        : "la venta cerró",
  }));

  const elegido = hora
    ? sorteos.find((s) => s.fecha === fecha && s.hora === hora)
    : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta padding="16px 18px">
        <SelectorFuturo fecha={fecha} hora={hora} sorteos={sorteos} hoy={hoy} />
      </Tarjeta>

      {!hora ? (
        <TarjetaNota>
          Elija el sorteo al que va la apuesta. Puede ser uno de más tarde de hoy o de
          cualquier día por delante.
        </TarjetaNota>
      ) : !elegido?.vendible ? (
        <TarjetaNota>
          El sorteo de {hora12(hora)} del {fechaLarga(fecha)} ya no admite ventas.
        </TarjetaNota>
      ) : (
        <Vender vendedorId={vendedorId} fecha={fecha} hora={hora} />
      )}
    </div>
  );
}

/**
 * El punto de venta de siempre, atado al sorteo futuro elegido.
 *
 * Se reutiliza entero —rejilla, teclado, tanda, recibo— porque una venta
 * futura no es un tipo distinto de venta: lo único que cambia es a qué sorteo
 * va. Duplicar la pantalla habría significado mantener dos.
 */
async function Vender({
  vendedorId,
  fecha,
  hora,
}: {
  vendedorId: string;
  fecha: string;
  hora: string;
}) {
  const supabase = await crearClienteServidor();

  const { data: vendedorFila } = await supabase
    .from("vendedor")
    .select(
      "id, codigo, nombre, parametro_vendedor!inner(comision, factor_pago, tope_por_numero, vigente_hasta)",
    )
    .eq("id", vendedorId)
    .is("parametro_vendedor.vigente_hasta", null)
    .maybeSingle();

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

  // El sorteo puede no existir todavía: se busca, y si no está se ofrece igual
  // con el cupo entero libre. Se creará al confirmar la venta.
  const { data: sorteo } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, hora_cierre, estado")
    .eq("fecha", fecha)
    .eq("hora", hora as "11:00" | "15:00" | "21:00")
    .maybeSingle();

  const disponibleCasa = new Array(100).fill(0);
  const vendidoPropio: Record<string, number[]> = {
    [vendedorId]: new Array(100).fill(0),
  };

  if (sorteo) {
    const { data: cupos } = await supabase
      .from("cupo_numero")
      .select("numero, limite_casa, vendido")
      .eq("sorteo_id", sorteo.id);

    for (const c of cupos ?? []) {
      disponibleCasa[c.numero] = Number(c.limite_casa) - Number(c.vendido);
    }

    const { data: propio } = await supabase.rpc("fn_vendido_por_vendedor", {
      p_sorteo_id: sorteo.id,
    });
    for (const l of propio ?? []) {
      if (l.r_vendedor_id === vendedorId) {
        vendidoPropio[vendedorId][l.r_numero] += Number(l.r_vendido);
      }
    }
  } else {
    /*
     * Sorteo aún sin crear: el cupo está entero.
     *
     * Se usa el tope del VENDEDOR y no el de la casa, que es el más
     * restrictivo de los dos en la práctica y el único que se conoce sin haber
     * sembrado la franja. La cifra es orientativa de todos modos: quien decide
     * es `fn_registrar_ticket`, dentro de la transacción y con la fila de cupo
     * bloqueada. Lo que se pinta mientras se teclea nunca fue autoritativo.
     */
    disponibleCasa.fill(Number(p.tope_por_numero));
  }

  const sorteoPos: SorteoPos = sorteo
    ? {
        id: sorteo.id,
        fecha: sorteo.fecha,
        hora: sorteo.hora,
        hora_cierre: sorteo.hora_cierre,
        estado: sorteo.estado,
      }
    : {
        // Sin identificador: la venta se manda por fecha y franja, y la base
        // crea el sorteo. La cadena vacía marca ese caso.
        id: "",
        fecha,
        hora,
        hora_cierre: `${fecha}T00:00:00Z`,
        estado: "abierto",
      };

  const datos: DatosPos = {
    sorteo: sorteoPos,
    sorteos: [sorteoPos],
    vendedores,
    disponibleCasa,
    vendidoPropio,
    propio: true,
    // Lo que convierte esta pantalla en «venta futura»: el hook manda fecha y
    // franja en vez del identificador del sorteo.
    futura: { fecha, hora },
  };

  return <PuntoDeVenta datos={datos} />;
}
