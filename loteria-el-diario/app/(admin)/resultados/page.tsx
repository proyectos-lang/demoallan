import {
  CapturaResultado,
  type ResultadoHistorico,
  type SorteoCaptura,
} from "@/components/resultados/captura-resultado";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaLargaSinDia, mesNombre } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function ResultadosPage() {
  const supabase = await crearClienteServidor();

  // El sorteo a capturar: el cerrado más antiguo sin liquidar. Si no hay
  // ninguno, se ofrece cerrar el abierto cuya venta ya venció — porque hoy
  // nada hace esa transición sola.
  const { data: cerrado } = await supabase
    .from("sorteo")
    .select("id, fecha, hora, estado")
    .eq("estado", "cerrado")
    .order("fecha")
    .order("hora")
    .limit(1)
    .maybeSingle();

  const { data: porCerrar } = cerrado
    ? { data: null }
    : await supabase
        .from("sorteo")
        .select("id, fecha, hora, estado")
        .eq("estado", "abierto")
        .lte("hora_cierre", new Date().toISOString())
        .order("hora_cierre")
        .limit(1)
        .maybeSingle();

  const objetivo = cerrado ?? porCerrar;

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
