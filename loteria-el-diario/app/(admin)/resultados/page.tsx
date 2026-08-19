import {
  CapturaResultado,
  type ResultadoHistorico,
  type SorteoCaptura,
} from "@/components/resultados/captura-resultado";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaLargaSinDia, horaHonduras, mesNombre } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function ResultadosPage() {
  const supabase = await crearClienteServidor();

  // El sorteo a capturar: el cerrado más antiguo sin liquidar.
  const { data: cerrado } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, estado, hora_cierre")
    .eq("estado", "cerrado")
    .order("fecha")
    .order("hora")
    .limit(1)
    .maybeSingle();

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
  const { data: porCerrar } = cerrado
    ? { data: null }
    : await supabase
        .from("sorteo")
        .select("id, fecha, hora, estado, hora_cierre")
        .eq("estado", "abierto")
        .order("hora_cierre")
        .limit(1)
        .maybeSingle();

  const objetivo = cerrado ?? porCerrar;
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
        <TarjetaNota>
          No hay ningún sorteo pendiente de captura. Aparecerá aquí en cuanto se cierre la venta
          de alguno.
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
    cierraA: ventaVigente ? horaHonduras(objetivo.hora_cierre) : null,
  };

  return (
    <Pagina ancho={1120}>
      <EncabezadoPagina
        titulo="Sorteos y resultados"
        subtitulo="Captura del número ganador con revisión de impacto y doble digitación."
      />
      <CapturaResultado sorteo={sorteo} historicos={historicos} />
    </Pagina>
  );
}
