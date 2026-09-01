import {
  FiltrosInforme,
  type Atajo,
  type DiaDelRango,
} from "@/components/informe/filtros-informe";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLarga, fechaLargaSinDia, fmt, hora12, hoyHonduras, iso, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const RANGO = /^\d{4}-\d{2}-\d{2}$/;

const HORAS = ["11:00", "15:00", "20:00"] as const;
const esHora = (v: string): v is (typeof HORAS)[number] => HORAS.some((h) => h === v);

/** El lunes de la semana de una fecha. La semana del negocio va lunes a domingo. */
function lunesDe(d: Date): Date {
  const copia = new Date(d);
  copia.setDate(copia.getDate() - ((copia.getDay() + 6) % 7));
  return copia;
}

function sumarDias(d: Date, n: number): Date {
  const copia = new Date(d);
  copia.setDate(copia.getDate() + n);
  return copia;
}

/**
 * El informe de gerencia.
 *
 * Es la pestaña DASHBOARD de la hoja que el gerente abre cada mañana, con las
 * mismas columnas y en el mismo orden, para cualquier rango. Lo que cambia es
 * que las cifras salen de la base en vez de teclearse: la hoja se armaba a
 * mano cada semana desde veintiuna pestañas —tres sorteos por siete días.
 *
 * «Regalado» no está, por decisión del negocio. «Pasados» tampoco: en las
 * ciento cinco filas de la hoja de referencia sale en cero.
 */
export async function VistaDiaria({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const supabase = await crearClienteServidor();

  const hoy = hoyHonduras();
  const ayer = sumarDias(hoy, -1);
  const lunes = lunesDe(hoy);
  const mes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const mesAnterior = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);

  const atajos: Atajo[] = [
    { etiqueta: "Hoy", grupo: "Día", desde: iso(hoy), hasta: iso(hoy) },
    { etiqueta: "Ayer", grupo: "Día", desde: iso(ayer), hasta: iso(ayer) },
    {
      etiqueta: "Esta semana",
      grupo: "Semana",
      desde: iso(lunes),
      hasta: iso(sumarDias(lunes, 6)),
    },
    {
      etiqueta: "Semana pasada",
      grupo: "Semana",
      desde: iso(sumarDias(lunes, -7)),
      hasta: iso(sumarDias(lunes, -1)),
    },
    {
      etiqueta: "Hace dos semanas",
      grupo: "Semana",
      desde: iso(sumarDias(lunes, -14)),
      hasta: iso(sumarDias(lunes, -8)),
    },
    { etiqueta: "Este mes", grupo: "Mes", desde: iso(mes), hasta: iso(hoy) },
    {
      etiqueta: "Mes anterior",
      grupo: "Mes",
      desde: iso(mesAnterior),
      hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)),
    },
  ];

  const texto = (k: string, omision: string) => {
    const v = params[k];
    return typeof v === "string" && RANGO.test(v) ? v : omision;
  };

  let desde = texto("desde", atajos[2].desde);
  let hasta = texto("hasta", atajos[2].hasta);
  if (desde > hasta) [desde, hasta] = [hasta, desde];

  // Por omisión salen todos, como en la hoja. `?conventa=1` deja sólo a los
  // que movieron algo.
  const soloConVenta = params.conventa === "1";

  /*
   * El desglose dentro del rango.
   *
   * El día no necesita parámetro en la base: un día es un rango de un día, así
   * que se estrecha la consulta. El rango original se conserva en la URL
   * porque es lo que dibuja la tira de días.
   *
   * Un día fuera del rango se ignora: llegaría de una dirección vieja y daría
   * una tabla vacía sin explicar por qué.
   */
  const horaPedida = typeof params.hora === "string" ? params.hora : "";
  const diaPedido = texto("dia", "");
  const dia = diaPedido >= desde && diaPedido <= hasta ? diaPedido : "";

  // Un predicado de tipo y no un `includes` suelto: `includes` devuelve un
  // booleano y deja `hora` como `string`, y entonces cada uso contra la base
  // necesita un `as`. Así la comprobación que ya se hacía también estrecha el
  // tipo, y no queda ni un molde en el archivo.
  const hora = esHora(horaPedida) ? horaPedida : "";

  /*
   * Los días del rango, para la tira.
   *
   * Con más de dos meses la tira deja de servir —sesenta y tantas fichas no se
   * leen de un vistazo— y se esconde: para eso están los atajos de semana.
   */
  const DIAS_MAX = 62;
  const dias: DiaDelRango[] = [];
  const cursor = new Date(`${desde}T00:00:00`);
  const fin = new Date(`${hasta}T00:00:00`);
  while (cursor <= fin && dias.length <= DIAS_MAX) {
    const f = iso(cursor);
    // «lun 3» — el día de la semana en tres letras y el número, que es como se
    // nombra un día cuando se tiene la semana delante.
    const larga = fechaLarga(f);
    dias.push({
      fecha: f,
      etiqueta: `${larga.slice(0, 3)} ${cursor.getDate()}`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const tiraDeDias = dias.length <= DIAS_MAX ? dias : [];

  /*
   * El número ganador sólo tiene sentido con UN día y UNA lotería elegidos.
   * En un rango hay tantos números como sorteos y enseñar uno cualquiera
   * sería peor que no enseñar ninguno.
   */
  const { data: sorteoUnico } =
    dia && hora
      ? await supabase
          .from("sorteo")
          .select("numero_ganador")
          .eq("fecha", dia)
          .eq("hora", hora)
          .maybeSingle()
      : { data: null };

  const ganador = sorteoUnico?.numero_ganador ?? null;

  const { data, error } = await supabase.rpc("fn_informe_gerencia", {
    p_desde: dia || desde,
    p_hasta: dia || hasta,
    p_hora: hora || null,
  });

  const todas = (data ?? []).map((f) => ({
    id: f.r_vendedor_id,
    codigo: f.r_codigo,
    nombre: f.r_nombre,
    venta: Number(f.r_venta),
    premiado: Number(f.r_premiado),
    factor: Number(f.r_factor),
    pago: Number(f.r_pago),
    porcentaje: Number(f.r_porcentaje),
    comision: Number(f.r_comision),
    bruto: Number(f.r_bruto),
    neto: Number(f.r_neto),
  }));

  const sinMovimiento = todas.filter((f) => f.venta === 0).length;
  const filas = soloConVenta ? todas.filter((f) => f.venta > 0) : todas;

  /*
   * Los totales se calculan sobre TODAS las filas, no sobre las visibles.
   *
   * Da lo mismo aritméticamente —quien no vendió aporta ceros—, pero deja el
   * encabezado inmune al filtro: encender el interruptor no puede mover la
   * venta total ni el resultado del período, y así se ve que el filtro sólo
   * esconde filas, no cambia las cuentas.
   */
  const total = todas.reduce(
    (a, f) => ({
      venta: a.venta + f.venta,
      premiado: a.premiado + f.premiado,
      pago: a.pago + f.pago,
      comision: a.comision + f.comision,
      bruto: a.bruto + f.bruto,
      neto: a.neto + f.neto,
    }),
    { venta: 0, premiado: 0, pago: 0, comision: 0, bruto: 0, neto: 0 },
  );

  const encabezados = [
    "ITEM",
    "VENDEDOR",
    "VENTA",
    "PREMIADO",
    "FACTOR",
    "PAGO PREMIADO",
    "%",
    "COMISIÓN",
    "TOTAL BRUTO",
    "TOTAL NETO",
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* El período que se está mirando, en palabras. Los chips de abajo lo
        dicen en fragmentos; esta línea lo dice entero. */}
      <p className="text-tabla text-secundario m-0">
      {dia
        ? fechaLarga(dia)
        : `${fechaLargaSinDia(desde)} — ${fechaLargaSinDia(hasta)}`}
      {hora ? ` · lotería de las ${hora12(hora)}` : " · las tres loterías"}
      {ganador !== null && (
        <>
          {" · número ganador "}
          <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
            {pad2(ganador)}
          </span>
        </>
      )}
      </p>
      <FiltrosInforme
        desde={desde}
        hasta={hasta}
        atajos={atajos}
        ocultarSinMovimiento={soloConVenta}
        sinMovimiento={sinMovimiento}
        dias={tiraDeDias}
        dia={dia}
        hora={hora}
      />

      {/* Los cinco números que el gerente busca primero, antes de la tabla. */}
      <div className="rounded-card px-[22px] py-5 text-nav-titulo" style={{ background: "var(--gradiente-dia)" }}>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
          {[
            { etiqueta: "VENTA TOTAL", valor: total.venta },
            { etiqueta: "COMISIONES", valor: total.comision },
            { etiqueta: "SUBTOTAL", valor: total.bruto },
            { etiqueta: "PREMIOS", valor: total.pago },
          ].map((k) => (
            <div key={k.etiqueta}>
              <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
                {k.etiqueta}
              </span>
              <span className="block text-h1 font-semibold tracking-titular mt-[6px]">
                {fmt(k.valor)}
              </span>
            </div>
          ))}
          <div>
            <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
              TOTAL FINAL
            </span>
            {/*
              El resultado del período. En negro si la casa gana y en rojo si
              pierde — sobre el marino, el rojo del sistema no llega al
              contraste mínimo, así que aquí la pérdida va en el rojo claro
              que ya se usa para las cifras negativas sobre fondo oscuro.
            */}
            <span
              className={cn(
                "block text-h1 font-semibold tracking-titular mt-[6px]",
                total.neto < 0 ? "text-negativo-claro" : "text-positivo-claro",
              )}
            >
              {fmt(total.neto)}
            </span>
          </div>
        </div>
      </div>

      {error ? (
        <TarjetaNota>No se pudo cargar el informe: {error.message}</TarjetaNota>
      ) : filas.length === 0 ? (
        <TarjetaNota>
          {soloConVenta && sinMovimiento > 0
            ? `Ningún vendedor movió nada en este rango; hay ${sinMovimiento} en cero que el filtro está ocultando.`
            : "No hay ningún sorteo liquidado en este rango. El informe se arma desde las liquidaciones, así que un sorteo sin número ganador todavía no cuenta."}
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
                    TOTALES DEL RANGO · {todas.length} vendedores
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.venta, false)}
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.premiado, false)}
                  </th>
                  <th className="border-b border-riel" />
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.pago, false)}
                  </th>
                  <th className="border-b border-riel" />
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.comision, false)}
                  </th>
                  <th className="text-right px-3 py-[11px] border-b border-riel text-h2 font-semibold">
                    {fmt(total.bruto, false)}
                  </th>
                  <th
                    className={cn(
                      "text-right pl-3 pr-4 py-[11px] border-b border-riel text-h2 font-semibold",
                      total.neto < 0 && "text-negativo",
                    )}
                  >
                    {fmt(total.neto, false)}
                  </th>
                </tr>

                <tr className="bg-tinte">
                  {encabezados.map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "text-th font-semibold tracking-th text-secundario border-b border-riel py-[9px]",
                        i >= 2 ? "text-right" : "text-left",
                        i === 0 ? "pl-4 pr-3" : i === encabezados.length - 1 ? "pl-3 pr-4" : "px-3",
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
                      // Presente pero apagado: que esté en cero es la
                      // noticia; que compita por la mirada, no.
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
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-cuerpo">
                      {fmt(f.pago, false)}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 text-right text-secundario">
                      {(f.porcentaje * 100).toFixed(2)}%
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
                        f.neto < 0 ? "text-negativo" : "text-tinta",
                      )}
                    >
                      {fmt(f.neto, false)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-[13px] bg-tinte border-t border-riel text-meta text-cuerpo leading-[1.55]">
            <strong className="text-tinta">Total neto</strong> = venta − comisión − pago
            premiado. Es lo que la casa gana o pierde con ese vendedor en el rango. El{" "}
            <strong className="text-tinta">factor</strong> y el{" "}
            <strong className="text-tinta">porcentaje</strong> son los efectivos del período,
            calculados de lo que de verdad ocurrió: cada línea lleva congelados los suyos, así
            que en un rango largo pueden no ser un número redondo.
          </div>
        </div>
      )}
    </div>
  );
}
