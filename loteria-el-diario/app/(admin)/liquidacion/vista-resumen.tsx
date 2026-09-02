import {
  FiltrosLiquidacion,
  type OpcionVendedorLiq,
} from "@/components/liquidacion/filtros-liquidacion";
import { Kpi } from "@/components/informe/kpi";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Cómo va el cobro, semana a semana.
 *
 * Misma forma que el detalle por semana del análisis financiero —una fila por
 * semana, de la más vieja a la más nueva— pero con las columnas del cobro:
 * cuánto había, cuánto se cobró y cuánto falta. Sin vendedor es el negocio
 * entero; con vendedor, lo suyo.
 *
 * La fila se pinta según lo que FALTA, no según el saldo: una semana con saldo
 * grande ya cobrada no es una noticia, y una de cien lempiras sin cobrar de
 * hace dos meses sí.
 */
export async function VistaResumen({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const pedido = typeof params.vendedor === "string" ? params.vendedor : "";

  const { data: crudos } = await supabase.rpc("fn_vendedores_liquidables");

  const vendedores: OpcionVendedorLiq[] = (crudos ?? []).map((v) => ({
    id: v.r_vendedor_id,
    codigo: v.r_codigo,
    nombre: v.r_nombre,
    activo: v.r_activo,
    eliminado: v.r_eliminado,
    pendientes: Number(v.r_pendientes),
  }));

  // El padrón va primero y la consulta después: un id inventado en la
  // dirección no debe llegar a la base.
  const vendedor = vendedores.find((v) => v.id === pedido) ?? null;

  const { data, error } = await supabase.rpc("fn_liquidacion_por_semana", {
    p_vendedor_id: vendedor?.id ?? null,
  });

  // De la más vieja a la más nueva: una serie se lee hacia adelante, aunque el
  // riel de la hoja las ordene al revés.
  const semanas = [...(data ?? [])].reverse().map((s) => ({
    inicio: s.r_inicio,
    fin: s.r_fin,
    semana: s.r_semana,
    sorteos: s.r_sorteos,
    pagadas: s.r_pagadas,
    pendientes: s.r_pendientes,
    venta: Number(s.r_venta),
    comision: Number(s.r_comision),
    premios: Number(s.r_premios),
    saldo: Number(s.r_saldo),
    pagado: Number(s.r_pagado),
    pendiente: Number(s.r_pendiente),
  }));

  const total = semanas.reduce(
    (a, s) => ({
      venta: a.venta + s.venta,
      comision: a.comision + s.comision,
      premios: a.premios + s.premios,
      saldo: a.saldo + s.saldo,
      pagado: a.pagado + s.pagado,
      pendiente: a.pendiente + s.pendiente,
    }),
    { venta: 0, comision: 0, premios: 0, saldo: 0, pagado: 0, pendiente: 0 },
  );

  const semanasAbiertas = semanas.filter((s) => s.pendientes > 0).length;

  return (
    <>
      <FiltrosLiquidacion
        vendedores={vendedores}
        vendedorId={vendedor?.id ?? ""}
        vista="resumen"
      />

      {error ? (
        <TarjetaNota>No se pudo cargar el resumen: {error.message}</TarjetaNota>
      ) : semanas.length === 0 ? (
        <TarjetaNota>
          {vendedor
            ? `${vendedor.nombre} no tiene ninguna semana liquidada todavía.`
            : "Todavía no hay ninguna semana liquidada."}
        </TarjetaNota>
      ) : (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <Kpi
              etiqueta="VALOR A LIQUIDAR"
              valor={fmt(total.saldo)}
              pie={`${semanas.length} ${semanas.length === 1 ? "semana" : "semanas"}${vendedor ? "" : " · todo el padrón"}`}
            />
            <Kpi
              etiqueta="VALOR PAGADO"
              valor={fmt(total.pagado)}
              pie={
                total.saldo
                  ? `${((total.pagado / total.saldo) * 100).toFixed(1)} % de lo liquidado`
                  : "—"
              }
            />
            <Kpi
              etiqueta="VALOR PENDIENTE"
              valor={fmt(total.pendiente)}
              color={total.pendiente < 0 ? "text-negativo" : undefined}
              pie={
                semanasAbiertas === 0
                  ? "no queda nada por cobrar"
                  : `en ${semanasAbiertas} ${semanasAbiertas === 1 ? "semana" : "semanas"}`
              }
            />
          </div>

          <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[900px]">
                <thead>
                  <tr className="bg-tinte">
                    {[
                      "SEMANA",
                      "SORTEOS",
                      "VENTA",
                      "COMISIÓN",
                      "PREMIOS",
                      "A LIQUIDAR",
                      "PAGADO",
                      "PENDIENTE",
                    ].map((th, i) => (
                      <th
                        key={th}
                        className={cn(
                          "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                          i === 0 ? "text-left pl-4 pr-3" : "text-right",
                          i === 7 ? "pl-3 pr-4" : i > 0 ? "px-3" : "",
                          // El filete separa lo que se debía de cómo va el cobro.
                          th === "PAGADO" && "border-l border-riel",
                        )}
                      >
                        {th}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {semanas.map((s) => {
                    const cerrada = s.pendientes === 0;
                    return (
                      <tr
                        key={s.inicio}
                        className={cn("hover:bg-tinte", cerrada && "text-mudo")}
                      >
                        <td className="pl-4 pr-3 py-[8px] border-b border-fondo">
                          <span className="font-medium">Semana #{s.semana}</span>
                          <span className="text-th text-mudo ml-2">
                            {fechaLargaSinDia(s.inicio)} — {fechaLargaSinDia(s.fin)}
                          </span>
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo text-right text-cuerpo">
                          {s.sorteos}
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo text-right">
                          {fmt(s.venta, false)}
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo text-right text-cuerpo">
                          {fmt(s.comision, false)}
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo text-right text-cuerpo">
                          {fmt(s.premios, false)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-[8px] border-b border-fondo text-right font-semibold",
                            s.saldo < 0 && !cerrada && "text-negativo",
                          )}
                        >
                          {fmt(s.saldo, false)}
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo border-l border-riel text-right text-cuerpo">
                          {s.pagado === 0 ? "—" : fmt(s.pagado, false)}
                        </td>
                        {/*
                          La única columna con estado: verde cuando la semana ya
                          se cerró, roja cuando lo que falta lo pone la casa.
                        */}
                        <td
                          className={cn(
                            "pl-3 pr-4 py-[8px] border-b border-fondo text-right font-semibold",
                            cerrada
                              ? "text-positivo"
                              : s.pendiente < 0
                                ? "text-negativo"
                                : "text-tinta",
                          )}
                        >
                          {cerrada ? "pagada" : fmt(s.pendiente, false)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                <tfoot>
                  <tr className="bg-tinte">
                    <td className="pl-4 pr-3 py-[10px] text-th font-semibold tracking-subtotal text-secundario">
                      TOTALES · {semanas.length} {semanas.length === 1 ? "semana" : "semanas"}
                    </td>
                    <td />
                    <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                      {fmt(total.venta, false)}
                    </td>
                    <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                      {fmt(total.comision, false)}
                    </td>
                    <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                      {fmt(total.premios, false)}
                    </td>
                    <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                      {fmt(total.saldo, false)}
                    </td>
                    <td className="px-3 py-[10px] border-l border-riel text-right text-h2 font-semibold">
                      {fmt(total.pagado, false)}
                    </td>
                    <td
                      className={cn(
                        "pl-3 pr-4 py-[10px] text-right text-h2 font-semibold",
                        total.pendiente < 0 && "text-negativo",
                      )}
                    >
                      {fmt(total.pendiente, false)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <TarjetaNota>
            <strong>A liquidar</strong> es venta menos comisión menos premios de toda la semana;{" "}
            <strong>pagado</strong> es la parte que ya se cerró en un corte y{" "}
            <strong>pendiente</strong> el resto. Los dos suman siempre el primero — lo garantiza la
            base, que no deja meter una misma liquidación en dos cortes, y es lo que hace posible
            cobrar el lunes y el martes hoy y el resto el jueves.
          </TarjetaNota>
        </>
      )}
    </>
  );
}
