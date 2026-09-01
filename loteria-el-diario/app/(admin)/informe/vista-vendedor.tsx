import { RielVendedores, type VendedorDelRiel } from "@/components/informe/riel-vendedores";
import { Kpi } from "@/components/informe/kpi";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * Análisis de un vendedor, acumulado y semana a semana.
 *
 * Arriba lo que el vendedor lleva en toda su historia y su peso dentro del
 * negocio; abajo la serie semanal, que es donde se ve si una mala racha es una
 * racha o una sola semana.
 *
 * El acumulado se suma de la misma serie que se enseña debajo, a propósito:
 * calcularlo por separado —una consulta para el total y otra para el detalle—
 * es la forma más fácil de que un día dejen de cuadrar y nadie sepa cuál de
 * las dos mentía.
 */
export async function VistaVendedor({ vendedorPedido }: { vendedorPedido: string }) {
  const supabase = await crearClienteServidor();

  const [{ data: padron }, { data: semanas, error: errorSemanas }] = await Promise.all([
    supabase.from("vendedor").select("id, codigo, nombre, activo").order("codigo"),
    supabase.rpc("fn_semanas_operadas"),
  ]);

  const vendedores: VendedorDelRiel[] = (padron ?? []).map((v) => ({
    id: v.id,
    codigo: v.codigo,
    nombre: v.nombre,
    activo: v.activo,
  }));

  if (vendedores.length === 0) {
    return <TarjetaNota>No hay ningún vendedor en el padrón.</TarjetaNota>;
  }

  // El padrón se consulta antes de filtrar, así que un id inventado en la
  // dirección no llega nunca a la base.
  const elegido = vendedores.find((v) => v.id === vendedorPedido) ?? vendedores[0];

  // Los totales del negocio entero: sirven para el «% de la venta total», que
  // es la cifra por la que el gerente entra a esta pantalla.
  const global = (semanas ?? []).reduce(
    (a, s) => ({
      venta: a.venta + Number(s.r_venta),
      comision: a.comision + Number(s.r_comision),
    }),
    { venta: 0, comision: 0 },
  );

  const { data, error } = await supabase.rpc("fn_historial_vendedor", {
    p_vendedor_id: elegido.id,
  });

  const historia = (data ?? []).map((f) => ({
    inicio: f.r_inicio,
    fin: f.r_fin,
    semana: f.r_semana,
    venta: Number(f.r_venta),
    premiado: Number(f.r_premiado),
    premios: Number(f.r_premios),
    comision: Number(f.r_comision),
    neto: Number(f.r_neto),
  }));

  const suyo = historia.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      premios: a.premios + f.premios,
      comision: a.comision + f.comision,
      neto: a.neto + f.neto,
    }),
    { venta: 0, premios: 0, comision: 0, neto: 0 },
  );

  const activas = historia.filter((f) => f.venta > 0).length;
  const promedio = activas ? suyo.venta / activas : 0;
  const proporcion = (n: number, sobre: number) => (sobre ? (n / sobre) * 100 : 0);
  const pctVenta = proporcion(suyo.venta, global.venta);
  const pctPremios = proporcion(suyo.premios, suyo.venta);
  const pctComision = proporcion(suyo.comision, suyo.venta);
  const pctNeto = proporcion(suyo.neto, suyo.venta);

  const signo = (v: number) => (v < 0 ? "text-negativo" : "text-positivo");

  return (
    <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
      <RielVendedores vendedores={vendedores} activo={elegido.id} />

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Los dos números del negocio entero, para dar escala a los del vendedor. */}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          <Kpi
            etiqueta="SEMANAS ANALIZADAS"
            valor={String((semanas ?? []).length)}
            pie={
              (semanas ?? []).length > 0
                ? `desde ${fechaLargaSinDia((semanas ?? [])[(semanas ?? []).length - 1].r_inicio)}`
                : undefined
            }
          />
          <Kpi
            etiqueta="COMISIÓN TOTAL PAGADA"
            valor={fmt(global.comision)}
            pie="a todos los vendedores, en toda la historia"
          />
        </div>

        {errorSemanas && (
          <TarjetaNota>No se pudieron cargar las semanas: {errorSemanas.message}</TarjetaNota>
        )}

        <Tarjeta padding="16px 18px">
          <span className="block text-h2 font-semibold tracking-sutil">{elegido.nombre}</span>
          <span className="block text-meta text-secundario mt-[3px]">
            {elegido.codigo} · {activas} {activas === 1 ? "semana activa" : "semanas activas"} de{" "}
            {historia.length} con movimiento
            {!elegido.activo && " · de baja"}
          </span>
        </Tarjeta>

        {error ? (
          <TarjetaNota>No se pudo cargar el historial: {error.message}</TarjetaNota>
        ) : historia.length === 0 ? (
          <TarjetaNota>
            {elegido.nombre} no tiene ninguna semana liquidada todavía.
          </TarjetaNota>
        ) : (
          <>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              <Kpi etiqueta="VENTA TOTAL" valor={fmt(suyo.venta)} />
              <Kpi
                etiqueta="% DE LA VENTA TOTAL"
                valor={`${pctVenta.toFixed(2)}%`}
                pie="del negocio entero"
              />
              <Kpi
                etiqueta="PREMIOS PAGADOS"
                valor={fmt(suyo.premios)}
                esquina={{ texto: `${pctPremios.toFixed(1)}%`, color: "text-secundario" }}
                pie="de su propia venta"
              />
              <Kpi
                etiqueta="COMISIÓN GANADA"
                valor={fmt(suyo.comision)}
                esquina={{ texto: `${pctComision.toFixed(1)}%`, color: "text-secundario" }}
                pie="de su propia venta"
              />
              <Kpi
                etiqueta="NETO GENERADO"
                valor={fmt(suyo.neto)}
                color={signo(suyo.neto)}
                esquina={{ texto: `${pctNeto.toFixed(1)}%`, color: signo(suyo.neto) }}
                pie="lo que deja a la casa"
              />
              <Kpi
                etiqueta="PROMEDIO POR SEMANA"
                valor={fmt(promedio)}
                pie={`sobre ${activas} ${activas === 1 ? "semana" : "semanas"} con venta`}
              />
            </div>

            <h2 className="text-h2 font-semibold tracking-sutil mt-2 mb-0">Historial por semana</h2>

            <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-tabla min-w-[720px]">
                  <thead>
                    <tr className="bg-tinte">
                      {["SEMANA", "VENTA", "PREMIADO", "PREMIOS", "COMISIÓN", "NETO"].map(
                        (t, i) => (
                          <th
                            key={t}
                            className={cn(
                              "py-[11px] border-b border-riel text-th font-semibold tracking-th text-secundario",
                              i === 0 ? "text-left pl-4 pr-3" : "text-right",
                              i === 5 ? "pl-3 pr-4" : i > 0 ? "px-3" : "",
                            )}
                          >
                            {t}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>

                  <tbody>
                    {historia.map((f) => (
                      <tr key={f.inicio} className="hover:bg-tinte">
                        <td className="pl-4 pr-3 py-[11px] border-b border-fondo">
                          <span className="font-medium">Semana #{f.semana}</span>
                          <span className="text-th text-mudo ml-2">
                            {fechaLargaSinDia(f.inicio)} — {fechaLargaSinDia(f.fin)}
                          </span>
                        </td>
                        <td className="px-3 py-[11px] border-b border-fondo text-right">
                          {fmt(f.venta, false)}
                        </td>
                        <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                          {fmt(f.premiado, false)}
                        </td>
                        <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                          {fmt(f.premios, false)}
                        </td>
                        <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                          {fmt(f.comision, false)}
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
                      <td className="pl-4 pr-3 py-[11px] text-th font-semibold tracking-subtotal text-secundario">
                        ACUMULADO · {historia.length}{" "}
                        {historia.length === 1 ? "semana" : "semanas"}
                      </td>
                      <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                        {fmt(suyo.venta, false)}
                      </td>
                      <td />
                      <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                        {fmt(suyo.premios, false)}
                      </td>
                      <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                        {fmt(suyo.comision, false)}
                      </td>
                      <td
                        className={cn(
                          "pl-3 pr-4 py-[11px] text-right text-h2 font-semibold",
                          suyo.neto < 0 && "text-negativo",
                        )}
                      >
                        {fmt(suyo.neto, false)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </>
        )}

        <TarjetaNota>
          Sólo cuentan las semanas con sorteos liquidados, y una semana aparece aquí desde que el
          vendedor movió algo en ella. <strong>Neto generado</strong> es lo que le queda a la casa
          con este vendedor: su venta menos su comisión menos los premios que hubo que pagarle. En
          rojo cuando le costó dinero al negocio, que en una semana suelta es normal — un solo
          número muy jugado la voltea.
        </TarjetaNota>
      </div>
    </div>
  );
}
