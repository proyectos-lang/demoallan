import { FiltrosDia, type SorteoDelDia } from "@/components/informe/filtros-dia";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { esSorteo, fechaLarga, fmt, hora12, hoyHonduras, iso, jornada, pad2, type Sorteo } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;



const ENCABEZADOS = [
  "ITEM",
  "VENDEDOR",
  "VENTA",
  "PREMIADO",
  "F. PREM",
  "%",
  "PAGO PREMIADO",
  "COMISIÓN",
  "TOTAL BRUTO",
  "TOTAL NETO",
];

/** Una cifra del panel del sorteo, con su peso sobre la venta debajo. */
function Cifra({
  etiqueta,
  valor,
  pie,
  color,
}: {
  etiqueta: string;
  valor: string;
  pie?: string;
  color?: string;
}) {
  return (
    <div>
      <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
        {etiqueta}
      </span>
      <span className={cn("block text-kpi font-semibold tracking-titular mt-[5px]", color)}>
        {valor}
      </span>
      {pie && <span className="block text-label text-mudo mt-[1px]">{pie}</span>}
    </div>
  );
}

/**
 * Captura diaria: un día, un sorteo, todo el padrón.
 *
 * Es la hoja que el gerente abre después de cada sorteo. Antes esta pantalla
 * pedía un rango con atajos y dos tiras de filtros; para un rango ya están las
 * otras tres pestañas, y aquí la pregunta es siempre la misma —qué dejó ESTE
 * sorteo—, así que el filtro se quedó en lo que de verdad cambia: la fecha y
 * cuál de los tres.
 *
 * «Regalado», «pasados» y el factor de regalía no están: el sistema no los
 * registra. Una columna que siempre dice cero no es un dato.
 */
export async function VistaDiaria({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  /*
   * Sin fecha en la dirección se abre el último día con resultado, no hoy.
   * Hoy a media mañana todavía no hay nada liquidado y la pantalla arrancaría
   * en ceros, que es la peor primera impresión posible para un informe.
   */
  const pedido = texto("dia");
  let dia = FECHA.test(pedido) ? pedido : "";
  if (!dia) {
    const { data } = await supabase
      .from("sorteo")
      .select("fecha")
      .eq("estado", "liquidado")
      .order("fecha", { ascending: false })
      .limit(1)
      .maybeSingle();
    dia = data?.fecha ?? iso(hoyHonduras());
  }

  // Los tres sorteos del día, de una vez: sirven para las fichas del filtro y
  // para el número ganador, que es la misma consulta hecha dos veces si no.
  const { data: delDia } = await supabase
    .from("sorteo")
    .select("hora, estado, numero_ganador")
    .eq("fecha", dia)
    .order("hora");

  const sorteos: SorteoDelDia[] = (delDia ?? []).map((s) => ({
    hora: s.hora,
    estado: s.estado,
    ganador: s.numero_ganador,
  }));

  /*
   * Sin sorteo elegido se abre el último del día que ya tenga resultado. La
   * captura se mira después de un sorteo, y el que se acaba de jugar es el que
   * se viene a ver. Si no hay ninguno liquidado se enseña el día completo.
   */
  const horaPedida = texto("hora");
  const ultimoConResultado = [...sorteos].reverse().find((s) => s.estado === "liquidado");
  // La hora que llega de la base también se valida: viene tipada como texto y
  // el parámetro de la consulta es el enum, así que pasa por el mismo cedazo
  // que lo que llega por la dirección.
  const hora: Sorteo | "" = esSorteo(horaPedida)
    ? horaPedida
    : horaPedida === "todos"
      ? ""
      : ultimoConResultado && esSorteo(ultimoConResultado.hora)
        ? ultimoConResultado.hora
        : "";

  const soloConVenta = params.conventa === "1";

  const { data, error } = await supabase.rpc("fn_informe_gerencia", {
    p_desde: dia,
    p_hasta: dia,
    p_hora: hora || null,
  });

  /*
   * `null` NO es `0`, y aquí la diferencia es la que importa.
   *
   * Premios y neto vienen en NULL cuando el sorteo todavía no se ha liquidado:
   * sin número ganador no se sabe qué se pagó. `Number(null)` da 0, así que
   * convertirlos sin mirar los pintaría como ceros —afirmando que no se pagó
   * nada, que es falso— en vez de como «—», que dice la verdad.
   *
   * La venta y la comisión sí se conocen siempre: están en las líneas desde
   * que se registró la venta, con la comisión congelada en cada una.
   */
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  const todas = (data ?? []).map((f) => ({
    id: f.r_vendedor_id,
    codigo: f.r_codigo,
    nombre: f.r_nombre,
    venta: Number(f.r_venta),
    pendiente: Number(f.r_venta_pendiente ?? 0),
    premiado: Number(f.r_premiado),
    factor: Number(f.r_factor),
    pago: num(f.r_pago),
    porcentaje: Number(f.r_porcentaje),
    comision: Number(f.r_comision),
    bruto: Number(f.r_bruto),
    neto: num(f.r_neto),
    sinLiquidar: Boolean(f.r_tiene_pendiente),
  }));

  const sinMovimiento = todas.filter((f) => f.venta === 0).length;
  const filas = soloConVenta ? todas.filter((f) => f.venta > 0) : todas;

  // Los totales sólo suman lo que existe: una fila sin liquidar no aporta a
  // premios ni a neto, y `hayNeto` recuerda si alguna aportó algo. Sin eso, un
  // día entero sin liquidar daría un total de 0 indistinguible de un día
  // liquidado que no dejó nada.
  const total = todas.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      pendiente: a.pendiente + f.pendiente,
      premiado: a.premiado + f.premiado,
      pago: a.pago + (f.pago ?? 0),
      comision: a.comision + f.comision,
      bruto: a.bruto + f.bruto,
      neto: a.neto + (f.neto ?? 0),
      hayNeto: a.hayNeto || f.neto !== null,
    }),
    { venta: 0, pendiente: 0, premiado: 0, pago: 0, comision: 0, bruto: 0, neto: 0, hayNeto: false },
  );

  const pct = (v: number) => (total.venta ? `${((v / total.venta) * 100).toFixed(1)}% de la venta` : "—");

  const elegido = hora ? sorteos.find((s) => s.hora === hora) : undefined;
  const ganador = elegido?.estado === "liquidado" ? elegido.ganador : null;

  // «martes 1 de septiembre de 2026» → «Martes».
  const larga = fechaLarga(dia);
  const nombreDia = larga.slice(0, 1).toUpperCase() + larga.slice(1, larga.indexOf(" "));

  return (
    <div className="flex flex-col gap-4">
      <Tarjeta padding="14px 18px">
        <FiltrosDia
          dia={dia}
          hora={hora}
          sorteos={sorteos}
          soloConVenta={soloConVenta}
          sinMovimiento={sinMovimiento}
        />
      </Tarjeta>

      {/* El panel del sorteo: qué salió y qué dejó. */}
      <Tarjeta padding="16px 18px">
        <div className="flex items-center gap-6 flex-wrap justify-between">
          <div className="flex items-center gap-4">
            <div>
              <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
                NÚMERO GANADOR
              </span>
              {ganador === null ? (
                <span className="block text-ganador font-semibold text-mudo mt-[5px]">—</span>
              ) : (
                <span className="inline-block mt-[5px] min-w-[62px] text-center px-3 py-[2px] rounded-campo bg-acento-suave text-acento-fuerte text-ganador font-semibold tracking-titular">
                  {pad2(ganador)}
                </span>
              )}
            </div>

            <div className="border-l border-riel pl-4">
              <span className="block text-h2 font-semibold tracking-sutil">
                {nombreDia}
                {hora && <span className="text-secundario font-medium"> · {jornada(hora)}</span>}
              </span>
              <span className="block text-meta text-secundario mt-[2px]">
                {larga}
                {hora ? ` · ${hora12(hora)}` : " · los tres sorteos"}
              </span>
            </div>
          </div>

          <div className="flex gap-7 flex-wrap">
            <Cifra etiqueta="VENTA TOTAL" valor={fmt(total.venta)} />
            <Cifra
              etiqueta="PAGO PREMIOS"
              valor={total.hayNeto ? fmt(total.pago) : "—"}
              pie={total.hayNeto ? pct(total.pago) : "sin liquidar"}
            />
            <Cifra etiqueta="COMISIÓN" valor={fmt(total.comision)} pie={pct(total.comision)} />
            <Cifra
              etiqueta="TOTAL NETO"
              valor={total.hayNeto ? fmt(total.neto) : "—"}
              pie={total.hayNeto ? pct(total.neto) : "falta el número ganador"}
              color={
                !total.hayNeto ? "text-mudo" : total.neto < 0 ? "text-negativo" : "text-positivo"
              }
            />
          </div>
        </div>
      </Tarjeta>

      {/*
        Un sorteo sin liquidar devuelve el padrón entero en cero, no cero filas,
        así que el aviso de «no hay nada» de más abajo nunca se ve. Sin esta
        línea, elegir «Noche · sin resultado» enseña treinta filas en cero sin
        decir por qué, que se lee como una jornada desastrosa y no como una que
        todavía no ha terminado.
      */}
      {sorteos.length === 0 ? (
        <TarjetaNota>
          Ese día no tiene sorteos programados, así que no hay nada que capturar.
        </TarjetaNota>
      ) : elegido && elegido.estado !== "liquidado" ? (
        <TarjetaNota>
          El sorteo de la {jornada(elegido.hora).toLowerCase()} todavía no está liquidado
          {elegido.estado === "abierto" ? " — sigue abierto" : ""}. Sin número ganador no hay
          premios que contar: las filas de abajo salen en cero porque aún no hay resultado, no
          porque nadie haya vendido.
        </TarjetaNota>
      ) : hora === "" && !sorteos.some((x) => x.estado === "liquidado") ? (
        <TarjetaNota>
          Ninguno de los tres sorteos de ese día está liquidado todavía.
        </TarjetaNota>
      ) : null}

      {error ? (
        <TarjetaNota>No se pudo cargar el informe: {error.message}</TarjetaNota>
      ) : filas.length === 0 ? (
        <TarjetaNota>
          {soloConVenta && sinMovimiento > 0
            ? `Ningún vendedor movió nada aquí; hay ${sinMovimiento} en cero que el filtro está ocultando.`
            : elegido && elegido.estado !== "liquidado"
              ? `El sorteo de la ${jornada(elegido.hora).toLowerCase()} todavía no está liquidado: sin número ganador no hay premios que contar, y por eso no hay cifras.`
              : "No hay ningún sorteo liquidado en este día. El informe se arma desde las liquidaciones, así que un sorteo sin número ganador todavía no cuenta."}
        </TarjetaNota>
      ) : (
        <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-tabla min-w-[980px]">
              <thead>
                {/* Subtotales arriba, como en reportes: son del filtro entero,
                    no de lo que se alcance a ver sin desplazarse. */}
                <tr className="bg-tinte">
                  <th
                    colSpan={2}
                    className="text-left pl-4 pr-3 py-[11px] border-b border-riel text-th font-semibold tracking-subtotal text-secundario"
                  >
                    TOTALES · {todas.length} vendedores
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.venta, false)}
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.premiado, false)}
                  </th>
                  <th className="border-b border-riel" />
                  <th className="border-b border-riel" />
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {total.hayNeto ? fmt(total.pago, false) : "—"}
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.comision, false)}
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.bruto, false)}
                  </th>
                  <th
                    className={cn(
                      "text-right pl-3 pr-4 py-[11px] border-b border-riel text-h2 font-semibold",
                      total.hayNeto && total.neto < 0 && "text-negativo",
                    )}
                  >
                    {total.hayNeto ? fmt(total.neto, false) : "—"}
                  </th>
                </tr>

                <tr className="bg-tinte">
                  {ENCABEZADOS.map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                        i >= 2 ? "text-right" : "text-left",
                        i === 0 ? "pl-4 pr-3" : i === ENCABEZADOS.length - 1 ? "pl-3 pr-4" : "px-3",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filas.map((f, i) => (
                  <tr
                    key={f.id}
                    className={cn(
                      "hover:bg-tinte",
                      // Presente pero apagado: que esté en cero es la noticia;
                      // que compita por la mirada, no.
                      f.venta === 0 && "text-mudo",
                    )}
                  >
                    <td className="border-b border-fondo py-[10px] pl-4 pr-3 text-secundario">
                      {i + 1}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3">
                      <span className="block font-medium">{f.nombre}</span>
                      <span className="block text-label text-secundario">{f.codigo}</span>
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right font-medium">
                      {fmt(f.venta, false)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo">
                      {fmt(f.premiado, false)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-secundario">
                      {f.factor > 0 ? f.factor.toFixed(0) : "—"}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-secundario">
                      {(f.porcentaje * 100).toFixed(2)}%
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo">
                      {f.pago === null ? <span className="text-mudo">—</span> : fmt(f.pago, false)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo">
                      {fmt(f.comision, false)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right">
                      {fmt(f.bruto, false)}
                    </td>
                    {/*
                      El total neto es lo que el gerente busca: negro si esa
                      fila deja dinero, rojo si lo quita. Es la única columna
                      que cambia de color, para que el ojo caiga en ella.
                    */}
                    <td
                      className={cn(
                        "border-b border-fondo py-[10px] pl-3 pr-4 text-right font-semibold",
                        f.neto === null ? "text-mudo" : f.neto < 0 ? "text-negativo" : "text-tinta",
                      )}
                    >
                      {/* Sin liquidar no hay neto: «—» y no un cero, que se
                          leería como «no dejó nada» en vez de «aún no se sabe». */}
                      {f.neto === null ? "—" : fmt(f.neto, false)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-[13px] bg-tinte border-t border-riel text-meta text-cuerpo leading-[1.55]">
            <strong className="text-tinta">Total neto</strong> = venta − comisión − pago premiado.
            Es lo que la casa gana o pierde con ese vendedor en este sorteo. El{" "}
            <strong className="text-tinta">factor</strong> y el{" "}
            <strong className="text-tinta">porcentaje</strong> son los efectivos, calculados de lo
            que de verdad ocurrió: cada línea lleva congelados los suyos, así que pueden no ser un
            número redondo.
          </div>
        </div>
      )}
    </div>
  );
}
