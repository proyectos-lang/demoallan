import { RielSemanas, type SemanaDelRiel } from "@/components/informe/riel-semanas";
import { TablaSaldos, type FilaSaldoVendedor } from "@/components/liquidacion/tabla-saldos";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaLargaSinDia } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Saldos por vendedor de una semana: qué traía cada uno y qué debe hoy.
 *
 * Es la lista con la que se sale a cobrar. Mismo riel de semanas que la hoja,
 * para que elegir semana se haga igual en las tres pestañas.
 *
 * LAS CIFRAS SALEN DE LA MISMA ARITMÉTICA que el módulo de liquidación, y no
 * de una cuenta paralela: `fn_saldos_por_vendedor` repite letra por letra lo
 * que hace `fn_liquidacion_por_semana` —el saldo restado fila a fila, el corte
 * partiendo pagado de pendiente, el arrastre de las semanas estrictamente
 * anteriores—. Las dos pantallas se leen una al lado de la otra y un céntimo
 * de diferencia rompería la confianza en ambas.
 */
export async function VistaSaldos({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const { data: semanasRaw, error: errorSemanas } = await supabase.rpc(
    "fn_liquidacion_por_semana",
    { p_vendedor_id: null },
  );

  if (errorSemanas) {
    return <TarjetaNota>No se pudieron cargar las semanas: {errorSemanas.message}</TarjetaNota>;
  }

  const semanas = (semanasRaw ?? []).map((s) => ({
    inicio: s.r_inicio,
    fin: s.r_fin,
    semana: s.r_semana,
    anio: s.r_anio,
    pendiente: Number(s.r_pendiente),
    pendientes: s.r_pendientes,
  }));

  if (semanas.length === 0) {
    return (
      <TarjetaNota>
        Todavía no hay ninguna semana con sorteos liquidados, así que no hay saldos que mostrar.
      </TarjetaNota>
    );
  }

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

  const { data, error } = await supabase.rpc("fn_saldos_por_vendedor", {
    p_desde: abierta.inicio,
    p_hasta: abierta.fin,
  });

  const filas: FilaSaldoVendedor[] = (data ?? []).map((f) => ({
    id: f.r_vendedor_id,
    codigo: f.r_codigo,
    nombre: f.r_nombre,
    activo: f.r_activo,
    anterior: Number(f.r_anterior),
    venta: Number(f.r_venta),
    semana: Number(f.r_semana),
    liquidado: Number(f.r_liquidado),
    pendiente: Number(f.r_pendiente),
    actual: Number(f.r_actual),
  }));

  return (
    <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
      <RielSemanas
        semanas={delRiel}
        activa={abierta.inicio}
        titulo="SEMANAS"
        plantilla="/liquidacion?vista=saldos&semana={semana}"
      />

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <h2 className="text-h2 font-semibold tracking-sutil m-0">
          Semana #{abierta.semana}{" "}
          <span className="text-secundario font-medium">
            · {fechaLargaSinDia(abierta.inicio)} — {fechaLargaSinDia(abierta.fin)}
          </span>
        </h2>

        {error ? (
          <TarjetaNota>No se pudieron cargar los saldos: {error.message}</TarjetaNota>
        ) : (
          <TablaSaldos
            filas={filas}
            semana={abierta.semana}
            desde={abierta.inicio}
            hasta={abierta.fin}
          />
        )}

        <TarjetaNota>
          <strong>Saldo anterior</strong> es lo que quedó sin liquidar de las semanas previas;{" "}
          <strong>saldo de la semana</strong> es venta menos comisión menos premios de estos siete
          días, y <strong>liquidado</strong> la parte de ellos que ya se cerró en un corte. El{" "}
          <strong>saldo actual</strong> —el anterior más lo que falta de esta semana— es la
          cantidad que hay que cuadrar hoy con cada vendedor, y es el mismo número que enseña su
          hoja en la primera pestaña.
        </TarjetaNota>
      </div>
    </div>
  );
}
