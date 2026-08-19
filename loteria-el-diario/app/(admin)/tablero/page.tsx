import Link from "next/link";

import { GraficoMensual } from "@/components/tablero/grafico-mensual";
import { BarraVendedor, TarjetaKpi } from "@/components/tablero/piezas";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaHonduras, fechaLargaSinDia, fmt, fmtK, iso, mesNombre, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const ETIQUETA_ESTADO: Record<string, string> = {
  abierto: "en venta",
  cerrado: "cerrado · pendiente de captura",
  liquidado: "liquidado",
  programado: "programado",
};

export default async function TableroPage(props: PageProps<"/tablero">) {
  const params = await props.searchParams;
  const tab = params.tab === "dia" ? "dia" : "general";
  const supabase = await crearClienteServidor();

  // Rango del histórico: desde el primer sorteo registrado hasta el último. Las
  // dos consultas son independientes, así que van a la vez: encadenarlas con
  // await sumaba dos viajes de red antes de poder empezar nada.
  const [{ data: extremos }, { data: extremosFin }] = await Promise.all([
    supabase.from("sorteo").select("fecha").order("fecha").limit(1),
    supabase.from("sorteo").select("fecha").order("fecha", { ascending: false }).limit(1),
  ]);

  const desde = extremos?.[0]?.fecha ?? fechaHonduras();
  const hasta = extremosFin?.[0]?.fecha ?? fechaHonduras();
  const fechaDia = typeof params.fecha === "string" ? params.fecha : hasta;

  const subtitulo =
    tab === "general"
      ? `${fechaLargaSinDia(desde)} — ${fechaLargaSinDia(hasta)}`
      : "Indicadores de un día, sorteo por sorteo";

  const tabs = (
    <div className="flex gap-[6px] bg-riel rounded-boton p-1">
      {[
        { id: "general", etiqueta: "Resumen general" },
        { id: "dia", etiqueta: "Resumen del día" },
      ].map((t) => (
        <Link
          key={t.id}
          href={t.id === "general" ? "/tablero" : `/tablero?tab=dia&fecha=${fechaDia}`}
          className={cn(
            "rounded-celda px-[15px] py-2 text-tabla font-medium",
            tab === t.id ? "bg-superficie text-tinta shadow-tab" : "text-secundario",
          )}
        >
          {t.etiqueta}
        </Link>
      ))}
    </div>
  );

  return (
    <Pagina>
      <EncabezadoPagina titulo="Tablero de control" subtitulo={subtitulo} acciones={tabs} />
      {tab === "general" ? (
        <ResumenGeneral desde={desde} hasta={hasta} />
      ) : (
        <ResumenDia fecha={fechaDia} />
      )}
    </Pagina>
  );
}

/* ------------------------------------------------------------------ general */

async function ResumenGeneral({ desde, hasta }: { desde: string; hasta: string }) {
  const supabase = await crearClienteServidor();

  const [{ data: totalRows }, { data: mensual }, { data: porVendedor }] = await Promise.all([
    supabase.rpc("fn_resumen_periodo", { p_desde: desde, p_hasta: hasta }),
    supabase.rpc("fn_resumen_mensual", { p_desde: desde, p_hasta: hasta }),
    supabase.rpc("fn_resumen_vendedor", { p_desde: desde, p_hasta: hasta }),
  ]);

  const t = totalRows?.[0];
  if (!t || Number(t.venta) === 0) {
    return (
      <TarjetaNota>
        Todavía no hay ventas registradas. El tablero se llena solo en cuanto empiecen a entrar
        tickets: cada indicador de aquí es una agregación de líneas, no un total capturado.
      </TarjetaNota>
    );
  }

  const venta = Number(t.venta);
  const comision = Number(t.comision);
  const premios = Number(t.premios);
  const utilidad = Number(t.utilidad);
  const ventaLiquidada = Number(t.venta_liquidada);
  const ventaPendiente = Number(t.venta_pendiente);
  const margen = ventaLiquidada > 0 ? (utilidad / ventaLiquidada) * 100 : 0;

  const meses = (mensual ?? [])
    .filter((m) => Number(m.utilidad) !== 0 || Number(m.venta) !== 0)
    .map((m) => ({ mes: Number(m.mes), utilidad: Number(m.utilidad) }));

  const vendedores = (porVendedor ?? []).map((v) => ({
    ...v,
    venta: Number(v.venta),
    utilidad: Number(v.utilidad),
  }));
  const maxVenta = Math.max(1, ...vendedores.map((v) => v.venta));
  const maxUtil = Math.max(1, ...vendedores.map((v) => Math.abs(v.utilidad)));
  const mejorMes = meses.reduce((a, b) => (b.utilidad > a.utilidad ? b : a), meses[0]);

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid gap-[26px] [grid-template-columns:repeat(auto-fit,minmax(216px,1fr))]">
        <TarjetaKpi
          etiqueta="Venta bruta"
          valor={fmtK(venta)}
          pie={`${t.tickets} tickets`}
          punto="var(--color-acento)"
        />
        <TarjetaKpi
          etiqueta="Comisiones"
          valor={fmtK(comision)}
          pie={`${((comision / venta) * 100).toFixed(1)}% de la venta`}
          punto="var(--color-v2)"
          operador="−"
        />
        <TarjetaKpi
          etiqueta="Premios pagados"
          valor={fmtK(premios)}
          pie={
            ventaLiquidada > 0
              ? `${((premios / ventaLiquidada) * 100).toFixed(1)}% de la venta liquidada`
              : "sin sorteos liquidados"
          }
          punto="var(--color-negativo)"
          operador="−"
        />
        <TarjetaKpi
          etiqueta="Utilidad neta"
          valor={fmtK(utilidad)}
          pie={`margen ${margen.toFixed(1)}%`}
          punto="var(--color-positivo-punto)"
          operador="="
          oscura
        />
      </div>

      {ventaPendiente > 0 && (
        <TarjetaNota>
          {fmt(ventaPendiente)} vendidos en {t.sorteos_pendientes}{" "}
          {t.sorteos_pendientes === 1 ? "sorteo" : "sorteos"} sin liquidar. Esa venta no entra en
          premios ni en utilidad: mientras el sorteo no esté liquidado, ambas cifras serían
          proyección y no resultado.
        </TarjetaNota>
      )}

      <Tarjeta padding="20px 22px 16px">
        <div className="flex justify-between items-start flex-wrap gap-3">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">Utilidad mes por mes</h2>
            <p className="text-meta text-secundario mt-[5px] mb-0">
              Sólo sorteos liquidados. Cada punto es venta menos comisiones menos premios.
            </p>
          </div>
          {mejorMes && (
            <span className="text-meta text-secundario">
              mejor mes {mesNombre(mejorMes.mes)} · {fmtK(mejorMes.utilidad)}
            </span>
          )}
        </div>
        <div className="mt-4">
          <GraficoMensual meses={meses} />
        </div>
      </Tarjeta>

      <div className="flex flex-wrap gap-[18px]">
        <Tarjeta className="flex-1 min-w-[380px]">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">Ventas por vendedor</h2>
          <div className="flex flex-col gap-[14px] mt-4">
            {vendedores.map((v) => (
              <BarraVendedor
                key={v.vendedor_id}
                nombre={v.nombre}
                valor={v.venta}
                maximo={maxVenta}
                color={v.color}
              />
            ))}
          </div>
        </Tarjeta>

        <Tarjeta className="flex-1 min-w-[380px]">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">Utilidad por vendedor</h2>
          <p className="text-meta text-secundario mt-[5px] mb-0">
            Venta menos comisión menos premios pagados.
          </p>
          <div className="flex flex-col gap-[14px] mt-4">
            {[...vendedores]
              .sort((a, b) => b.utilidad - a.utilidad)
              .map((v) => (
                <BarraVendedor
                  key={v.vendedor_id}
                  nombre={v.nombre}
                  valor={v.utilidad}
                  maximo={maxUtil}
                  color={v.color}
                  negativo={v.utilidad < 0}
                  detalle={
                    v.venta > 0 ? `margen ${((v.utilidad / v.venta) * 100).toFixed(1)}%` : undefined
                  }
                />
              ))}
          </div>
        </Tarjeta>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- día */

async function ResumenDia({ fecha }: { fecha: string }) {
  const supabase = await crearClienteServidor();

  const [{ data: sorteos }, { data: desglose }] = await Promise.all([
    supabase.rpc("fn_resumen_dia", { p_fecha: fecha }),
    supabase.rpc("fn_desglose_dia", { p_fecha: fecha }),
  ]);

  const filas = sorteos ?? [];
  const liquidados = filas.filter((s) => s.estado === "liquidado");

  const total = {
    venta: filas.reduce((a, s) => a + Number(s.venta), 0),
    comision: filas.reduce((a, s) => a + Number(s.comision), 0),
    premios: liquidados.reduce((a, s) => a + Number(s.premios), 0),
    utilidad: liquidados.reduce((a, s) => a + Number(s.utilidad), 0),
    ventaLiquidada: liquidados.reduce((a, s) => a + Number(s.venta), 0),
  };

  const dia = new Date(`${fecha}T12:00:00`);
  const anterior = iso(new Date(dia.getTime() - 86_400_000));
  const siguiente = iso(new Date(dia.getTime() + 86_400_000));

  return (
    <div className="flex flex-col gap-[14px]">
      <Tarjeta padding="14px 18px">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-label text-secundario font-medium">Día</span>
          <div className="flex items-center gap-2">
            <Link
              href={`/tablero?tab=dia&fecha=${anterior}`}
              className="w-[34px] h-[34px] flex items-center justify-center border border-borde-campo rounded-campo text-cuerpo text-h2 hover:bg-panel"
              aria-label="Día anterior"
            >
              ‹
            </Link>
            <span className="text-base font-medium">{fechaLargaSinDia(fecha)}</span>
            <Link
              href={`/tablero?tab=dia&fecha=${siguiente}`}
              className="w-[34px] h-[34px] flex items-center justify-center border border-borde-campo rounded-campo text-cuerpo text-h2 hover:bg-panel"
              aria-label="Día siguiente"
            >
              ›
            </Link>
          </div>
        </div>
      </Tarjeta>

      {filas.length === 0 ? (
        <TarjetaNota>No hay sorteos programados para este día.</TarjetaNota>
      ) : (
        <>
          <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(252px,1fr))]">
            {filas.map((s) => {
              const liq = s.estado === "liquidado";
              return (
                <Tarjeta key={s.sorteo_id} padding="16px 18px">
                  <div className="flex items-start justify-between">
                    <span className="block">
                      <span className="block text-h2 font-semibold tracking-sutil">{s.hora}</span>
                      <span className="block text-label text-secundario mt-[2px]">
                        {ETIQUETA_ESTADO[s.estado]}
                      </span>
                    </span>
                    <span className="block text-right">
                      <span className="block text-th font-semibold tracking-th text-secundario">
                        GANADOR
                      </span>
                      <span
                        className="block text-ganador font-semibold tracking-titular"
                        style={{ color: liq ? "var(--color-navy)" : "var(--color-mudo)" }}
                      >
                        {liq && s.numero_ganador !== null ? pad2(s.numero_ganador) : "—"}
                      </span>
                    </span>
                  </div>

                  <div className="flex flex-col gap-[9px] mt-4">
                    {[
                      ["Venta", fmt(Number(s.venta))],
                      ["Comisión", fmt(Number(s.comision))],
                      ["Premios", liq ? fmt(Number(s.premios)) : "pendiente"],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-tabla">
                        <span className="text-secundario">{k}</span>
                        <strong className="font-semibold">{v}</strong>
                      </div>
                    ))}
                    <div className="flex justify-between text-tabla border-t border-riel pt-[9px]">
                      <span className="text-secundario">Utilidad</span>
                      <strong
                        className="font-semibold"
                        style={{
                          color: !liq
                            ? "var(--color-tinta)"
                            : Number(s.utilidad) < 0
                              ? "var(--color-negativo)"
                              : "var(--color-positivo)",
                        }}
                      >
                        {liq ? fmt(Number(s.utilidad)) : "—"}
                      </strong>
                    </div>
                    <span className="text-label text-mudo">
                      {liq
                        ? `margen ${Number(s.venta) > 0 ? ((Number(s.utilidad) / Number(s.venta)) * 100).toFixed(1) : "0.0"}% · ${s.tickets} tickets`
                        : `proyectado, sin premios · ${s.tickets} tickets`}
                    </span>
                  </div>
                </Tarjeta>
              );
            })}

            <div
              className="rounded-card px-[18px] py-4 text-white"
              style={{ background: "var(--gradiente-dia)" }}
            >
              <span className="block text-h2 font-semibold tracking-sutil">Total del día</span>
              <span className="block text-label text-navy-fila mt-[2px]">
                {liquidados.length === filas.length
                  ? "día cerrado y liquidado por completo"
                  : `${liquidados.length} de ${filas.length} sorteos liquidados`}
              </span>
              <div className="flex flex-col gap-[9px] mt-4">
                {[
                  ["Venta", fmt(total.venta)],
                  ["Comisión", fmt(total.comision)],
                  ["Premios", liquidados.length ? fmt(total.premios) : "pendiente"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between text-tabla">
                    <span className="text-navy-fila">{k}</span>
                    <strong className="font-semibold">{v}</strong>
                  </div>
                ))}
                <div
                  className="flex justify-between text-card pt-[9px]"
                  style={{ borderTop: "1px solid rgba(255,255,255,.14)" }}
                >
                  <span className="text-navy-fila">Utilidad</span>
                  <strong
                    className="font-semibold"
                    style={{
                      color:
                        total.utilidad < 0
                          ? "var(--color-negativo-claro)"
                          : "var(--color-positivo-claro)",
                    }}
                  >
                    {liquidados.length ? fmt(total.utilidad) : "—"}
                  </strong>
                </div>
                <span className="text-label text-navy-nota">
                  {liquidados.length
                    ? `sobre ${fmt(total.ventaLiquidada)} de venta liquidada`
                    : "sin sorteos liquidados todavía"}
                </span>
              </div>
            </div>
          </div>

          <Tarjeta padding="0" className="overflow-hidden">
            <div className="px-[18px] py-4">
              <h2 className="text-h2 font-semibold tracking-sutil m-0">
                Desglose por vendedor y sorteo
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[720px]">
                <thead>
                  <tr className="bg-tinte">
                    {["VENDEDOR", "SORTEO", "VENTAS", "COMISIÓN", "PREMIOS", "UTILIDAD"].map(
                      (th, i) => (
                        <th
                          key={th}
                          className={cn(
                            "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                            i >= 2 ? "text-right" : "text-left",
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
                  {(desglose ?? []).map((d, i) => {
                    const liq = d.estado === "liquidado";
                    return (
                      <tr key={i}>
                        <td className="border-b border-fondo py-[11px] pl-4 pr-3 font-medium">
                          {d.nombre}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-secundario">
                          {d.hora}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {fmt(Number(d.venta), false)}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {fmt(Number(d.comision), false)}
                        </td>
                        <td className="border-b border-fondo py-[11px] px-3 text-right">
                          {liq ? fmt(Number(d.premios), false) : "pendiente"}
                        </td>
                        <td
                          className="border-b border-fondo py-[11px] pl-3 pr-4 text-right"
                          style={{
                            color: !liq
                              ? "var(--color-secundario)"
                              : Number(d.utilidad) < 0
                                ? "var(--color-negativo)"
                                : "var(--color-positivo)",
                          }}
                        >
                          {/* El asterisco marca una utilidad que todavía es proyección. */}
                          {fmt(Number(d.utilidad), false)}
                          {liq ? "" : " *"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(desglose ?? []).some((d) => d.estado !== "liquidado") && (
              <div className="px-4 py-[13px] bg-tinte border-t border-riel text-meta text-secundario">
                * La utilidad de un sorteo sin liquidar es proyección: no incluye premios porque
                todavía no hay número ganador.
              </div>
            )}
          </Tarjeta>
        </>
      )}
    </div>
  );
}
