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
  //
  // El conteo de líneas viene ya hecho de la base. Antes se pedían TODAS las
  // líneas de los ~700 tickets del día sólo para contarlas aquí: tres mil filas
  // por la red y un recorrido de `linea` en cada carga, dieciséis segundos con
  // el histórico completo.
  const { data: tickets } = await supabase.rpc("fn_mapa_dia", {
    p_fecha: fecha,
    p_vendedor_id: vendedorActivo || null,
  });

  const porId = new Map((vendedores ?? []).map((v) => [v.id, v]));

  const puntos: Punto[] = (tickets ?? []).map((t) => {
    const v = porId.get(t.r_vendedor_id);
    return {
      folio: t.r_folio,
      lat: Number(t.r_lat),
      lng: Number(t.r_lng),
      total: Number(t.r_total),
      lineas: t.r_lineas,
      hora: t.r_hora,
      reloj: horaHonduras(t.r_creado_en),
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
