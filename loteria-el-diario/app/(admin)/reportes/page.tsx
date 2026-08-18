import { FiltrosReporte, type Preset } from "@/components/reportes/filtros";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fmt, hoyHonduras, iso, mesNombre, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/** El prototipo enseña 80 filas y calcula los subtotales sobre todo el filtro. */
const FILAS_VISIBLES = 80;

function construirPresets(hoy: Date): Preset[] {
  const d = (x: Date) => iso(x);
  const menos = (n: number) => new Date(hoy.getTime() - n * 86_400_000);
  const primeroDeMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const primeroMesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const ultimoMesAnterior = new Date(hoy.getFullYear(), hoy.getMonth(), 0);

  return [
    { id: "hoy", etiqueta: "Hoy", desde: d(hoy), hasta: d(hoy) },
    { id: "7d", etiqueta: "Últimos 7 días", desde: d(menos(6)), hasta: d(hoy) },
    { id: "mes", etiqueta: "Mes actual", desde: d(primeroDeMes), hasta: d(hoy) },
    { id: "prev", etiqueta: "Mes anterior", desde: d(primeroMesAnterior), hasta: d(ultimoMesAnterior) },
    { id: "todo", etiqueta: "Todo el año", desde: `${hoy.getFullYear()}-01-01`, hasta: d(hoy) },
  ];
}

export default async function ReportesPage(props: PageProps<"/reportes">) {
  const params = await props.searchParams;
  const texto = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");

  const presets = construirPresets(hoyHonduras());
  const porDefecto = presets.find((p) => p.id === "mes")!;

  const valores = {
    desde: texto("desde") || porDefecto.desde,
    hasta: texto("hasta") || porDefecto.hasta,
    vendedor: texto("vendedor"),
    hora: texto("hora"),
    numero: texto("numero"),
    preset: texto("preset") || (texto("desde") ? "" : "mes"),
  };

  const supabase = await crearClienteServidor();

  const argumentos = {
    p_desde: valores.desde,
    p_hasta: valores.hasta,
    p_vendedor_id: valores.vendedor || null,
    p_hora: (valores.hora || null) as never,
    p_numero: valores.numero ? Number(valores.numero) : null,
  };

  const [{ data: vendedores }, { data: totales }, { data: filas }] = await Promise.all([
    supabase.from("vendedor").select("id, nombre, codigo").eq("activo", true).order("codigo"),
    supabase.rpc("fn_reporte_totales", argumentos),
    supabase.rpc("fn_reporte_filas", {
      ...argumentos,
      p_limite: FILAS_VISIBLES,
      p_desde_fila: 0,
    }),
  ]);

  const t = totales?.[0];
  const registros = Number(t?.registros ?? 0);
  const conteo = `${registros} ${registros === 1 ? "registro" : "registros"} · ${t?.dias ?? 0} ${
    Number(t?.dias) === 1 ? "día" : "días"
  }`;

  const subtotales: [string, string][] = [
    ["VENTAS", fmt(Number(t?.venta ?? 0), false)],
    ["COMISIÓN", fmt(Number(t?.comision ?? 0), false)],
    ["PREMIO", fmt(Number(t?.premios ?? 0), false)],
    ["UTILIDAD", fmt(Number(t?.utilidad ?? 0), false)],
  ];

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Reportes"
        subtitulo="Tabla filtrable por rango de fechas, vendedor, hora y número ganador."
      />

      <div className="flex flex-col gap-[14px]">
        <FiltrosReporte
          valores={valores}
          vendedores={vendedores ?? []}
          presets={presets}
          conteo={conteo}
        />

        {registros === 0 ? (
          <TarjetaNota>
            El filtro no devuelve registros. Si buscaste por número ganador, ten en cuenta que sólo
            casa con sorteos ya liquidados: uno sin liquidar todavía no tiene número.
          </TarjetaNota>
        ) : (
          <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[900px]">
                <thead>
                  {/* Los subtotales suman TODO el filtro, no sólo lo visible. */}
                  <tr className="bg-panel">
                    <th
                      colSpan={4}
                      className="text-left text-label font-semibold tracking-subtotal text-secundario py-3 pl-4 pr-3 border-b border-riel"
                    >
                      SUBTOTALES DEL FILTRO
                    </th>
                    {subtotales.map(([k, v], i) => (
                      <th
                        key={k}
                        className={cn(
                          "text-right text-h2 font-semibold py-3 border-b border-riel",
                          i === subtotales.length - 1 ? "pl-3 pr-4" : "px-3",
                        )}
                      >
                        {v}
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-tinte">
                    {["FECHA", "VENDEDOR", "SORTEO", "GANADOR", "VENTAS", "COMISIÓN", "PREMIO", "UTILIDAD"].map(
                      (th, i) => (
                        <th
                          key={th}
                          className={cn(
                            "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                            i >= 4 ? "text-right" : "text-left",
                            i === 0 ? "pl-4 pr-3" : i === 7 ? "pl-3 pr-4" : "px-3",
                          )}
                        >
                          {th}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(filas ?? []).map((f, i) => {
                    const liq = f.estado === "liquidado";
                    const [, m, d] = f.fecha.split("-").map(Number);
                    return (
                      <tr key={i} className="hover:bg-tinte">
                        <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                          {d} {mesNombre(m - 1)}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 font-medium">
                          {f.vendedor}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-secundario">
                          {f.hora}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3">
                          {liq && f.numero_ganador !== null ? (
                            <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte text-meta font-semibold">
                              {pad2(f.numero_ganador)}
                            </span>
                          ) : (
                            <span className="text-mudo">—</span>
                          )}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {fmt(Number(f.venta), false)}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {liq ? fmt(Number(f.comision), false) : "—"}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {liq ? fmt(Number(f.premios), false) : "—"}
                        </td>
                        <td
                          className="border-b border-fondo py-[11px] pl-3 pr-4 text-right"
                          style={{
                            color: !liq
                              ? "var(--color-secundario)"
                              : Number(f.utilidad) < 0
                                ? "var(--color-negativo)"
                                : "var(--color-positivo)",
                          }}
                        >
                          {liq ? fmt(Number(f.utilidad), false) : "pendiente"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-[13px] bg-tinte border-t border-riel text-meta text-secundario leading-[1.55]">
              {registros > FILAS_VISIBLES
                ? `Mostrando ${FILAS_VISIBLES} de ${registros} registros. Los subtotales de arriba corresponden al filtro completo.`
                : `Subtotales calculados sobre los ${registros} registros del filtro.`}
              {Number(t?.registros_pendientes ?? 0) > 0 && (
                <>
                  {" "}
                  {t!.registros_pendientes} de esos registros son de sorteos sin liquidar:{" "}
                  {fmt(Number(t!.venta_pendiente))} de venta que todavía no tiene premios ni
                  utilidad calculados, y por eso no entra en los subtotales de esas columnas.
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Pagina>
  );
}
