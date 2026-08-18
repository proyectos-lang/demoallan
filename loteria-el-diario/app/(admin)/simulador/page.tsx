import { ControlesSimulador } from "@/components/simulador/controles";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaHonduras, fechaLargaSinDia, fmtK } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

/** Diferencias por debajo de esto se pintan neutras: es ruido de redondeo. */
const UMBRAL_NEUTRO = 0.5;

function colorDelta(dif: number, sobreOscuro = false) {
  if (Math.abs(dif) < UMBRAL_NEUTRO) {
    return sobreOscuro ? "var(--color-navy-suave)" : "var(--color-tinta)";
  }
  if (dif > 0) return sobreOscuro ? "var(--color-positivo-claro)" : "var(--color-positivo)";
  return sobreOscuro ? "var(--color-negativo-suave)" : "var(--color-negativo)";
}

export default async function SimuladorPage(props: PageProps<"/simulador">) {
  const params = await props.searchParams;
  const supabase = await crearClienteServidor();

  // Rango por defecto: todo el histórico liquidado.
  const { data: extremos } = await supabase
    .from("sorteo")
    .select("fecha")
    .eq("estado", "liquidado")
    .order("fecha")
    .limit(1);
  const { data: extremosFin } = await supabase
    .from("sorteo")
    .select("fecha")
    .eq("estado", "liquidado")
    .order("fecha", { ascending: false })
    .limit(1);

  if (!extremos?.length) {
    return (
      <Pagina>
        <EncabezadoPagina
          titulo="Simulador"
          subtitulo="Recálculo del histórico con comisión y factor alternos."
        />
        <TarjetaNota>
          Todavía no hay sorteos liquidados que recalcular. El simulador trabaja sobre apuestas
          reales ya resueltas: sin número ganador no hay premio que volver a calcular con otro
          factor.
        </TarjetaNota>
      </Pagina>
    );
  }

  const desde = (typeof params.desde === "string" && params.desde) || extremos[0].fecha;
  const hasta =
    (typeof params.hasta === "string" && params.hasta) ||
    extremosFin?.[0]?.fecha ||
    fechaHonduras();

  const { data: ponderados } = await supabase.rpc("fn_parametros_ponderados", {
    p_desde: desde,
    p_hasta: hasta,
  });

  const reales = {
    // La base guarda fracción; la interfaz trabaja en porcentaje.
    comision: Number(((ponderados?.[0]?.comision_ponderada ?? 0) * 100).toFixed(2)),
    factor: Number(Number(ponderados?.[0]?.factor_ponderado ?? 70).toFixed(2)),
  };

  // Por defecto el escenario arranca igual al real, para que cualquier
  // diferencia que aparezca después sea consecuencia de lo que el usuario movió.
  //
  // Cuando no hay parámetro explícito se simula con el valor ponderado EXACTO,
  // no con el que se muestra: `reales` va redondeado a dos decimales para que
  // se pueda leer, y simular con ese redondeo hacía aparecer una diferencia de
  // un par de lempiras que el usuario no había pedido.
  const comisionParam = typeof params.comision === "string" ? Number(params.comision) : null;
  const factorParam = typeof params.factor === "string" ? Number(params.factor) : null;

  const comision = comisionParam ?? reales.comision;
  const factor = factorParam ?? reales.factor;

  const { data: meses } = await supabase.rpc("fn_simular", {
    p_desde: desde,
    p_hasta: hasta,
    p_comision:
      comisionParam !== null
        ? comisionParam / 100
        : Number(ponderados?.[0]?.comision_ponderada ?? 0),
    p_factor: factorParam ?? Number(ponderados?.[0]?.factor_ponderado ?? 70),
  });

  const filas = meses ?? [];
  const total = filas.reduce(
    (a, m) => ({
      venta: a.venta + Number(m.venta),
      comisionReal: a.comisionReal + Number(m.comision_real),
      premiosReal: a.premiosReal + Number(m.premios_real),
      utilidadReal: a.utilidadReal + Number(m.utilidad_real),
      comisionSim: a.comisionSim + Number(m.comision_sim),
      premiosSim: a.premiosSim + Number(m.premios_sim),
      utilidadSim: a.utilidadSim + Number(m.utilidad_sim),
    }),
    { venta: 0, comisionReal: 0, premiosReal: 0, utilidadReal: 0, comisionSim: 0, premiosSim: 0, utilidadSim: 0 },
  );

  const difUtilidad = total.utilidadSim - total.utilidadReal;
  const margenReal = total.venta ? (total.utilidadReal / total.venta) * 100 : 0;
  const margenSim = total.venta ? (total.utilidadSim / total.venta) * 100 : 0;

  const mosaicos: { metrica: string; real: number; sim: number; pp?: boolean }[] = [
    { metrica: "Venta bruta", real: total.venta, sim: total.venta },
    { metrica: "Comisiones", real: total.comisionReal, sim: total.comisionSim },
    { metrica: "Premios", real: total.premiosReal, sim: total.premiosSim },
    { metrica: "Utilidad neta", real: total.utilidadReal, sim: total.utilidadSim },
    { metrica: "Margen", real: margenReal, sim: margenSim, pp: true },
  ];

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Simulador"
        subtitulo="Recálculo del histórico con comisión y factor alternos, mes por mes."
      />

      <div className="flex flex-col gap-[14px]">
        <ControlesSimulador
          valores={{ desde, hasta, comision, factor }}
          reales={reales}
        />

        {filas.length === 0 ? (
          <TarjetaNota>El rango elegido no tiene sorteos liquidados.</TarjetaNota>
        ) : (
          <>
            {/* --- Héroe --- */}
            <div
              className="rounded-hero px-[22px] py-5 text-white"
              style={{ background: "var(--gradiente-sim)" }}
            >
              <div className="flex justify-between items-start flex-wrap gap-4">
                <div>
                  <span className="block text-th font-semibold tracking-seccion text-navy-tenue">
                    TOTAL DEL RANGO
                  </span>
                  <span className="block text-modal font-semibold mt-1">
                    {fechaLargaSinDia(desde)} → {fechaLargaSinDia(hasta)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="block text-label text-navy-tenue">Diferencia en utilidad</span>
                  <span
                    className="block text-sim font-semibold"
                    style={{ color: colorDelta(difUtilidad, true) }}
                  >
                    {difUtilidad > 0 ? "+" : ""}
                    {fmtK(difUtilidad)}
                  </span>
                  <span className="block text-micro text-navy-tenue">
                    {total.utilidadReal
                      ? `${((difUtilidad / Math.abs(total.utilidadReal)) * 100).toFixed(1)}%`
                      : "—"}{" "}
                    sobre la utilidad real
                  </span>
                </div>
              </div>

              <div className="grid gap-3 mt-5 [grid-template-columns:repeat(auto-fit,minmax(168px,1fr))]">
                {mosaicos.map((m) => {
                  const dif = m.sim - m.real;
                  const sinCambio = Math.abs(dif) < UMBRAL_NEUTRO;
                  return (
                    <div
                      key={m.metrica}
                      className="rounded-pos px-[15px] py-[13px]"
                      style={{
                        background: "rgba(255,255,255,.10)",
                        border: "1px solid rgba(255,255,255,.16)",
                      }}
                    >
                      <span className="block text-label text-navy-suave">{m.metrica}</span>
                      <span className="block text-exito font-semibold mt-1">
                        {m.pp ? `${m.sim.toFixed(1)}%` : fmtK(m.sim)}
                      </span>
                      <span className="block text-label text-navy-tenue">
                        real {m.pp ? `${m.real.toFixed(1)}%` : fmtK(m.real)}
                      </span>
                      <span
                        className="block text-micro font-semibold mt-1"
                        style={{ color: colorDelta(dif, true) }}
                      >
                        {sinCambio
                          ? "sin cambio"
                          : `${dif > 0 ? "+" : ""}${m.pp ? `${dif.toFixed(1)} pp` : fmtK(dif)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <TarjetaNota>
              El escenario supone que <strong className="font-semibold">el volumen de venta no
              cambia</strong>: son las mismas apuestas con otros parámetros. Es una referencia
              cuantitativa, no un pronóstico — en la práctica, cambiar la comisión cambia el
              comportamiento de los vendedores y cambiar el factor el de los apostadores.
            </TarjetaNota>

            <h2 className="text-h2 font-semibold tracking-sutil mt-2 mb-0">Mes por mes</h2>

            <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(298px,1fr))]">
              {filas.map((m) => {
                const difMes = Number(m.utilidad_sim) - Number(m.utilidad_real);
                const comparaciones: [string, number, number, boolean][] = [
                  ["Venta bruta", Number(m.venta), Number(m.venta), false],
                  ["Comisiones", Number(m.comision_real), Number(m.comision_sim), false],
                  ["Premios", Number(m.premios_real), Number(m.premios_sim), false],
                  ["Utilidad neta", Number(m.utilidad_real), Number(m.utilidad_sim), false],
                  [
                    "Margen",
                    Number(m.venta) ? (Number(m.utilidad_real) / Number(m.venta)) * 100 : 0,
                    Number(m.venta) ? (Number(m.utilidad_sim) / Number(m.venta)) * 100 : 0,
                    true,
                  ],
                ];

                return (
                  <Tarjeta key={`${m.anio}-${m.mes}`} padding="16px 18px">
                    <div className="flex justify-between items-baseline border-b border-riel pb-3">
                      <span className="text-cta font-semibold tracking-sutil">
                        {MESES[Number(m.mes)]} {m.anio}
                      </span>
                      <span className="text-micro text-secundario">
                        {m.dias} {Number(m.dias) === 1 ? "día" : "días"}
                      </span>
                    </div>

                    <div className="grid [grid-template-columns:1fr_auto_auto] gap-x-3 gap-y-[7px] mt-3">
                      <span />
                      <span className="text-eyebrow font-semibold tracking-th text-mudo text-right">
                        REAL
                      </span>
                      <span className="text-eyebrow font-semibold tracking-th text-mudo text-right">
                        SIMULADO
                      </span>

                      {comparaciones.map(([etiqueta, real, sim, pp]) => (
                        <Fragmento
                          key={etiqueta}
                          etiqueta={etiqueta}
                          real={real}
                          sim={sim}
                          pp={pp}
                        />
                      ))}
                    </div>

                    <div className="flex justify-between border-t border-riel mt-3 pt-3">
                      <span className="text-tabla text-secundario">Diferencia</span>
                      <strong
                        className="text-card font-semibold"
                        style={{ color: colorDelta(difMes) }}
                      >
                        {Math.abs(difMes) < UMBRAL_NEUTRO
                          ? "sin cambio"
                          : `${difMes > 0 ? "+" : ""}${fmtK(difMes)}`}
                      </strong>
                    </div>
                  </Tarjeta>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Pagina>
  );
}

function Fragmento({
  etiqueta,
  real,
  sim,
  pp,
}: {
  etiqueta: string;
  real: number;
  sim: number;
  pp: boolean;
}) {
  const dif = sim - real;
  return (
    <>
      <span className="text-meta text-cuerpo">{etiqueta}</span>
      <span className="text-meta text-secundario text-right">
        {pp ? `${real.toFixed(1)}%` : fmtK(real)}
      </span>
      <span
        className={cn("text-tabla font-semibold text-right")}
        style={{ color: colorDelta(dif) }}
      >
        {pp ? `${sim.toFixed(1)}%` : fmtK(sim)}
      </span>
    </>
  );
}
