import { RielSemanas, type SemanaDelRiel } from "@/components/informe/riel-semanas";
import { Kpi } from "@/components/informe/kpi";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Resumen de la semana.
 *
 * Los cinco números de la semana arriba y el padrón debajo, con los parámetros
 * con los que cada vendedor jugó ESA semana y lo que movió. Las dos mitades de
 * la fila son cosas distintas —configuración y resultado— y por eso van
 * separadas por un filete en el encabezado de la tabla.
 *
 * Los parámetros son de sólo lectura aquí. Se editan en «Vendedores y
 * límites», que es su sitio: dos pantallas que escriben el mismo dato son dos
 * sitios donde puede quedar distinto.
 */
export async function VistaSemanal({ semanaPedida }: { semanaPedida: string }) {
  const supabase = await crearClienteServidor();

  const { data: semanasRaw, error: errorSemanas } = await supabase.rpc("fn_semanas_operadas");

  const semanas: SemanaDelRiel[] = (semanasRaw ?? []).map((s) => ({
    inicio: s.r_inicio,
    fin: s.r_fin,
    semana: s.r_semana,
    anio: s.r_anio,
    neto: Number(s.r_neto),
  }));

  if (errorSemanas) {
    return <TarjetaNota>No se pudieron cargar las semanas: {errorSemanas.message}</TarjetaNota>;
  }
  if (semanas.length === 0) {
    return (
      <TarjetaNota>
        Todavía no hay ninguna semana con sorteos liquidados. El resumen se arma desde las
        liquidaciones, así que un sorteo sin número ganador todavía no cuenta.
      </TarjetaNota>
    );
  }

  // Una semana inventada en la dirección cae en la más reciente, que es la que
  // el gerente abre por costumbre.
  const abierta = semanas.find((s) => s.inicio === semanaPedida) ?? semanas[0];

  const { data, error } = await supabase.rpc("fn_resumen_semanal", {
    p_desde: abierta.inicio,
    p_hasta: abierta.fin,
  });

  const filas = (data ?? []).map((f) => ({
    id: f.r_vendedor_id,
    codigo: f.r_codigo,
    nombre: f.r_nombre,
    activo: f.r_activo,
    comision: f.r_comision === null ? null : Number(f.r_comision),
    tope: f.r_tope === null ? null : Number(f.r_tope),
    factor: f.r_factor === null ? null : Number(f.r_factor),
    venta: Number(f.r_venta),
    premiado: Number(f.r_premiado),
    pago: Number(f.r_pago),
    comisionL: Number(f.r_comision_l),
    neto: Number(f.r_neto),
  }));

  const total = filas.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      pago: a.pago + f.pago,
      comision: a.comision + f.comisionL,
      neto: a.neto + f.neto,
    }),
    { venta: 0, pago: 0, comision: 0, neto: 0 },
  );

  const inactivos = filas.filter((f) => !f.activo).length;
  const pct = (n: number) => (total.venta ? `${((n / total.venta) * 100).toFixed(1)}% de la venta` : "—");

  const encabezados: [string, string][] = [
    ["N°", "left"],
    ["CÓD.", "left"],
    ["NOMBRE", "left"],
    ["%", "right"],
    ["LÍM. PREMIO", "right"],
    ["F. PREM", "right"],
    ["VENTA", "right"],
    ["PREMIADO", "right"],
    ["PAGO PREMIADO", "right"],
    ["COMISIÓN", "right"],
    ["TOTAL NETO", "right"],
  ];

  return (
    <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
      <RielSemanas semanas={semanas} activa={abierta.inicio} />

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-h2 font-semibold tracking-sutil m-0">
            Semana #{abierta.semana}{" "}
            <span className="text-secundario font-medium">
              · {fechaLargaSinDia(abierta.inicio)} — {fechaLargaSinDia(abierta.fin)}
            </span>
          </h2>
        </div>

        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(178px,1fr))]">
          <Kpi etiqueta="VENTA TOTAL" valor={fmt(total.venta)} />
          <Kpi
            etiqueta="TOTAL NETO"
            valor={fmt(total.neto)}
            pie={pct(total.neto)}
            color={total.neto < 0 ? "text-negativo" : "text-positivo"}
          />
          <Kpi etiqueta="COMISIONES" valor={fmt(total.comision)} pie={pct(total.comision)} />
          <Kpi etiqueta="PREMIOS PAGADOS" valor={fmt(total.pago)} pie={pct(total.pago)} />
          <Kpi
            etiqueta="VENDEDORES"
            valor={String(filas.length)}
            pie={inactivos > 0 ? `${inactivos} de baja` : "todos activos"}
          />
        </div>

        {error ? (
          <TarjetaNota>No se pudo cargar la semana: {error.message}</TarjetaNota>
        ) : (
          <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[1000px]">
                <thead>
                  <tr className="bg-tinte">
                    {encabezados.map(([t, alinea], i) => (
                      <th
                        key={t}
                        className={cn(
                          "py-[11px] border-b border-riel text-th font-semibold tracking-th text-secundario",
                          alinea === "left" ? "text-left" : "text-right",
                          i === 0 ? "pl-4 pr-3" : i === encabezados.length - 1 ? "pl-3 pr-4" : "px-3",
                          // El filete separa la configuración del resultado: a
                          // la izquierda con qué se jugó, a la derecha qué pasó.
                          t === "VENTA" && "border-l border-riel",
                        )}
                      >
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {filas.map((f, i) => (
                    <tr key={f.id} className="hover:bg-tinte">
                      <td className="pl-4 pr-3 py-[11px] border-b border-fondo text-mudo">
                        {i + 1}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-secundario">
                        {f.codigo}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo font-medium">
                        {f.nombre}
                        {!f.activo && <span className="text-th text-mudo ml-2">de baja</span>}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {f.comision === null ? "—" : `${(f.comision * 100).toFixed(2)}%`}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {f.tope === null ? "—" : fmt(f.tope, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {f.factor === null ? "—" : f.factor.toFixed(2)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo border-l border-riel text-right">
                        {fmt(f.venta, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {fmt(f.premiado, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {fmt(f.pago, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {fmt(f.comisionL, false)}
                      </td>
                      <td
                        className={cn(
                          "pl-3 pr-4 py-[11px] border-b border-fondo text-right font-semibold",
                          f.neto < 0 && "text-negativo",
                        )}
                      >
                        {fmt(f.neto, false)}
                      </td>
                    </tr>
                  ))}
                </tbody>

                <tfoot>
                  <tr className="bg-tinte">
                    <td
                      colSpan={6}
                      className="pl-4 pr-3 py-[11px] text-th font-semibold tracking-subtotal text-secundario"
                    >
                      TOTALES DE LA SEMANA · {filas.length} vendedores
                    </td>
                    <td className="px-3 py-[11px] border-l border-riel text-right text-h2 font-semibold">
                      {fmt(total.venta, false)}
                    </td>
                    <td />
                    <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                      {fmt(total.pago, false)}
                    </td>
                    <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                      {fmt(total.comision, false)}
                    </td>
                    <td
                      className={cn(
                        "pl-3 pr-4 py-[11px] text-right text-h2 font-semibold",
                        total.neto < 0 && "text-negativo",
                      )}
                    >
                      {fmt(total.neto, false)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        <TarjetaNota>
          <strong>%</strong>, <strong>límite de premio</strong> y <strong>factor</strong> son los
          que regían al cerrar esa semana, no los de hoy: un resumen de marzo tiene que enseñar la
          comisión de marzo. Se editan en «Vendedores y límites». <strong>Premiado</strong> es lo
          apostado al número que salió y <strong>pago premiado</strong> lo que costó pagarlo. El{" "}
          <strong>total neto</strong> es venta menos comisión menos premios.
        </TarjetaNota>
      </div>
    </div>
  );
}
