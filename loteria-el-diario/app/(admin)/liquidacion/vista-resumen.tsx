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
 * Cómo va la liquidación, semana a semana.
 *
 * Misma forma que el detalle por semana del análisis financiero —una fila por
 * semana, de la más vieja a la más nueva— pero con las columnas del cierre:
 * cuánto había, cuánto se cerró y cuánto falta. Sin vendedor es el negocio
 * entero; con vendedor, lo suyo.
 *
 * LO QUE FALTA VA EN DOS COLUMNAS, no en una. Una semana puede dejar dinero
 * por cobrar a unos vendedores y dinero por pagar a otros, y restarlos da un
 * neto que esconde las dos cifras: con «pendiente: 0» nadie sale a cobrar ni
 * prepara efectivo. La base ya las separa; aquí sólo se enseñan.
 *
 * La fila se apaga cuando la semana está cerrada: una semana grande ya
 * liquidada no es una noticia, y una de cien lempiras abierta de hace dos
 * meses sí.
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
    porCobrar: Number(s.r_por_cobrar),
    porPagar: Number(s.r_por_pagar),
  }));

  const total = semanas.reduce(
    (a, s) => ({
      venta: a.venta + s.venta,
      comision: a.comision + s.comision,
      premios: a.premios + s.premios,
      saldo: a.saldo + s.saldo,
      pagado: a.pagado + s.pagado,
      pendiente: a.pendiente + s.pendiente,
      porCobrar: a.porCobrar + s.porCobrar,
      porPagar: a.porPagar + s.porPagar,
    }),
    {
      venta: 0,
      comision: 0,
      premios: 0,
      saldo: 0,
      pagado: 0,
      pendiente: 0,
      porCobrar: 0,
      porPagar: 0,
    },
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
              etiqueta="YA LIQUIDADO"
              valor={fmt(total.pagado)}
              pie={
                total.saldo
                  ? `${((total.pagado / total.saldo) * 100).toFixed(1)} % de lo que hay`
                  : "—"
              }
            />
            {/*
              Lo pendiente va en DOS cifras y no en una.

              Restarlas esconde el trabajo: un vendedor que debe 5.000 y otro al
              que se le deben 5.000 dan un neto de cero, y con ese cero nadie
              sale a cobrar ni prepara efectivo para pagar. Son diez mil
              lempiras de movimiento en dos direcciones.
            */}
            <Kpi
              etiqueta="POR COBRAR"
              valor={fmt(total.porCobrar)}
              pie={
                semanasAbiertas === 0
                  ? "no queda nada abierto"
                  : "lo entregan los vendedores"
              }
              color={total.porCobrar === 0 ? "text-mudo" : undefined}
            />
            <Kpi
              etiqueta="POR PAGAR"
              valor={fmt(total.porPagar)}
              pie="lo entrega la casa"
              color={total.porPagar === 0 ? "text-mudo" : "text-negativo"}
            />
          </div>

          <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[1060px]">
                <thead>
                  <tr className="bg-tinte">
                    {[
                      "SEMANA",
                      "SORTEOS",
                      "VENTA",
                      "COMISIÓN",
                      "PREMIOS",
                      "A LIQUIDAR",
                      "LIQUIDADO",
                      "POR COBRAR",
                      "POR PAGAR",
                    ].map((th, i) => (
                      <th
                        key={th}
                        className={cn(
                          "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                          i === 0 ? "text-left pl-4 pr-3" : "text-right",
                          i === 8 ? "pl-3 pr-4" : i > 0 ? "px-3" : "",
                          // El filete separa lo que había de cómo va el cierre.
                          th === "LIQUIDADO" && "border-l border-riel",
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
                          <span className="text-th text-mudo ml-2 whitespace-nowrap">
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
                            // Rojo por el SIGNO, cerrada o no: la regla dice que
                            // un negativo es dinero que puso la empresa, y eso
                            // sigue siendo cierto después de liquidar. La fila
                            // apagada ya dice que no hay nada que hacer.
                            s.saldo < 0 && "text-negativo",
                          )}
                        >
                          {fmt(s.saldo, false)}
                        </td>
                        <td className="px-3 py-[8px] border-b border-fondo border-l border-riel text-right text-cuerpo">
                          {s.pagado === 0 ? "—" : fmt(s.pagado, false)}
                        </td>
                        {/*
                          Las dos direcciones, separadas. En una semana del
                          padrón entero conviven vendedores que deben y
                          vendedores a los que se debe, y el neto los tapa.
                        */}
                        <td className="px-3 py-[8px] border-b border-fondo text-right font-semibold">
                          {cerrada ? (
                            <span className="text-positivo font-medium">liquidada</span>
                          ) : s.porCobrar === 0 ? (
                            "—"
                          ) : (
                            fmt(s.porCobrar, false)
                          )}
                        </td>
                        <td
                          className={cn(
                            "pl-3 pr-4 py-[8px] border-b border-fondo text-right font-semibold",
                            s.porPagar > 0 && !cerrada && "text-negativo",
                          )}
                        >
                          {cerrada || s.porPagar === 0 ? "—" : fmt(s.porPagar, false)}
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
                    <td className="px-3 py-[10px] text-right text-h2 font-semibold">
                      {fmt(total.porCobrar, false)}
                    </td>
                    <td
                      className={cn(
                        "pl-3 pr-4 py-[10px] text-right text-h2 font-semibold",
                        total.porPagar > 0 && "text-negativo",
                      )}
                    >
                      {fmt(total.porPagar, false)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <TarjetaNota>
            <strong>A liquidar</strong> es venta menos comisión menos premios de toda la semana y{" "}
            <strong>liquidado</strong> la parte que ya se cerró. Lo que falta va en dos columnas
            porque tiene dos direcciones: <strong>por cobrar</strong> es lo que entregan los
            vendedores que deben, y <strong>por pagar</strong> lo que entrega la casa a aquellos
            cuyos premios superaron su venta. Restarlas daría un neto que esconde las dos: cinco
            mil por un lado y cinco mil por el otro no son cero, son diez mil de movimiento.{" "}
            <strong>Liquidar es un solo gesto</strong> en las dos direcciones — lo que se registra
            es que esos sorteos quedaron cerrados, y el signo dice quién sacó la cartera. Que una
            liquidación no entre en dos cierres lo impide la base, y es lo que hace posible cerrar
            el lunes y el martes hoy y el resto el jueves.
          </TarjetaNota>
        </>
      )}
    </>
  );
}
