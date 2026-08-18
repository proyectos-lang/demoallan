import {
  Digitalizador,
  type OpcionSorteo,
  type OpcionVendedor,
} from "@/components/digitalizacion/digitalizador";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { MODELO } from "@/lib/ia/gemini";
import { hoyHonduras, iso, mesNombre } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export default async function DigitalizacionPage() {
  const supabase = await crearClienteServidor();

  const hoy = hoyHonduras();
  const primeroDeMes = iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1));

  const [{ data: vendedores }, { data: sorteos }, { data: gasto }] = await Promise.all([
    supabase.from("vendedor").select("id, nombre, codigo").eq("activo", true).order("codigo"),
    // Sólo tiene sentido digitalizar hacia un sorteo que aún admite ventas: los
    // tickets se crean por la misma puerta que una venta móvil, y esa puerta
    // exige que el sorteo esté abierto.
    supabase
      .from("sorteo")
      .select("id, fecha, hora")
      .eq("estado", "abierto")
      .gt("hora_cierre", new Date().toISOString())
      .order("hora_cierre"),
    supabase.rpc("fn_gasto_ocr", { p_desde: primeroDeMes, p_hasta: iso(hoy) }),
  ]);

  const g = gasto?.[0];

  const opcionesSorteo: OpcionSorteo[] = (sorteos ?? []).map((s) => {
    const [, m, d] = s.fecha.split("-").map(Number);
    return { id: s.id, fecha: `${d} ${mesNombre(m - 1)}`, hora: s.hora };
  });

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Digitalización IA"
        subtitulo="Lectura de hojas manuscritas, corrección asistida y cuadre contra el total declarado."
        acciones={
          <Tarjeta padding="10px 14px">
            <span className="flex gap-5 text-meta">
              <span>
                <span className="block text-label text-secundario">Modelo</span>
                <strong className="font-semibold">{MODELO}</strong>
              </span>
              <span>
                <span className="block text-label text-secundario">Gasto del mes</span>
                <strong className="font-semibold">
                  ${Number(g?.costo_total ?? 0).toFixed(2)} · {g?.lotes ?? 0} hojas
                </strong>
              </span>
            </span>
          </Tarjeta>
        }
      />

      {opcionesSorteo.length === 0 ? (
        <TarjetaNota>
          No hay ningún sorteo abierto al que enviar las apuestas. Un lote digitalizado crea
          tickets por la misma puerta que una venta móvil, y esa puerta exige un sorteo en venta.
        </TarjetaNota>
      ) : (
        <Digitalizador
          vendedores={(vendedores ?? []) as OpcionVendedor[]}
          sorteos={opcionesSorteo}
        />
      )}
    </Pagina>
  );
}
