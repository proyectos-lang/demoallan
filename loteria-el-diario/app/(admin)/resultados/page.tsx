import {
  CapturaResultado,
  type ResultadoHistorico,
  type SorteoCaptura,
} from "@/components/resultados/captura-resultado";
import {
  SelectorSorteo,
  type OpcionSorteo,
} from "@/components/resultados/selector-sorteo";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaHonduras, fechaLargaSinDia, horaHonduras12, mesNombre } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function ResultadosPage({
  searchParams,
}: PageProps<"/resultados">) {
  const supabase = await crearClienteServidor();

  /*
   * LA PANTALLA SE PLANTA EN EL DÍA DE HOY.
   *
   * Antes elegía sola el sorteo cerrado más antiguo del histórico y no ofrecía
   * alternativa. Con tres sorteos al día eso obliga a liquidar el de la mañana
   * para poder tocar el de la tarde, y si quedó uno sin capturar hace semanas,
   * la pantalla se quedaba anclada allí sin manera de avanzar.
   *
   * `fechaHonduras()` y no `new Date()` del servidor: en producción el
   * servidor corre en UTC, y entre las 18:00 y la medianoche de Honduras ya es
   * el día siguiente en UTC. Con la fecha del servidor, la pantalla saltaría
   * al día que viene justo durante el sorteo de la noche.
   */
  const hoy = fechaHonduras();
  const params = await searchParams;

  /*
   * SE PUEDE CAPTURAR CUALQUIER DÍA, NO SÓLO HOY.
   *
   * La pantalla se planta en el día en curso, que es lo normal, pero con un
   * selector de fecha para volver atrás. El sorteo de anoche que quedó sin
   * número es el caso que lo motiva: había un «rezagado» que sólo aparecía si
   * HOY no quedaba nada pendiente, y con tres sorteos diarios eso casi nunca
   * ocurre — el de ayer se quedaba invisible justo el día en que hay que
   * capturarlo.
   *
   * `fechaHonduras()` y no `new Date()` del servidor: en producción el
   * servidor corre en UTC, y entre las 18:00 y la medianoche de Honduras ya es
   * el día siguiente allí. Con la fecha del servidor, la pantalla saltaría al
   * día que viene justo durante el sorteo de la noche.
   */
  const FECHA = /^\d{4}-\d{2}-\d{2}$/;
  const diaPedido = typeof params.dia === "string" ? params.dia : "";
  // Hacia adelante no: un sorteo que no se ha jugado no tiene número que
  // capturar, y ofrecerlo sólo produce un rechazo que nadie entiende.
  const dia = FECHA.test(diaPedido) && diaPedido <= hoy ? diaPedido : hoy;

  const { data: sorteosDia } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, estado, hora_cierre, numero_ganador")
    .eq("fecha", dia)
    .order("hora");

  const opciones: OpcionSorteo[] = (sorteosDia ?? []).map((s) => ({
    id: s.id,
    hora: s.hora,
    estado: s.estado as OpcionSorteo["estado"],
    numero: s.numero_ganador,
  }));

  // El elegido a mano manda; si no, el primero que se pueda capturar del día.
  // Se comprueba que el id pedido sea DE ESE DÍA: sin eso, un id cualquiera en
  // la dirección sacaría la pantalla del día que muestra el selector.
  const pedido = typeof params.sorteo === "string" ? params.sorteo : null;
  const delDia = (sorteosDia ?? []).find((s) => s.id === pedido);

  const capturable = (sorteosDia ?? []).filter((s) => s.estado !== "liquidado");
  const elegidoHoy =
    delDia ??
    capturable.find((s) => s.estado === "cerrado") ??
    capturable[0] ??
    null;

  /*
   * Los rezagados: sorteos ya cerrados de días anteriores, sin número.
   *
   * Se buscan SIEMPRE, no sólo cuando el día en curso está resuelto. Son los
   * que de verdad urgen —cada uno bloquea la liquidación de su día— y el aviso
   * de arriba es lo único que hace que alguien se entere.
   */
  const { data: rezagados } = await supabase
    .from("sorteo")
    .select("id, fecha, hora")
    .eq("estado", "cerrado")
    .lt("fecha", hoy)
    .order("fecha")
    .order("hora")
    .limit(12);

  // El primero de ellos sirve de objetivo cuando el día elegido no tiene nada.
  const cerrado = elegidoHoy
    ? null
    : ((
        await supabase
          .from("sorteo")
          .select("id, fecha, hora, estado, hora_cierre")
          .eq("estado", "cerrado")
          .order("fecha")
          .order("hora")
          .limit(1)
          .maybeSingle()
      ).data ?? null);

  // Si no hay ninguno cerrado, se ofrece el abierto que cierra antes.
  //
  // Antes esto exigía que su hora de cierre ya hubiera pasado, y el resultado
  // era que entre medianoche y las 11:50 la pantalla decía «no hay ningún
  // sorteo pendiente» aunque hubiera tres sorteos del día esperando. Desde que
  // el ciclo cierra solo los vencidos, un sorteo con la venta ya vencida dura
  // como mucho cinco minutos en ese estado: la condición dejó fuera justamente
  // el caso normal.
  //
  // Cerrar la venta antes de hora es una decisión de administración legítima
  // —el prototipo ya tenía ese botón— y la pantalla explica qué implica: una
  // vez cerrado no entra ningún ticket más.
  const { data: porCerrar } = elegidoHoy || cerrado
    ? { data: null }
    : await supabase
        .from("sorteo")
        .select("id, fecha, hora, estado, hora_cierre")
        .eq("estado", "abierto")
        .order("hora_cierre")
        .limit(1)
        .maybeSingle();

  const objetivo = elegidoHoy ?? cerrado ?? porCerrar;
  // Si su venta sigue vigente, cerrarla es adelantarse, y eso hay que decirlo.
  const ventaVigente =
    !!objetivo &&
    objetivo.estado === "abierto" &&
    new Date(objetivo.hora_cierre).getTime() > Date.now();

  // Histórico: los últimos liquidados con su venta y utilidad, agregando desde
  // las liquidaciones por vendedor.
  const { data: liquidados } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, numero_ganador")
    .eq("estado", "liquidado")
    .order("fecha", { ascending: false })
    .order("hora", { ascending: false })
    .limit(6);

  const historicos: ResultadoHistorico[] = [];
  for (const s of liquidados ?? []) {
    const { data: liqs } = await supabase
      .from("liquidacion")
      .select("venta, utilidad")
      .eq("sorteo_id", s.id);

    const [a, m, d] = s.fecha.split("-").map(Number);
    historicos.push({
      numero: s.numero_ganador!,
      fecha: `${d} ${mesNombre(m - 1)}`,
      hora: s.hora,
      venta: (liqs ?? []).reduce((x, l) => x + Number(l.venta), 0),
      utilidad: (liqs ?? []).reduce((x, l) => x + Number(l.utilidad), 0),
    });
  }

  if (!objetivo) {
    return (
      <Pagina ancho={1120}>
        <EncabezadoPagina
          titulo="Sorteos y resultados"
          subtitulo="Captura del número ganador con revisión de impacto y doble digitación."
        />
        <SelectorSorteo
          sorteos={opciones}
          elegido=""
          dia={dia}
          hoy={hoy}
          rezagados={rezagados ?? []}
        />
        <TarjetaNota>
          {opciones.length > 0
            ? "Los sorteos de hoy ya tienen su número capturado."
            : "No hay ningún sorteo pendiente de captura. Aparecerá aquí en cuanto se cierre la venta de alguno."}
        </TarjetaNota>
      </Pagina>
    );
  }

  // Venta y tickets del sorteo, del mismo sitio que usa la revisión de impacto
  // para que las dos cifras no puedan discrepar.
  const { data: resumen } = await supabase.rpc("fn_impacto_numero", {
    p_sorteo_id: objetivo.id,
    p_numero: undefined,
  });

  const r = resumen?.[0];

  const sorteo: SorteoCaptura = {
    id: objetivo.id,
    fechaLarga: fechaLargaSinDia(objetivo.fecha),
    hora: objetivo.hora,
    estado: objetivo.estado as "abierto" | "cerrado",
    venta: Number(r?.venta ?? 0),
    tickets: Number(r?.tickets ?? 0),
    cierraA: ventaVigente ? horaHonduras12(objetivo.hora_cierre) : null,
  };

  return (
    <Pagina ancho={1120}>
      <EncabezadoPagina
        titulo="Sorteos y resultados"
        subtitulo="Captura del número ganador con revisión de impacto y doble digitación."
      />
      {/* Sólo si el objetivo es de hoy: con un rezagado de otro día, un
          selector rotulado «Sorteo de hoy» señalaría a otra cosa. */}
      <SelectorSorteo
        sorteos={opciones}
        elegido={objetivo.id === elegidoHoy?.id ? objetivo.id : ""}
        dia={dia}
        hoy={hoy}
        rezagados={rezagados ?? []}
      />
      <CapturaResultado sorteo={sorteo} historicos={historicos} />
    </Pagina>
  );
}
