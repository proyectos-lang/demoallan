import { FiltrosControl, type OpcionVendedor } from "@/components/control/filtros-control";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import {
  fechaHonduras,
  fechaLargaSinDia,
  fmt,
  fmtK,
  hora12,
  horaHonduras12,
  iso,
  pad2,
} from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/** Franja de la rejilla de actividad: de 6 de la mañana a 9 de la noche. */
const HORA_INICIAL = 6;
const HORAS = 16;

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

  const hoy = fechaHonduras();
  const hasta = typeof params.hasta === "string" ? params.hasta : hoy;
  const desde =
    typeof params.desde === "string"
      ? params.desde
      : iso(new Date(new Date(`${hasta}T12:00:00`).getTime() - 13 * 86_400_000));
  const hora = typeof params.hora === "string" ? params.hora : "";

  // Sin `vendedores` en la URL se entiende «todos»: es el caso normal y no
  // tiene sentido arrastrar treinta identificadores para expresarlo.
  const elegidos =
    typeof params.vendedores === "string" && params.vendedores
      ? params.vendedores.split(",").filter(Boolean)
      : [];
  const filtroVendedores = elegidos.length ? elegidos : null;

  const [{ data: porVendedor }, { data: serie }, { data: actividad }] = await Promise.all([
    supabase.rpc("fn_control_vendedores", {
      p_desde: desde,
      p_hasta: hasta,
      p_vendedores: filtroVendedores,
      p_hora: (hora || null) as never,
    }),
    supabase.rpc("fn_control_serie", {
      p_desde: desde,
      p_hasta: hasta,
      p_vendedores: filtroVendedores,
      p_hora: (hora || null) as never,
    }),
    supabase.rpc("fn_control_actividad", {
      p_desde: desde,
      p_hasta: hasta,
      p_vendedores: filtroVendedores,
    }),
  ]);

  const filas = (porVendedor ?? []).map((v) => ({
    id: v.r_vendedor_id,
    codigo: v.r_codigo,
    nombre: v.r_nombre,
    zona: v.r_zona,
    color: v.r_color,
    tickets: v.r_tickets,
    lineas: v.r_lineas,
    venta: Number(v.r_venta),
    comision: Number(v.r_comision),
    premios: Number(v.r_premios),
    utilidad: Number(v.r_utilidad),
    pendiente: Number(v.r_pendiente),
  }));

  const total = filas.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      comision: a.comision + f.comision,
      premios: a.premios + f.premios,
      utilidad: a.utilidad + f.utilidad,
      tickets: a.tickets + f.tickets,
      lineas: a.lineas + f.lineas,
      pendiente: a.pendiente + f.pendiente,
    }),
    { venta: 0, comision: 0, premios: 0, utilidad: 0, tickets: 0, lineas: 0, pendiente: 0 },
  );

  const conVenta = filas.filter((f) => f.venta > 0);
  const maxVenta = Math.max(1, ...filas.map((f) => f.venta));

  const dias = (serie ?? []).map((d) => ({ fecha: d.r_fecha, venta: Number(d.r_venta) }));
  const maxDia = Math.max(1, ...dias.map((d) => d.venta));

  const porHora = new Array(HORAS).fill(0);
  for (const a of actividad ?? []) {
    const i = Number(a.r_hora) - HORA_INICIAL;
    if (i >= 0 && i < HORAS) porHora[i] += Number(a.r_monto);
  }
  const maxHora = Math.max(1, ...porHora);

  const opciones: OpcionVendedor[] = vendedores.map((v) => ({
    id: v.id,
    codigo: v.codigo,
    nombre: v.nombre,
    zona: v.zona,
    color: v.color,
  }));

  const unSoloDia = desde === hasta;
  const unSoloVendedor = elegidos.length === 1;

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Control de vendedores"
        subtitulo={
          `${fechaLargaSinDia(desde)} → ${fechaLargaSinDia(hasta)}` +
          (elegidos.length
            ? ` · ${elegidos.length} ${elegidos.length === 1 ? "vendedor" : "vendedores"}`
            : " · todo el padrón")
        }
      />

      <div className="flex flex-col gap-[14px]">
        <FiltrosControl
          valores={{ desde, hasta, hora, vendedores: elegidos }}
          vendedores={opciones}
        />

        {total.venta === 0 ? (
          <TarjetaNota>
            No hay ventas en ese rango con esos filtros. Pruebe a ampliar las fechas o a quitar el
            filtro de sorteo.
          </TarjetaNota>
        ) : (
          <>
            <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              {[
                { e: "VENTA", v: fmtK(total.venta), p: `${total.tickets} tickets` },
                {
                  e: "COMISIONES",
                  v: fmtK(total.comision),
                  p: `${((total.comision / total.venta) * 100).toFixed(1)}% de la venta`,
                },
                { e: "PREMIOS PAGADOS", v: fmtK(total.premios), p: "sólo liquidados" },
                {
                  e: "UTILIDAD",
                  v: fmtK(total.utilidad),
                  p: "de sorteos liquidados",
                  color:
                    total.utilidad >= 0 ? "var(--color-positivo)" : "var(--color-negativo)",
                },
                { e: "LÍNEAS", v: String(total.lineas), p: `${conVenta.length} con venta` },
              ].map((k) => (
                <div
                  key={k.e}
                  className="bg-superficie border border-borde rounded-card shadow-card px-[18px] py-[15px]"
                >
                  <span className="block text-eyebrow font-semibold tracking-seccion text-mudo">
                    {k.e}
                  </span>
                  <span
                    className="block text-h1 font-semibold tracking-titular mt-1"
                    style={k.color ? { color: k.color } : undefined}
                  >
                    {k.v}
                  </span>
                  <span className="block text-label text-mudo mt-[3px]">{k.p}</span>
                </div>
              ))}
            </div>

            {total.pendiente > 0 && (
              <TarjetaNota>
                {fmt(total.pendiente)} de venta corresponde a sorteos todavía sin liquidar. No entra
                en premios ni en utilidad: mientras el sorteo no esté liquidado ambas cifras serían
                proyección y no resultado.
              </TarjetaNota>
            )}

            {/* --- Comparación por vendedor, con el NOMBRE al frente --- */}
            <Tarjeta padding="0">
              <div className="px-[22px] py-4 border-b border-fondo">
                <h2 className="text-h2 font-semibold tracking-sutil m-0">Por vendedor</h2>
                <p className="text-meta text-secundario mt-[5px] mb-0">
                  Ordenados por venta del rango. La utilidad es lo que dejó cada uno a la casa
                  después de su comisión y de los premios que causó.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-tabla min-w-[760px]">
                  <thead>
                    <tr className="bg-tinte">
                      {["VENDEDOR", "VENTA", "TICKETS", "COMISIÓN", "PREMIOS", "UTILIDAD"].map(
                        (th, i) => (
                          <th
                            key={th}
                            className={cn(
                              "text-th font-semibold tracking-seccion text-secundario border-b border-riel py-[10px]",
                              i === 0 ? "text-left pl-4 pr-3" : "text-right px-3",
                              i === 5 && "pr-4",
                            )}
                          >
                            {th}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((f) => (
                      <tr key={f.id}>
                        <td className="border-b border-fondo py-[11px] pl-4 pr-3">
                          <div className="flex items-center gap-[10px]">
                            <span
                              className="w-[3px] h-[30px] flex-none rounded-[2px]"
                              style={{ background: f.color }}
                            />
                            <span className="block min-w-0">
                              <span className="block font-medium">{f.nombre}</span>
                              <span className="block text-label text-secundario">
                                {f.codigo} · {f.zona}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          <span className="block font-medium">{fmt(f.venta)}</span>
                          <span className="block mt-[3px] h-[3px] rounded-[2px] bg-chip">
                            <span
                              className="block h-full rounded-[2px]"
                              style={{
                                width: `${(f.venta / maxVenta) * 100}%`,
                                background: f.color,
                              }}
                            />
                          </span>
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right text-secundario">
                          {f.tickets}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {fmt(f.comision)}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {fmt(f.premios)}
                        </td>
                        <td
                          className="border-b border-fondo py-[11px] px-3 pr-4 text-right font-semibold"
                          style={{
                            color:
                              f.utilidad >= 0
                                ? "var(--color-positivo)"
                                : "var(--color-negativo)",
                          }}
                        >
                          {fmt(f.utilidad)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Tarjeta>

            <div className="flex flex-wrap gap-[14px]">
              {/* --- Venta día a día --- */}
              <Tarjeta className="flex-1 min-w-[420px]">
                <h2 className="text-h2 font-semibold tracking-sutil m-0">Venta día a día</h2>
                <p className="text-meta text-secundario mt-[5px] mb-3">
                  {dias.length} {dias.length === 1 ? "día" : "días"}. Los días sin venta se dibujan
                  igual: un hueco también es información.
                </p>
                <div className="flex items-end gap-[3px] h-[130px]">
                  {dias.map((d) => (
                    <span
                      key={d.fecha}
                      title={`${d.fecha} · ${fmt(d.venta)}`}
                      className="flex-1 rounded-[5px_5px_2px_2px] bg-acento"
                      style={{
                        height: `${Math.max(2, (d.venta / maxDia) * 100)}%`,
                        opacity: d.venta === 0 ? 0.15 : 1,
                      }}
                    />
                  ))}
                </div>
                <div className="flex justify-between mt-2">
                  <span className="text-th text-mudo">{fechaLargaSinDia(desde)}</span>
                  <span className="text-th text-mudo">{fechaLargaSinDia(hasta)}</span>
                </div>
              </Tarjeta>

              {/* --- Actividad por hora --- */}
              <Tarjeta className="flex-1 min-w-[420px]">
                <h2 className="text-h2 font-semibold tracking-sutil m-0">Actividad por hora</h2>
                <p className="text-meta text-secundario mt-[5px] mb-3">
                  Hora de Honduras, acumulada de todo el rango.
                </p>
                <div className="flex items-end gap-[4px] h-[130px]">
                  {porHora.map((m, i) => (
                    <span
                      key={i}
                      title={`${pad2(HORA_INICIAL + i)}:00 · ${fmt(m)}`}
                      className={cn(
                        "flex-1 rounded-[5px_5px_2px_2px]",
                        m / maxHora > 0.66 ? "bg-acento" : "bg-barra-baja",
                      )}
                      style={{ height: `${Math.max(2, (m / maxHora) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between mt-2">
                  <span className="text-th text-mudo">{pad2(HORA_INICIAL)}:00</span>
                  <span className="text-th text-mudo">{pad2(HORA_INICIAL + HORAS - 1)}:00</span>
                </div>
              </Tarjeta>
            </div>

            {/* --- Bitácora: sólo con un vendedor elegido --- */}
            {unSoloVendedor ? (
              <Bitacora
                vendedorId={elegidos[0]}
                nombre={filas.find((f) => f.id === elegidos[0])?.nombre ?? ""}
                desde={desde}
                hasta={hasta}
                hora={hora}
                unSoloDia={unSoloDia}
              />
            ) : (
              <TarjetaNota>
                La bitácora línea por línea aparece al elegir un solo vendedor. Con varios a la vez
                serían decenas de miles de líneas, y esa lista no se lee: se filtra.
              </TarjetaNota>
            )}
          </>
        )}
      </div>
    </Pagina>
  );
}

/**
 * La única vista del sistema que baja a la línea individual: hora exacta,
 * número, monto y punto de venta.
 */
async function Bitacora({
  vendedorId,
  nombre,
  desde,
  hasta,
  hora,
  unSoloDia,
}: {
  vendedorId: string;
  nombre: string;
  desde: string;
  hasta: string;
  hora: string;
  unSoloDia: boolean;
}) {
  const supabase = await crearClienteServidor();

  const { data } = await supabase.rpc("fn_bitacora_rango", {
    p_vendedor_id: vendedorId,
    p_desde: desde,
    p_hasta: hasta,
    p_hora: (hora || null) as never,
    p_limite: 300,
  });

  const lineas = data ?? [];

  if (lineas.length === 0) {
    return <TarjetaNota>{nombre} no registró líneas en ese rango.</TarjetaNota>;
  }

  return (
    <Tarjeta padding="0">
      <div className="px-[22px] py-4 border-b border-fondo">
        <h2 className="text-h2 font-semibold tracking-sutil m-0">Bitácora de {nombre}</h2>
        <p className="text-meta text-secundario mt-[5px] mb-0">
          Línea por línea, de la más reciente hacia atrás. Máximo 300; para ver más, acote el
          rango.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-tabla min-w-[720px]">
          <thead>
            <tr className="bg-tinte">
              {[
                ...(unSoloDia ? [] : ["FECHA"]),
                "HORA",
                "SORTEO",
                "FOLIO",
                "NÚMERO",
                "MONTO",
                "PREMIO",
              ].map((th, i) => (
                <th
                  key={th}
                  className={cn(
                    "text-th font-semibold tracking-seccion text-secundario border-b border-riel py-[10px]",
                    i === 0 ? "text-left pl-4 pr-3" : "px-3",
                    th === "MONTO" || th === "PREMIO" || th === "NÚMERO"
                      ? "text-right"
                      : "text-left",
                  )}
                >
                  {th}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lineas.map((l, i) => (
              <tr
                key={`${l.r_folio}-${l.r_numero}-${i}`}
                className={cn(l.r_gana && "bg-ambar-fila-ganadora")}
              >
                {!unSoloDia && (
                  <td className="border-b border-fondo py-[10px] pl-4 pr-3 text-secundario">
                    {l.r_fecha}
                  </td>
                )}
                <td
                  className={cn(
                    "border-b border-fondo py-[10px] px-3 text-secundario",
                    unSoloDia && "pl-4",
                  )}
                >
                  {horaHonduras12(l.r_creado_en)}
                </td>
                <td className="border-b border-fondo py-[10px] px-3 text-secundario">
                  {hora12(l.r_hora)}
                </td>
                <td className="border-b border-fondo py-[10px] px-3 text-label">{l.r_folio}</td>
                <td className="border-b border-fondo py-[10px] px-3 text-right font-medium">
                  {pad2(l.r_numero)}
                </td>
                <td className="border-b border-fondo py-[10px] px-3 text-right">
                  {fmt(Number(l.r_monto))}
                </td>
                <td className="border-b border-fondo py-[10px] px-3 pr-4 text-right">
                  {l.r_gana ? (
                    <span className="font-semibold text-ambar-ganador-texto">
                      {fmt(Number(l.r_premio))}
                    </span>
                  ) : l.r_estado === "liquidado" ? (
                    "—"
                  ) : (
                    <span className="text-mudo">pendiente</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Tarjeta>
  );
}
