import Link from "next/link";

import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import {
  fechaHonduras,
  fechaLargaSinDia,
  fmt,
  horaHonduras,
  iso,
  mesNombre,
  pad2,
} from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/** Franja horaria de la bitácora: de 8 de la mañana a 8 de la noche. */
const HORA_INICIAL = 8;
const HORAS = 13;
const DIAS_SERIE = 14;

export default async function ControlPage(props: PageProps<"/control">) {
  const params = await props.searchParams;
  const supabase = await crearClienteServidor();

  const { data: vendedores } = await supabase
    .from("vendedor")
    .select("id, nombre, codigo, zona, color")
    .eq("activo", true)
    .order("codigo");

  if (!vendedores?.length) {
    return (
      <Pagina>
        <EncabezadoPagina titulo="Control de vendedores" />
        <TarjetaNota>No hay vendedores activos.</TarjetaNota>
      </Pagina>
    );
  }

  const vendedorId =
    (typeof params.vendedor === "string" && params.vendedor) || vendedores[0].id;
  const vendedor = vendedores.find((v) => v.id === vendedorId) ?? vendedores[0];
  const fecha = typeof params.fecha === "string" ? params.fecha : fechaHonduras();
  const hora = typeof params.hora === "string" ? params.hora : "";

  const enlace = (cambios: Record<string, string>) => {
    const p = new URLSearchParams({ vendedor: vendedor.id, fecha, ...(hora ? { hora } : {}), ...cambios });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/control?${p.toString()}`;
  };

  // Rango de la serie de 14 días.
  const hastaSerie = fecha;
  const desdeSerie = iso(new Date(new Date(`${fecha}T12:00:00`).getTime() - (DIAS_SERIE - 1) * 86_400_000));

  const [{ data: bitacora }, { data: actividad }, { data: serie }] = await Promise.all([
    supabase.rpc("fn_bitacora_vendedor", {
      p_vendedor_id: vendedor.id,
      p_fecha: fecha,
      p_hora: (hora || null) as never,
    }),
    supabase.rpc("fn_actividad_horaria", { p_vendedor_id: vendedor.id, p_fecha: fecha }),
    supabase.rpc("fn_reporte_filas", {
      p_desde: desdeSerie,
      p_hasta: hastaSerie,
      p_vendedor_id: vendedor.id,
      p_limite: 500,
    }),
  ]);

  const lineas = bitacora ?? [];

  // Los totales salen de las líneas, que es la unidad atómica. Los premios y la
  // utilidad sólo cuentan sorteos liquidados.
  const venta = lineas.reduce((a, l) => a + Number(l.monto), 0);
  const liquidadas = lineas.filter((l) => l.estado === "liquidado");
  const ventaLiquidada = liquidadas.reduce((a, l) => a + Number(l.monto), 0);
  const premios = liquidadas.reduce((a, l) => a + Number(l.premio), 0);
  const pendiente = venta - ventaLiquidada;
  const ganadoras = liquidadas.filter((l) => l.gana).length;

  // Actividad por hora, en la rejilla fija de 8:00 a 20:00.
  const porHora = new Array(HORAS).fill(0);
  for (const a of actividad ?? []) {
    const i = Math.max(0, Math.min(HORAS - 1, Number(a.hora_reloj) - HORA_INICIAL));
    porHora[i] += Number(a.monto);
  }
  const maxHora = Math.max(1, ...porHora);
  const idxPico = porHora.indexOf(Math.max(...porHora));

  // Serie de 14 días.
  const porDia = new Map<string, number>();
  for (let i = 0; i < DIAS_SERIE; i++) {
    const d = iso(new Date(new Date(`${desdeSerie}T12:00:00`).getTime() + i * 86_400_000));
    porDia.set(d, 0);
  }
  for (const f of serie ?? []) {
    porDia.set(f.fecha, (porDia.get(f.fecha) ?? 0) + Number(f.venta));
  }
  const dias = [...porDia.entries()];
  const maxDia = Math.max(1, ...dias.map(([, v]) => v));

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Control de vendedores"
        subtitulo="Bitácora de líneas con hora exacta, número, monto y punto de venta."
      />

      <div className="flex flex-col gap-[14px]">
        <Tarjeta padding="14px 18px">
          <div className="flex gap-4 flex-wrap items-end">
            <div>
              <span className="block text-label text-secundario font-medium mb-[6px]">Vendedor</span>
              <div className="flex gap-[6px] flex-wrap">
                {vendedores.map((v) => (
                  <Link
                    key={v.id}
                    href={enlace({ vendedor: v.id })}
                    className={cn(
                      "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                      v.id === vendedor.id
                        ? "bg-tinta text-white border-tinta"
                        : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                    )}
                  >
                    {v.codigo}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-label text-secundario font-medium mb-[6px]">Sorteo</span>
              <div className="flex gap-[6px]">
                {[
                  { v: "", e: "Todos" },
                  { v: "11:00", e: "11:00" },
                  { v: "15:00", e: "15:00" },
                  { v: "20:00", e: "20:00" },
                ].map((o) => (
                  <Link
                    key={o.v || "todos"}
                    href={enlace({ hora: o.v })}
                    className={cn(
                      "rounded-campo px-[13px] py-[7px] text-meta font-medium border",
                      hora === o.v
                        ? "bg-tinta text-white border-tinta"
                        : "bg-superficie text-cuerpo border-borde-campo hover:bg-panel",
                    )}
                  >
                    {o.e}
                  </Link>
                ))}
              </div>
            </div>

            <span className="ml-auto text-meta text-secundario">
              {vendedor.codigo} · {vendedor.zona} · {fechaLargaSinDia(fecha)}
            </span>
          </div>
        </Tarjeta>

        <div className="flex gap-[14px] flex-wrap">
          {[
            {
              e: "Venta del día",
              v: fmt(venta),
              p: `${lineas.length} ${lineas.length === 1 ? "línea registrada" : "líneas registradas"}`,
            },
            {
              e: "Premios pagados",
              v: liquidadas.length ? fmt(premios) : "pendiente",
              p: `${ganadoras} ${ganadoras === 1 ? "línea ganadora" : "líneas ganadoras"}`,
            },
            {
              e: "Venta sin liquidar",
              v: pendiente > 0 ? fmt(pendiente) : "—",
              p: pendiente > 0 ? "sin premios calculados todavía" : "todo el día está liquidado",
            },
            {
              e: "Hora pico",
              v: porHora[idxPico] > 0 ? `${HORA_INICIAL + idxPico}:00` : "—",
              p: porHora[idxPico] > 0 ? fmt(porHora[idxPico]) : "sin ventas registradas",
            },
          ].map((k) => (
            <Tarjeta key={k.e} className="flex-1 min-w-[190px]" padding="16px 18px">
              <span className="block text-meta font-medium text-cuerpo">{k.e}</span>
              <span className="block text-h1 font-semibold tracking-titular mt-1">{k.v}</span>
              <span className="block text-label text-secundario mt-1">{k.p}</span>
            </Tarjeta>
          ))}
        </div>

        <div className="flex gap-[18px] flex-wrap items-start">
          {/* Bitácora: la única vista que baja a la línea individual. */}
          <Tarjeta padding="0" className="flex-1 min-w-[560px] overflow-hidden">
            <div className="flex justify-between items-baseline px-[18px] py-4">
              <h2 className="text-h2 font-semibold tracking-sutil m-0">Bitácora de ventas</h2>
              <span className="text-meta text-secundario">
                {lineas.length} {lineas.length === 1 ? "línea" : "líneas"}
              </span>
            </div>

            {lineas.length === 0 ? (
              <div className="m-4 border border-dashed border-borde-punteado rounded-pos py-[30px] px-[18px] text-center">
                <p className="text-base font-medium text-cuerpo m-0">
                  Sin ventas registradas este día
                </p>
                <p className="text-meta text-mudo mt-1 mb-0">
                  Aparecerán aquí en cuanto el vendedor registre su primer ticket.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                <table className="w-full border-collapse text-tabla min-w-[600px]">
                  <thead>
                    <tr className="bg-tinte">
                      {["HORA", "SORTEO", "NÚMERO", "MONTO", "PREMIO", "PUNTO DE VENTA"].map(
                        (th, i) => (
                          <th
                            key={th}
                            className={cn(
                              "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                              i === 3 || i === 4 ? "text-right" : "text-left",
                              i === 0 ? "pl-4 pr-3" : i === 5 ? "pl-3 pr-4" : "px-3",
                            )}
                          >
                            {th}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {lineas.map((l, i) => {
                      return (
                        <tr key={i} className={cn(l.gana && "bg-ambar-fila-ganadora")}>
                          <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                            {horaHonduras(l.creado_en)}
                          </td>
                          <td className="border-b border-fondo py-[11px] px-3 text-secundario">
                            {l.hora}
                          </td>
                          <td className="border-b border-fondo py-[11px] px-3">
                            <span
                              className={cn(
                                "inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda text-meta font-semibold",
                                l.gana
                                  ? "bg-ambar-ganador text-ambar-ganador-texto"
                                  : "bg-chip text-tinta",
                              )}
                            >
                              {pad2(l.numero)}
                            </span>
                          </td>
                          <td className="border-b border-fondo py-[11px] px-3 text-right">
                            {fmt(Number(l.monto), false)}
                          </td>
                          <td
                            className={cn(
                              "border-b border-fondo py-[11px] px-3 text-right",
                              l.gana ? "text-negativo font-semibold" : "text-mudo",
                            )}
                          >
                            {l.gana ? fmt(Number(l.premio), false) : "—"}
                          </td>
                          <td className="border-b border-fondo py-[11px] pl-3 pr-4 text-secundario">
                            {l.lat !== null && l.lng !== null
                              ? `${vendedor.zona} · ${Number(l.lat).toFixed(3)}, ${Number(l.lng).toFixed(3)}`
                              : vendedor.zona}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Tarjeta>

          <div className="flex-1 min-w-[280px] max-w-[340px] flex flex-col gap-[14px]">
            <Tarjeta padding="16px 18px">
              <h2 className="text-card font-semibold m-0">Actividad por hora</h2>
              <div className="flex items-end gap-[5px] h-[120px] mt-4">
                {porHora.map((v, i) => (
                  <span
                    key={i}
                    title={`${HORA_INICIAL + i}:00 · ${fmt(v)}`}
                    className="flex-1 flex flex-col justify-end h-full"
                  >
                    <span
                      className="block rounded-t-barra-geo"
                      style={{
                        height: v > 0 ? `${Math.max(3, Math.round((v / maxHora) * 100))}%` : "2px",
                        background:
                          v > maxHora * 0.66 ? vendedor.color : v > 0 ? "var(--color-barra-baja)" : "var(--color-borde)",
                        borderRadius: "5px 5px 2px 2px",
                      }}
                    />
                  </span>
                ))}
              </div>
              <div className="flex justify-between text-th text-mudo mt-2">
                <span>8am</span>
                <span>2pm</span>
                <span>8pm</span>
              </div>
            </Tarjeta>

            <Tarjeta padding="16px 18px">
              <h2 className="text-card font-semibold m-0">Actividad por día</h2>
              <p className="text-label text-secundario mt-1 mb-0">últimos {DIAS_SERIE} días</p>
              <div className="flex items-end gap-1 h-[120px] mt-4">
                {dias.map(([d, v]) => (
                  <span key={d} title={`${d} · ${fmt(v)}`} className="flex-1 flex flex-col justify-end h-full">
                    <span
                      style={{
                        height: v > 0 ? `${Math.max(3, Math.round((v / maxDia) * 100))}%` : "2px",
                        background:
                          v > maxDia * 0.8 ? vendedor.color : v > 0 ? "var(--color-barra-baja)" : "var(--color-borde)",
                        borderRadius: "5px 5px 2px 2px",
                        display: "block",
                      }}
                    />
                  </span>
                ))}
              </div>
              <div className="flex justify-between text-th text-mudo mt-2">
                <span>
                  {Number(desdeSerie.split("-")[2])} {mesNombre(Number(desdeSerie.split("-")[1]) - 1)}
                </span>
                <span>
                  {Number(fecha.split("-")[2])} {mesNombre(Number(fecha.split("-")[1]) - 1)}
                </span>
              </div>
            </Tarjeta>

            <TarjetaNota>
              La coordenada de cada línea es dato operativo sensible: se guarda con el ticket y sólo
              la ven perfiles administrativos. Nunca sale en la consulta pública.
            </TarjetaNota>
          </div>
        </div>
      </div>
    </Pagina>
  );
}
