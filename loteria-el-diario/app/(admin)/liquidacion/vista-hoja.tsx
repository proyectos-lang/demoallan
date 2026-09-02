import {
  FiltrosLiquidacion,
  type OpcionVendedorLiq,
} from "@/components/liquidacion/filtros-liquidacion";
import {
  HojaLiquidacion,
  type FilaLiquidacion,
} from "@/components/liquidacion/hoja-liquidacion";
import { RielSemanas, type SemanaDelRiel } from "@/components/informe/riel-semanas";
import { Kpi } from "@/components/informe/kpi";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La hoja de cobro de un vendedor, semana a semana.
 *
 * El riel de la izquierda enseña todas las semanas en las que ese vendedor
 * movió algo, con lo que falta por cobrar en cada una: así se ve de un vistazo
 * dónde queda saldo sin abrir siete pantallas. Encima de la hoja van las tres
 * cifras de la semana abierta —cuánto hay, cuánto se pagó y cuánto falta— que
 * son las que se dicen por teléfono.
 */
export async function VistaHoja({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  // El padrón de este módulo NO filtra por `activo`: a un vendedor dado de baja
  // con saldo pendiente hay que poder pagarle. Es la diferencia con reportes y
  // control, que sí lo filtran.
  const { data: crudos } = await supabase.rpc("fn_vendedores_liquidables");

  const vendedores: OpcionVendedorLiq[] = (crudos ?? []).map((v) => ({
    id: v.r_vendedor_id,
    codigo: v.r_codigo,
    nombre: v.r_nombre,
    activo: v.r_activo,
    eliminado: v.r_eliminado,
    pendientes: Number(v.r_pendientes),
  }));

  const vendedor = vendedores.find((v) => v.id === texto("vendedor")) ?? null;

  if (!vendedor) {
    return (
      <>
        <FiltrosLiquidacion vendedores={vendedores} vendedorId="" vista="hoja" />
        <TarjetaNota>
          Elija un vendedor para ver su hoja. La cuenta se cierra con uno a la vez: el pago es un
          gesto por persona, no un total del padrón. Para mirar cómo va el cobro de todos, la
          pestaña de al lado.
        </TarjetaNota>
      </>
    );
  }

  const { data: semanasRaw, error: errorSemanas } = await supabase.rpc(
    "fn_liquidacion_por_semana",
    { p_vendedor_id: vendedor.id },
  );

  const semanas = (semanasRaw ?? []).map((s) => ({
    inicio: s.r_inicio,
    fin: s.r_fin,
    semana: s.r_semana,
    anio: s.r_anio,
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

  // Un fallo de la consulta y un vendedor sin semanas se ven igual desde
  // aquí —una lista vacía— y no son lo mismo: decir «no tiene semanas»
  // cuando lo que pasa es que falta la función manda a buscar el problema al
  // sitio equivocado.
  if (errorSemanas) {
    return (
      <>
        <FiltrosLiquidacion vendedores={vendedores} vendedorId={vendedor.id} vista="hoja" />
        <TarjetaNota>No se pudieron cargar las semanas: {errorSemanas.message}</TarjetaNota>
      </>
    );
  }

  if (semanas.length === 0) {
    return (
      <>
        <FiltrosLiquidacion vendedores={vendedores} vendedorId={vendedor.id} vista="hoja" />
        <TarjetaNota>
          {vendedor.nombre} no tiene ninguna semana liquidada todavía. Un sorteo sin número
          ganador no genera saldo y por eso no aparece aquí.
        </TarjetaNota>
      </>
    );
  }

  /*
   * Sin semana en la dirección se abre la más reciente QUE TENGA ALGO POR
   * COBRAR. Abrir la última a secas dejaría la pantalla en «no queda nada» las
   * más de las veces, cuando lo que se viene a hacer es cobrar.
   */
  const pedida = texto("semana");
  const abierta =
    (FECHA.test(pedida) ? semanas.find((s) => s.inicio === pedida) : undefined) ??
    semanas.find((s) => s.pendientes > 0) ??
    semanas[0];

  const delRiel: SemanaDelRiel[] = semanas.map((s) => ({
    inicio: s.inicio,
    fin: s.fin,
    semana: s.semana,
    anio: s.anio,
    cifra: s.pendiente,
    // Una semana cobrada entera no necesita una cifra: necesita que se vea que
    // ya está y que el ojo pase de largo.
    nota: s.pendientes === 0 ? "pagada" : undefined,
  }));

  const [{ data: pendientes }, { data: sinNumero }, { data: cortes }, { data: parametro }] =
    await Promise.all([
      supabase.rpc("fn_liquidacion_pendiente", {
        p_vendedor_id: vendedor.id,
        p_desde: abierta.inicio,
        p_hasta: abierta.fin,
      }),
      // Para avisar de que la semana no está completa. Un sorteo sin número
      // ganador no tiene fila en `liquidacion` y por eso no puede pagarse.
      supabase
        .from("sorteo")
        .select("id")
        .gte("fecha", abierta.inicio)
        .lte("fecha", abierta.fin)
        .neq("estado", "liquidado"),
      supabase.rpc("fn_cortes_vendedor", { p_vendedor_id: vendedor.id, p_limite: 8 }),
      // El factor y la comisión que van en la cabecera del papel.
      supabase
        .from("parametro_vendedor")
        .select("comision, factor_pago")
        .eq("vendedor_id", vendedor.id)
        .is("vigente_hasta", null)
        .maybeSingle(),
    ]);

  const filas: FilaLiquidacion[] = (pendientes ?? []).map((f) => ({
    liquidacionId: f.r_liquidacion_id,
    fecha: f.r_fecha,
    hora: f.r_hora,
    ganador: f.r_numero_ganador,
    venta: Number(f.r_venta),
    comision: Number(f.r_comision),
    premios: Number(f.r_premios),
    saldo: Number(f.r_saldo),
  }));

  const entrega = abierta.pendiente >= 0;

  return (
    <>
      <FiltrosLiquidacion vendedores={vendedores} vendedorId={vendedor.id} vista="hoja" />

      <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
        <RielSemanas
          semanas={delRiel}
          activa={abierta.inicio}
          titulo="SEMANAS"
          plantilla={`/liquidacion?vista=hoja&vendedor=${vendedor.id}&semana={semana}`}
        />

        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              Semana #{abierta.semana}{" "}
              <span className="text-secundario font-medium">
                · {fechaLargaSinDia(abierta.inicio)} — {fechaLargaSinDia(abierta.fin)}
              </span>
            </h2>
            <span className="text-meta text-secundario">
              {vendedor.codigo} · {vendedor.nombre}
            </span>
          </div>

          {/* Las tres cifras de la semana: lo que hay, lo cobrado y lo que falta. */}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            <Kpi
              etiqueta="VALOR A LIQUIDAR"
              valor={fmt(abierta.saldo)}
              pie={`${abierta.sorteos} ${abierta.sorteos === 1 ? "sorteo" : "sorteos"} de la semana`}
            />
            <Kpi
              etiqueta="YA LIQUIDADO"
              valor={fmt(abierta.pagado)}
              pie={`${abierta.pagadas} ${abierta.pagadas === 1 ? "sorteo cerrado" : "sorteos cerrados"}`}
              color={abierta.pagado === 0 ? "text-mudo" : undefined}
            />
            <Kpi
              etiqueta="PENDIENTE POR LIQUIDAR"
              valor={fmt(abierta.pendiente)}
              pie={
                abierta.pendientes === 0
                  ? "la semana está cerrada"
                  : `${abierta.pendientes} ${abierta.pendientes === 1 ? "sorteo" : "sorteos"} · ${entrega ? "lo entrega el vendedor" : "lo entrega la casa"}`
              }
              color={
                abierta.pendientes === 0
                  ? "text-positivo"
                  : abierta.pendiente < 0
                    ? "text-negativo"
                    : undefined
              }
            />
          </div>

          <HojaLiquidacion
            filas={filas}
            vendedorId={vendedor.id}
            vendedorNombre={`${vendedor.codigo} · ${vendedor.nombre}`}
            desde={abierta.inicio}
            hasta={abierta.fin}
            sinLiquidar={sinNumero?.length ?? 0}
            factor={parametro ? Number(parametro.factor_pago) : null}
            comisionTasa={parametro ? Number(parametro.comision) : null}
            semana={abierta.semana}
            yaPagados={abierta.pagadas}
          />

          {(cortes?.length ?? 0) > 0 && (
            <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
              <div className="px-[18px] py-[13px] border-b border-riel">
                <h2 className="text-h2 font-semibold tracking-sutil m-0">
                  Liquidaciones anteriores
                </h2>
                <p className="text-meta text-secundario mt-[4px] mb-0">
                  Lo que ya se cerró con {vendedor.nombre}, en las dos direcciones. Sus sorteos no
                  vuelven al informe ni salen en el papel.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-tabla min-w-[640px]">
                  <thead>
                    <tr className="bg-tinte">
                      {["RANGO", "SORTEOS", "VENTA", "COMISIÓN", "PREMIOS", "SALDO", "QUIÉN ENTREGÓ", "NOTA"].map(
                        (th, i) => (
                          <th
                            key={th}
                            className={cn(
                              "text-th font-semibold tracking-th text-secundario border-b border-riel py-[8px]",
                              i >= 1 && i <= 5 ? "text-right" : "text-left",
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
                    {(cortes ?? []).map((c) => (
                      <tr key={c.r_corte_id}>
                        <td className="border-b border-fondo py-[7px] pl-4 pr-3 text-cuerpo">
                          {fechaLargaSinDia(c.r_desde)} — {fechaLargaSinDia(c.r_hasta)}
                        </td>
                        <td className="border-b border-fondo py-[7px] px-3 text-right">
                          {c.r_sorteos}
                        </td>
                        <td className="border-b border-fondo py-[7px] px-3 text-right">
                          {fmt(Number(c.r_venta), false)}
                        </td>
                        <td className="border-b border-fondo py-[7px] px-3 text-right text-cuerpo">
                          {fmt(Number(c.r_comision), false)}
                        </td>
                        <td className="border-b border-fondo py-[7px] px-3 text-right text-cuerpo">
                          {fmt(Number(c.r_premios), false)}
                        </td>
                        <td
                          className={cn(
                            "border-b border-fondo py-[7px] px-3 text-right font-semibold",
                            Number(c.r_saldo) < 0 && "text-negativo",
                          )}
                        >
                          {fmt(Math.abs(Number(c.r_saldo)), false)}
                        </td>
                        {/* El signo del saldo no basta: en una tabla de cierres
                            hay que poder leer de un vistazo en qué dirección
                            se movió el dinero. */}
                        <td className="border-b border-fondo py-[7px] px-3 text-meta">
                          {Number(c.r_saldo) < 0 ? "la casa" : "el vendedor"}
                        </td>
                        <td className="border-b border-fondo py-[7px] pl-3 pr-4 text-label text-secundario">
                          {c.r_nota ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
