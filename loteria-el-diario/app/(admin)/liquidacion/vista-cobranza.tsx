import {
  FiltrosLiquidacion,
  type OpcionVendedorLiq,
} from "@/components/liquidacion/filtros-liquidacion";
import { PagarSaldos } from "@/components/liquidacion/pagar-saldos";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hoyHonduras, iso } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/**
 * La ronda de cobro: a quién hay que ir a cobrarle, y por cuánto.
 *
 * POR QUÉ NO BASTA CON «SALDOS POR VENDEDOR»
 * ------------------------------------------
 * Esa pestaña contesta cuánto debe cada uno de los ciento tres vendedores,
 * ordenados por código e incluyendo a los que no deben nada. Sirve para
 * consultar, no para salir a cobrar: hay que recorrerla entera buscando cifras
 * distintas de cero.
 *
 * Aquí sólo aparece quien debe, de mayor a menor. Es la diferencia entre un
 * informe y una lista de tareas.
 *
 * LO QUE SE MIRA ADEMÁS DE LA CIFRA
 * ---------------------------------
 * Desde cuándo arrastra y cuándo fue su último pago. Un vendedor que debe 300
 * y pagó ayer no es el mismo caso que uno que debe 300 y no entrega nada desde
 * hace un mes, aunque la cifra sea idéntica. La antigüedad es lo que decide a
 * quién se llama primero.
 */
export async function VistaCobranza({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const pedido = typeof params.vendedor === "string" ? params.vendedor : "";

  // El mismo padrón y el mismo combobox que las otras pestañas: filtrar aquí
  // es la misma pregunta —«enséñame sólo a éste»— y merece el mismo gesto.
  const { data: crudos } = await supabase.rpc("fn_vendedores_liquidables");
  const vendedores: OpcionVendedorLiq[] = (crudos ?? []).map((v) => ({
    id: v.r_vendedor_id,
    codigo: v.r_codigo,
    nombre: v.r_nombre,
    activo: v.r_activo,
    eliminado: v.r_eliminado,
    pendientes: Number(v.r_pendientes),
    alias: v.r_alias,
  }));
  const elegido = vendedores.find((v) => v.id === pedido) ?? null;

  const { data, error } = await supabase.rpc("fn_cobranza", {});

  if (error) {
    return (
      <TarjetaNota>
        {error.code === "PGRST202"
          ? "La cobranza todavía no está habilitada en la base de datos. Falta aplicar la migración 0079."
          : `No se pudo cargar la cobranza: ${error.message}`}
      </TarjetaNota>
    );
  }

  const todas = data ?? [];
  const filas = elegido ? todas.filter((f) => f.r_vendedor_id === elegido.id) : todas;
  const hoy = iso(hoyHonduras());

  // El combobox va SIEMPRE, aunque no haya filas: es desde donde se quita el
  // filtro para volver a ver a todos.
  const filtro = (
    <FiltrosLiquidacion vendedores={vendedores} vendedorId={pedido} vista="cobranza" />
  );

  if (filas.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {filtro}
        <TarjetaNota>
          {elegido
            ? `${elegido.codigo} · ${elegido.alias ?? elegido.nombre} no debe nada de sorteos sin cerrar.`
            : "Nadie debe nada de sorteos sin cerrar. Todo al día."}
        </TarjetaNota>
      </div>
    );
  }

  const total = filas.reduce(
    (a, f) => ({
      deuda: a.deuda + Number(f.r_deuda),
      abonado: a.abonado + Number(f.r_abonado),
      pendiente: a.pendiente + Number(f.r_pendiente),
    }),
    { deuda: 0, abonado: 0, pendiente: 0 },
  );

  /** Días desde el último pago. Sin pagos, la deuda es tan vieja como su primer sorteo. */
  const diasSin = (f: (typeof filas)[number]) => {
    const desde = f.r_ultimo_pago ?? f.r_desde;
    if (!desde) return 0;
    const ms = new Date(`${hoy}T12:00:00`).getTime() - new Date(`${desde}T12:00:00`).getTime();
    return Math.max(0, Math.round(ms / 86_400_000));
  };

  const celda = "border-b border-fondo py-[10px] px-3 text-right tabular-nums whitespace-nowrap";

  return (
    <div className="flex flex-col gap-4">
      {filtro}
      <Tarjeta padding="18px 20px">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              {filas.length} {filas.length === 1 ? "vendedor debe" : "vendedores deben"}
            </h2>
            <p className="text-micro text-secundario mt-[5px] mb-0">
              Sorteos que nunca entraron en un corte, menos lo que ya entregaron a cuenta.
            </p>
          </div>
          <div className="flex gap-7 flex-wrap">
            <Cifra etiqueta="DEUDA" valor={fmt(total.deuda)} />
            {total.abonado > 0 && <Cifra etiqueta="YA ENTREGADO" valor={fmt(total.abonado)} />}
            <Cifra etiqueta="POR COBRAR" valor={fmt(total.pendiente)} />
          </div>
        </div>
      </Tarjeta>

      <Tarjeta padding="0">
        <div className="overflow-auto max-h-[70dvh]">
          <table className="w-full border-collapse text-tabla">
            <thead className="sticky top-0 z-10 bg-superficie">
              <tr className="text-left">
                {["VENDEDOR", "DESDE", "SORTEOS", "DEUDA", "ENTREGADO", "POR COBRAR", "SIN PAGAR", ""].map(
                  (h, i) => (
                    <th
                      key={h + i}
                      className={cn(
                        "border-b border-borde py-[10px] px-3 text-eyebrow font-semibold tracking-seccion text-secundario",
                        ["SORTEOS", "DEUDA", "ENTREGADO", "POR COBRAR", "SIN PAGAR"].includes(h) &&
                          "text-right",
                        i === 0 && "pl-4",
                      )}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => {
                const dias = diasSin(f);
                return (
                  <tr key={f.r_vendedor_id} className={cn(!f.r_activo && "opacity-60")}>
                    <td className="border-b border-fondo py-[10px] pl-4 pr-3">
                      <span className="block text-cuerpo">{f.r_vendedor}</span>
                      <span className="block text-label text-mudo">
                        {f.r_codigo}
                        {!f.r_activo && " · de baja"}
                      </span>
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-secundario whitespace-nowrap">
                      {fechaLarga(f.r_desde)}
                    </td>
                    <td className={cn(celda, "text-secundario")}>{f.r_sorteos}</td>
                    <td className={cn(celda, "text-cuerpo")}>{fmt(Number(f.r_deuda), false)}</td>
                    <td className={cn(celda, Number(f.r_abonado) > 0 ? "text-positivo" : "text-mudo")}>
                      {Number(f.r_abonado) > 0 ? fmt(Number(f.r_abonado), false) : "—"}
                    </td>
                    <td className={cn(celda, "text-cuerpo font-semibold")}>
                      {fmt(Number(f.r_pendiente), false)}
                    </td>
                    {/*
                      Los días sin pagar se marcan en ámbar a partir de dos
                      semanas: no es un error, es el dato que dice a quién
                      llamar primero cuando dos deben lo mismo.
                    */}
                    <td className={cn(celda, dias >= 14 ? "text-ambar-texto font-medium" : "text-mudo")}>
                      {dias} {dias === 1 ? "día" : "días"}
                    </td>
                    <td className="border-b border-fondo py-[10px] pl-3 pr-4 whitespace-nowrap">
                      <PagarSaldos
                        vendedorId={f.r_vendedor_id}
                        vendedor={`${f.r_codigo} · ${f.r_vendedor}`}
                        pendiente={Number(f.r_pendiente)}
                        hoy={hoy}
                        variante="fila"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Tarjeta>
    </div>
  );
}

function Cifra({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
        {etiqueta}
      </span>
      <span className="block text-h2 font-semibold tracking-titular mt-[3px]">{valor}</span>
    </div>
  );
}
