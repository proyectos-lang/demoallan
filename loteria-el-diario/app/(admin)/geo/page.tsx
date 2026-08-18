import Link from "next/link";

import type { Punto } from "@/components/geo/mapa";
import { PanelGeo, type OpcionVendedor, type Zona } from "@/components/geo/panel-geo";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaHonduras, fechaLargaSinDia, horaHonduras, iso } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function GeoPage(props: PageProps<"/geo">) {
  const params = await props.searchParams;
  const fecha = typeof params.fecha === "string" ? params.fecha : fechaHonduras();
  const vendedorActivo = typeof params.vendedor === "string" ? params.vendedor : "";

  const supabase = await crearClienteServidor();

  const { data: vendedores } = await supabase
    .from("vendedor")
    .select("id, nombre, codigo, color, zona")
    .eq("activo", true)
    .order("codigo");

  // Un punto por TICKET, no por línea: todas las líneas de un ticket comparten
  // la misma coordenada y se dibujarían una encima de otra. El prototipo pinta
  // por línea porque sus datos eran inventados; con datos reales el ticket es
  // la unidad que corresponde a un acto de venta en un lugar.
  let consulta = supabase
    .from("ticket")
    .select("folio, lat, lng, total, creado_en, vendedor_id, sorteo!inner(fecha, hora)")
    .eq("sorteo.fecha", fecha)
    .is("anulado_en", null)
    .not("lat", "is", null);

  if (vendedorActivo) consulta = consulta.eq("vendedor_id", vendedorActivo);

  const { data: tickets } = await consulta;

  // Cuántas líneas trae cada ticket, para el popup.
  const ids = (tickets ?? []).map((t) => t.folio);
  const { data: conteos } = ids.length
    ? await supabase
        .from("linea")
        .select("ticket_id, ticket!inner(folio)")
        .in("ticket.folio", ids)
    : { data: [] };

  const lineasPorFolio = new Map<string, number>();
  for (const l of conteos ?? []) {
    const t = Array.isArray(l.ticket) ? l.ticket[0] : l.ticket;
    lineasPorFolio.set(t.folio, (lineasPorFolio.get(t.folio) ?? 0) + 1);
  }

  const porId = new Map((vendedores ?? []).map((v) => [v.id, v]));

  const puntos: Punto[] = (tickets ?? []).map((t) => {
    const v = porId.get(t.vendedor_id);
    const s = Array.isArray(t.sorteo) ? t.sorteo[0] : t.sorteo;
    return {
      folio: t.folio,
      lat: Number(t.lat),
      lng: Number(t.lng),
      total: Number(t.total),
      lineas: lineasPorFolio.get(t.folio) ?? 0,
      hora: s.hora,
      reloj: horaHonduras(t.creado_en),
      vendedor: v?.nombre ?? "—",
      zona: v?.zona ?? "—",
      color: v?.color ?? "#2563eb",
    };
  });

  const porZona = new Map<string, Zona>();
  for (const p of puntos) {
    const z = porZona.get(p.zona) ?? { nombre: p.zona, color: p.color, monto: 0, puntos: 0 };
    z.monto += p.total;
    z.puntos += 1;
    porZona.set(p.zona, z);
  }
  const zonas = [...porZona.values()].sort((a, b) => b.monto - a.monto);

  const dia = new Date(`${fecha}T12:00:00`);
  const anterior = iso(new Date(dia.getTime() - 86_400_000));
  const siguiente = iso(new Date(dia.getTime() + 86_400_000));
  const enlace = (f: string) =>
    `/geo?fecha=${f}${vendedorActivo ? `&vendedor=${vendedorActivo}` : ""}`;

  return (
    <Pagina compacta>
      <EncabezadoPagina
        titulo="Geo-referenciación"
        subtitulo="Mapa de puntos de venta, filtrable por vendedor."
        acciones={
          <div className="flex items-center gap-2">
            <Link
              href={enlace(anterior)}
              className="w-[34px] h-[34px] flex items-center justify-center border border-borde-campo rounded-campo text-cuerpo text-h2 hover:bg-panel"
              aria-label="Día anterior"
            >
              ‹
            </Link>
            <span className="text-base font-medium">{fechaLargaSinDia(fecha)}</span>
            <Link
              href={enlace(siguiente)}
              className="w-[34px] h-[34px] flex items-center justify-center border border-borde-campo rounded-campo text-cuerpo text-h2 hover:bg-panel"
              aria-label="Día siguiente"
            >
              ›
            </Link>
          </div>
        }
      />

      {puntos.length === 0 && (
        <div className="mb-[14px]">
          <TarjetaNota>
            No hay ventas con coordenada este día. La coordenada se toma del dispositivo al
            confirmar, y sólo si el vendedor concede el permiso: una venta sin permiso se registra
            igual, pero no aparece en el mapa.
          </TarjetaNota>
        </div>
      )}

      <PanelGeo
        puntos={puntos}
        vendedores={(vendedores ?? []) as OpcionVendedor[]}
        zonas={zonas}
        vendedorActivo={vendedorActivo}
        fecha={fecha}
      />
    </Pagina>
  );
}
