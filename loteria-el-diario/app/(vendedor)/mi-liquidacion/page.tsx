import { redirect } from "next/navigation";

import { RielSemanas, type SemanaDelRiel } from "@/components/informe/riel-semanas";
import { Kpi } from "@/components/informe/kpi";
import { TablaSorteos, type FilaLiquidacion } from "@/components/liquidacion/tabla-sorteos";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Su liquidación, semana a semana. Sólo de consulta.
 *
 * Es la misma hoja que abre administración para cobrarle, con las mismas
 * cifras y la misma tabla —el componente es literalmente el mismo—, pero sin
 * casillas y sin botón: aquí no se liquida nada. El vendedor viene a saber
 * cuánto debe o cuánto se le debe antes de que le llamen, no a cerrar cuentas.
 *
 * EL VENDEDOR SALE DE LA SESIÓN, nunca de la dirección. La función de la base
 * recibe un id y no comprueba de quién es, así que quien lo elige es este
 * servidor. Es toda la diferencia entre ver lo suyo y ver lo de cualquiera.
 */
export default async function MiLiquidacionPage({ searchParams }: PageProps<"/mi-liquidacion">) {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();
  const params = await searchParams;

  const { data: semanasRaw, error } = await supabase.rpc("fn_liquidacion_por_semana", {
    p_vendedor_id: vendedorId,
  });

  if (error) {
    return (
      <TarjetaNota>No se pudo cargar su liquidación: {error.message}</TarjetaNota>
    );
  }

  const semanas = (semanasRaw ?? []).map((s) => ({
    inicio: s.r_inicio,
    fin: s.r_fin,
    semana: s.r_semana,
    anio: s.r_anio,
    sorteos: s.r_sorteos,
    pagadas: s.r_pagadas,
    pendientes: s.r_pendientes,
    saldo: Number(s.r_saldo),
    pagado: Number(s.r_pagado),
    pendiente: Number(s.r_pendiente),
    arrastre: Number(s.r_arrastre),
    acumulado: Number(s.r_acumulado),
  }));

  if (semanas.length === 0) {
    return (
      <TarjetaNota>
        Todavía no tiene ninguna semana liquidada. Un sorteo sin número ganador no genera saldo:
        aparecerá aquí en cuanto se capture.
      </TarjetaNota>
    );
  }

  // Se abre la más reciente con algo pendiente, que es lo que uno viene a
  // mirar; si está todo cerrado, la última.
  const pedida = typeof params.semana === "string" ? params.semana : "";
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
    nota: s.pendientes === 0 ? "liquidada" : undefined,
  }));

  // La semana entera, igual que en el panel: los días ya liquidados se quedan
  // a la vista, marcados. Si desaparecieran, el vendedor abriría una semana a
  // medias y no encontraría días que sí jugó.
  const [{ data: completa }, { data: cortes }] = await Promise.all([
    supabase.rpc("fn_semana_completa", {
      p_vendedor_id: vendedorId,
      p_desde: abierta.inicio,
      p_hasta: abierta.fin,
    }),
    supabase.rpc("fn_cortes_vendedor", { p_vendedor_id: vendedorId, p_limite: 8 }),
  ]);

  const filas: FilaLiquidacion[] = (completa ?? []).map((f) => ({
    liquidacionId: f.r_liquidacion_id,
    fecha: f.r_fecha,
    hora: f.r_hora,
    ganador: f.r_numero_ganador,
    venta: Number(f.r_venta),
    premiado: Number(f.r_premiado),
    factor: Number(f.r_factor),
    comision: Number(f.r_comision),
    premios: Number(f.r_premios),
    saldo: Number(f.r_saldo),
    pagadoEn: f.r_pagado_en,
  }));

  const entrega = abierta.pendiente >= 0;
  const cerrada = abierta.pendientes === 0;
  // El arrastre sólo se enseña si existe: una tarjeta en cero es ruido, y la
  // primera semana de todas nunca arrastra nada.
  const hayArrastre = Math.round(abierta.arrastre * 100) !== 0;
  const debeAcumulado = abierta.acumulado >= 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-meta text-secundario m-0">
        Lo que queda por cuadrar con administración, semana por semana. Es de consulta: aquí no se
        liquida nada.
      </p>

      {/* En un teléfono el riel va arriba y a lo ancho; en pantalla grande, al
          lado, como en el panel. */}
      <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
        <RielSemanas
          semanas={delRiel}
          activa={abierta.inicio}
          titulo="SUS SEMANAS"
          plantilla="/mi-liquidacion?semana={semana}"
        />

        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">
            Semana #{abierta.semana}{" "}
            <span className="text-secundario font-medium">
              · {fechaLargaSinDia(abierta.inicio)} — {fechaLargaSinDia(abierta.fin)}
            </span>
          </h2>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
            <Kpi
              etiqueta="TOTAL DE LA SEMANA"
              valor={fmt(abierta.saldo)}
              pie={`${abierta.sorteos} ${abierta.sorteos === 1 ? "sorteo" : "sorteos"}`}
            />
            <Kpi
              etiqueta="YA LIQUIDADO"
              valor={fmt(abierta.pagado)}
              pie={`${abierta.pagadas} ${abierta.pagadas === 1 ? "sorteo cerrado" : "sorteos cerrados"}`}
              color={abierta.pagado === 0 ? "text-mudo" : undefined}
            />
            {/*
              El rótulo cambia con el signo, no el número. Un «pendiente» a
              secas se lee como deuda propia en las dos direcciones, y la mitad
              de las semanas van al revés.
            */}
            <Kpi
              etiqueta={
                cerrada ? "PENDIENTE DE LA SEMANA" : entrega ? "USTED ENTREGA" : "LE ENTREGAN"
              }
              valor={fmt(Math.abs(abierta.pendiente))}
              pie={
                cerrada
                  ? "la semana está cerrada"
                  : `${abierta.pendientes} ${abierta.pendientes === 1 ? "sorteo" : "sorteos"} sin liquidar`
              }
              color={cerrada ? "text-positivo" : entrega ? undefined : "text-negativo"}
            />
          </div>

          {/*
            Lo que viene de atrás, y la cuenta completa.

            Una semana rara vez se cierra entera: se entrega lo que se alcanzó y
            el resto queda. Sin esta fila, el vendedor mira la semana y le sale
            una cifra que no es la que le van a pedir.
          */}
          {hayArrastre && (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
              <Kpi
                etiqueta="VIENE DE SEMANAS ANTERIORES"
                valor={fmt(Math.abs(abierta.arrastre))}
                pie={
                  abierta.arrastre >= 0
                    ? "sin liquidar, lo entrega usted"
                    : "sin liquidar, se lo entregan"
                }
                color={abierta.arrastre < 0 ? "text-negativo" : undefined}
              />
              <Kpi
                etiqueta={debeAcumulado ? "TOTAL QUE USTED ENTREGA" : "TOTAL QUE LE ENTREGAN"}
                valor={fmt(Math.abs(abierta.acumulado))}
                pie="esta semana más lo anterior"
                color={debeAcumulado ? undefined : "text-negativo"}
              />
            </div>
          )}

          {filas.length === 0 ? (
            <TarjetaNota>Esa semana no tiene sorteos liquidados.</TarjetaNota>
          ) : (
            <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
              <TablaSorteos filas={filas} />
            </div>
          )}

          {(cortes?.length ?? 0) > 0 && (
            <Tarjeta padding="0">
              <div className="px-[18px] py-[13px] border-b border-riel">
                <h2 className="text-h2 font-semibold tracking-sutil m-0">Ya liquidado</h2>
                <p className="text-meta text-secundario mt-[4px] mb-0">
                  Sus cierres anteriores con administración, en las dos direcciones.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-tabla min-w-[520px]">
                  <thead>
                    <tr className="bg-tinte">
                      {["RANGO", "SORTEOS", "SALDO", "QUIÉN ENTREGÓ"].map((th, i) => (
                        <th
                          key={th}
                          className={cn(
                            "text-th font-semibold tracking-th text-secundario border-b border-riel py-[8px]",
                            i === 1 || i === 2 ? "text-right" : "text-left",
                            i === 0 ? "pl-4 pr-3" : i === 3 ? "pl-3 pr-4" : "px-3",
                          )}
                        >
                          {th}
                        </th>
                      ))}
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
                        <td
                          className={cn(
                            "border-b border-fondo py-[7px] px-3 text-right font-semibold",
                            Number(c.r_saldo) < 0 && "text-negativo",
                          )}
                        >
                          {fmt(Math.abs(Number(c.r_saldo)), false)}
                        </td>
                        <td className="border-b border-fondo py-[7px] pl-3 pr-4 text-meta">
                          {Number(c.r_saldo) < 0 ? "administración" : "usted"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Tarjeta>
          )}

          <TarjetaNota>
            El <strong>saldo</strong> de cada sorteo es su venta menos su comisión menos los
            premios que pagó de su bolsillo. Cuando sale positivo, ese dinero lo entrega usted;
            cuando sale negativo se lo entrega la casa, porque los premios superaron la venta.
            Los sorteos que ya se cerraron con administración se quedan a la vista, marcados{" "}
            <strong>liquidado</strong>: la semana se ve completa. Si de semanas anteriores quedó algo sin cerrar, se
            suma —o se resta— arriba, y el <strong>total</strong> es lo que se cuadra de verdad
            cuando administración le llame.
          </TarjetaNota>
        </div>
      </div>
    </div>
  );
}
