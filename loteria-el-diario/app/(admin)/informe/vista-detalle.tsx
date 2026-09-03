import {
  FiltrosDetalle,
  type VendedorFiltro,
} from "@/components/informe/filtros-detalle";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, hoyHonduras, iso, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORAS = ["11:00", "15:00", "20:00"] as const;
const esHora = (v: string): v is (typeof HORAS)[number] => HORAS.some((h) => h === v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Detalle de venta: cada ticket, uno a uno, con sus números.
 *
 * El resto del informe contesta con totales. Ésta es la pantalla a la que se
 * baja cuando algo no cuadra y hay que ver la venta individual —qué se jugó, a
 * qué hora, por cuánto—. Hasta ahora eso obligaba a consultar la base a mano.
 *
 * UNA FILA POR TICKET, no por línea. Un ticket de doce números daría doce
 * filas repitiendo folio y hora, y habría que reconstruir mentalmente dónde
 * empieza y acaba cada uno. Los números van juntos en su columna, como en el
 * papel que tiene el cliente en la mano: eso es lo que se compara cuando
 * alguien reclama.
 */
export async function VistaDetalle({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  const pedido = texto("dia");
  const dia = FECHA.test(pedido) ? pedido : iso(hoyHonduras());
  const horaPedida = texto("hora");
  const hora = esHora(horaPedida) ? horaPedida : "";
  const conAnulados = texto("anulados") === "1";

  /*
   * Los identificadores se validan ANTES de llegar a la base.
   *
   * Van a un parámetro `uuid[]` de Postgres: un valor que no lo sea aborta la
   * consulta entera con un error de conversión, y la pantalla muestra «no se
   * pudo cargar» sin decir por qué. Ya ocurrió con `?vendedor=` en otra vista.
   */
  const elegidos = texto("vs")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => UUID.test(x));

  // El padrón del día: quién vendió y cuánto, para poblar el filtro. Se pide
  // sin filtrar por vendedor a propósito — el filtro tiene que ofrecer a todos
  // los que vendieron, no sólo a los ya elegidos.
  const { data: delDia } = await supabase.rpc("fn_detalle_venta", {
    p_desde: dia,
    p_hasta: dia,
    p_vendedores: null,
    p_hora: hora || null,
    p_incluir_anulados: conAnulados,
    p_limite: 2000,
  });

  const porVendedor = new Map<string, VendedorFiltro>();
  for (const f of delDia ?? []) {
    const y = porVendedor.get(f.r_vendedor_id);
    if (y) y.tickets += 1;
    else
      porVendedor.set(f.r_vendedor_id, {
        id: f.r_vendedor_id,
        codigo: f.r_codigo,
        nombre: f.r_vendedor,
        tickets: 1,
      });
  }
  const vendedores = [...porVendedor.values()].sort((a, b) =>
    a.codigo.localeCompare(b.codigo),
  );

  // Se filtra en memoria y no con otra consulta: los datos del día ya están
  // aquí, y volver a pedirlos sería un viaje de más por un `where` que este
  // volumen no necesita.
  const filas = elegidos.length
    ? (delDia ?? []).filter((f) => elegidos.includes(f.r_vendedor_id))
    : (delDia ?? []);

  const total = filas.reduce(
    (a, f) => ({
      tickets: a.tickets + (f.r_anulado ? 0 : 1),
      lineas: a.lineas + (f.r_anulado ? 0 : f.r_lineas),
      venta: a.venta + (f.r_anulado ? 0 : Number(f.r_total)),
      premio: a.premio + (f.r_anulado ? 0 : Number(f.r_premio)),
      anulados: a.anulados + (f.r_anulado ? 1 : 0),
      repetidos: a.repetidos + (!f.r_anulado && f.r_repetido ? 1 : 0),
    }),
    { tickets: 0, lineas: 0, venta: 0, premio: 0, anulados: 0, repetidos: 0 },
  );

  const larga = fechaLarga(dia);

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta padding="14px 18px">
        <FiltrosDetalle
          dia={dia}
          hora={hora}
          vendedores={vendedores}
          elegidos={elegidos}
          conAnulados={conAnulados}
        />
      </Tarjeta>

      <Tarjeta padding="18px 20px">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              {total.tickets} {total.tickets === 1 ? "venta" : "ventas"}
            </h2>
            <p className="text-micro text-secundario mt-[5px] mb-0">
              {larga}
              {hora ? ` · sorteo de ${hora12(hora)}` : " · los tres sorteos"}
              {elegidos.length > 0 &&
                ` · ${elegidos.length} ${elegidos.length === 1 ? "vendedor" : "vendedores"}`}
            </p>
          </div>
          <div className="flex gap-7 flex-wrap">
            <Cifra etiqueta="VENTA" valor={fmt(total.venta)} />
            <Cifra etiqueta="NÚMEROS JUGADOS" valor={String(total.lineas)} />
            <Cifra
              etiqueta="PAGO PREMIOS"
              valor={total.premio > 0 ? fmt(total.premio) : "—"}
            />
          </div>
        </div>

        {/*
          Los repetidos se señalan pero NO se llaman duplicados: dos clientes
          pueden apostar lo mismo, y decir «duplicado» sería acusar al vendedor
          de un error que quizá no cometió. Es dónde mirar primero, no un
          veredicto.
        */}
        {total.repetidos > 0 && (
          <p className="text-meta text-secundario mt-4 mb-0">
            {total.repetidos}{" "}
            {total.repetidos === 1
              ? "venta repite una jugada"
              : "ventas repiten una jugada"}{" "}
            ya vista en el mismo sorteo. Puede ser otro cliente con la misma
            apuesta, o una venta registrada dos veces: la columna de la derecha
            dice cuántos segundos pasaron.
          </p>
        )}

        {total.anulados > 0 && (
          <p className="text-meta text-secundario mt-2 mb-0">
            {total.anulados} {total.anulados === 1 ? "anulada" : "anuladas"}, que no
            cuentan en los totales.
          </p>
        )}
      </Tarjeta>

      {filas.length === 0 ? (
        <TarjetaNota>
          {vendedores.length === 0
            ? "No hay ninguna venta registrada ese día."
            : "Ninguno de los vendedores elegidos vendió ese día."}
        </TarjetaNota>
      ) : (
        <Tarjeta padding="0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-tabla">
              <thead>
                <tr className="text-left">
                  {[
                    "HORA",
                    "FOLIO",
                    "VENDEDOR",
                    "SORTEO",
                    "NÚMEROS JUGADOS",
                    "TOTAL",
                    "PREMIO",
                    "",
                  ].map((h, i) => (
                    <th
                      key={h + i}
                      className={cn(
                        "border-b border-borde py-[10px] px-3 text-eyebrow font-semibold tracking-seccion text-secundario",
                        (h === "TOTAL" || h === "PREMIO") && "text-right",
                        i === 0 && "pl-4",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr
                    key={f.r_ticket_id}
                    className={cn(f.r_anulado && "opacity-55")}
                  >
                    <td className="border-b border-fondo py-[10px] pl-4 pr-3 text-secundario whitespace-nowrap">
                      {f.r_creado_en.slice(11, 19)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-cuerpo whitespace-nowrap">
                      {f.r_folio}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3">
                      <span className="block text-cuerpo">{f.r_vendedor}</span>
                      <span className="block text-label text-mudo">{f.r_codigo}</span>
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-secundario whitespace-nowrap">
                      {hora12(f.r_hora)}
                      {f.r_numero_ganador !== null && (
                        <span className="block text-label text-mudo">
                          salió {pad2(f.r_numero_ganador)}
                        </span>
                      )}
                    </td>
                    {/*
                      La jugada en monoespaciada: las columnas de número y monto
                      se alinean entre filas y el ojo compara dos tickets sin
                      tener que leerlos enteros.
                    */}
                    <td className="border-b border-fondo py-[10px] px-3 font-mono text-micro text-cuerpo">
                      {f.r_jugada}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo whitespace-nowrap">
                      {fmt(Number(f.r_total), false)}
                    </td>
                    <td
                      className={cn(
                        "border-b border-fondo py-[10px] px-3 text-right whitespace-nowrap",
                        Number(f.r_premio) > 0 ? "text-positivo font-semibold" : "text-mudo",
                      )}
                    >
                      {Number(f.r_premio) > 0 ? fmt(Number(f.r_premio), false) : "—"}
                    </td>
                    <td className="border-b border-fondo py-[10px] pl-3 pr-4 whitespace-nowrap">
                      {f.r_anulado ? (
                        <span
                          className="text-label text-negativo"
                          title={f.r_motivo ?? undefined}
                        >
                          ANULADA
                        </span>
                      ) : f.r_repetido ? (
                        <span className="text-label text-ambar-texto">
                          repite · {f.r_segundos}s
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      )}
    </div>
  );
}

/** Una cifra del panel de cabecera. */
function Cifra({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <div>
      <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
        {etiqueta}
      </span>
      <span className="block text-h2 font-semibold tracking-titular mt-[3px]">
        {valor}
      </span>
    </div>
  );
}
