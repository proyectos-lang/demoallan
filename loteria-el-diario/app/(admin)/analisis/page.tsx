import {
  FiltrosAnalisis,
  type Grano,
  type OpcionVendedor,
  type Vista,
} from "@/components/analisis/filtros-analisis";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLarga, fmt, fmtK, hora12, hoyHonduras, iso, mesNombre, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const RANGO = /^\d{4}-\d{2}-\d{2}$/;
const GRANOS: Grano[] = ["sorteo", "dia", "semana", "mes", "anio"];

/**
 * Cuántas tarjetas se pintan como mucho.
 *
 * Sorteo por sorteo son tres tarjetas por día: un mes son noventa y un año
 * pasa de mil. Mil tarjetas no se leen —y el HTML de esa página se va a varios
 * megabytes, que es la clase de peso que ya obligó a quitar la precarga de la
 * barra lateral—. Se corta el DIBUJO, nunca la cuenta: los totales de arriba
 * se calculan sobre el rango entero y el aviso dice cuántas quedaron fuera.
 */
const TOPE_TARJETAS = 120;

const MESES_LARGOS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

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

/** El rótulo de una tarjeta, según cómo se esté partiendo el rango. */
function rotular(grano: Grano, inicio: string, fin: string): string {
  const [a, m, d] = inicio.split("-").map(Number);
  if (grano === "anio") return String(a);
  // La hora no va en el rótulo sino en el chip de la derecha: «martes 4 de
  // agosto de 2026 · 3:00 PM» no cabe en una tarjeta de 298 px.
  if (grano === "sorteo") return fechaLarga(inicio);
  if (grano === "mes") return `${MESES_LARGOS[m - 1]} ${a}`;
  if (grano === "dia") return fechaLarga(inicio);

  // Semana: «3 – 9 de agosto». Si cruza de mes se nombran los dos.
  const [, m2, d2] = fin.split("-").map(Number);
  return m === m2
    ? `${d} – ${d2} de ${MESES_LARGOS[m - 1]}`
    : `${d} ${mesNombre(m - 1)} – ${d2} ${mesNombre(m2 - 1)}`;
}

/**
 * Análisis de resultados.
 *
 * Las tarjetas mes por mes del simulador son la forma en que este negocio lee
 * un resultado, pero allí comparan un escenario inventado contra lo real. Aquí
 * se mira lo real y ya, con el grano que se pida: una semana día por día, un
 * mes semana por semana, un año mes por mes.
 *
 * La comparación no desaparece, cambia de eje: en vez de real contra simulado,
 * cada tarjeta se compara con el período ANTERIOR de la misma serie. Es lo que
 * uno quiere saber al mirar un resultado — si va mejor o peor que el anterior.
 */
export default async function AnalisisPage({ searchParams }: PageProps<"/analisis">) {
  const supabase = await crearClienteServidor();
  const params = await searchParams;

  const hoy = hoyHonduras();
  const lunes = lunesDe(hoy);
  const mes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const finDeMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);

  const vistas: Vista[] = [
    {
      etiqueta: "Esta semana, día a día",
      desde: iso(lunes),
      hasta: iso(sumarDias(lunes, 6)),
      grano: "dia",
    },
    {
      etiqueta: "Semana pasada, día a día",
      desde: iso(sumarDias(lunes, -7)),
      hasta: iso(sumarDias(lunes, -1)),
      grano: "dia",
    },
    {
      etiqueta: "Este mes, semana a semana",
      desde: iso(mes),
      hasta: iso(finDeMes),
      grano: "semana",
    },
    {
      etiqueta: "Mes anterior, semana a semana",
      desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)),
      hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 0)),
      grano: "semana",
    },
    {
      etiqueta: "Este año, mes a mes",
      desde: iso(new Date(hoy.getFullYear(), 0, 1)),
      hasta: iso(new Date(hoy.getFullYear(), 11, 31)),
      grano: "mes",
    },
  ];

  const texto = (k: string, omision: string) => {
    const v = params[k];
    return typeof v === "string" && RANGO.test(v) ? v : omision;
  };

  let desde = texto("desde", vistas[4].desde);
  let hasta = texto("hasta", vistas[4].hasta);
  if (desde > hasta) [desde, hasta] = [hasta, desde];

  const granoPedido = typeof params.grano === "string" ? params.grano : "";
  const grano: Grano = GRANOS.includes(granoPedido as Grano) ? (granoPedido as Grano) : "mes";

  const horaPedida = typeof params.hora === "string" ? params.hora : "";
  const hora = ["11:00", "15:00", "20:00"].includes(horaPedida) ? horaPedida : "";
  const vendedorPedido = typeof params.vendedor === "string" ? params.vendedor : "";

  // El padrón va PRIMERO y la consulta después, a propósito, aunque sean dos
  // viajes en vez de uno: el filtro se valida contra la lista real antes de
  // llegar a la base. Corriendo en paralelo, un `?vendedor=` inventado en la
  // dirección viajaba tal cual y postgres rechazaba el uuid, dejando la
  // pantalla en «No se pudo cargar». Además así el filtro que se ENSEÑA es
  // siempre el que se APLICÓ, que es lo que hace creíble una cifra.
  const { data: vendedores } = await supabase
    .from("vendedor")
    .select("id, codigo, nombre")
    .order("codigo");

  const vendedor = (vendedores ?? []).find((v) => v.id === vendedorPedido);
  const vendedorId = vendedor?.id ?? "";

  const { data, error } = await supabase.rpc("fn_analisis_resultados", {
    p_desde: desde,
    p_hasta: hasta,
    p_grano: grano,
    p_vendedor_id: vendedorId || null,
    p_hora: (hora || null) as never,
  });

  const periodos = (data ?? []).map((f) => ({
    inicio: f.r_inicio,
    fin: f.r_fin,
    hora: f.r_hora,
    ganador: f.r_numero_ganador,
    dias: Number(f.r_dias),
    sorteos: Number(f.r_sorteos),
    venta: Number(f.r_venta),
    comision: Number(f.r_comision),
    premios: Number(f.r_premios),
    utilidad: Number(f.r_utilidad),
  }));

  const total = periodos.reduce(
    (a, p) => ({
      venta: a.venta + p.venta,
      comision: a.comision + p.comision,
      premios: a.premios + p.premios,
      utilidad: a.utilidad + p.utilidad,
      dias: a.dias + p.dias,
      sorteos: a.sorteos + p.sorteos,
    }),
    { venta: 0, comision: 0, premios: 0, utilidad: 0, dias: 0, sorteos: 0 },
  );

  /*
   * Los días NO se suman con el grano de sorteo.
   *
   * Cada tarjeta trae los días que abarca, y en los demás cortes eso se puede
   * sumar porque dos semanas no comparten un día. Tres sorteos sí comparten el
   * suyo: sumarlos diría «55 días» donde hay diecinueve. A ese grano los días
   * son las fechas distintas.
   */
  const dias =
    grano === "sorteo"
      ? new Set(periodos.map((p) => p.inicio)).size
      : total.dias;

  const margen = total.venta ? (total.utilidad / total.venta) * 100 : 0;
  const visibles = periodos.slice(0, TOPE_TARJETAS);

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Análisis de resultados"
        subtitulo={
          <>
            Lo que de verdad ocurrió, partido como haga falta. Sólo entran sorteos ya
            liquidados: la utilidad de uno sin número ganador no existe todavía, y contarlo con
            los premios en cero inflaría el margen del período en curso.
            {vendedor && ` · ${vendedor.codigo} ${vendedor.nombre}`}
            {hora && ` · lotería de las ${hora12(hora)}`}
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <FiltrosAnalisis
          desde={desde}
          hasta={hasta}
          grano={grano}
          vendedorId={vendedorId}
          hora={hora}
          vistas={vistas}
          vendedores={(vendedores ?? []) as OpcionVendedor[]}
        />

        {/* El resultado del rango entero, antes de partirlo. */}
        <div
          className="rounded-hero px-[22px] py-5 text-nav-titulo"
          style={{ background: "var(--gradiente-sim)" }}
        >
          <div className="flex justify-between items-start gap-5 flex-wrap mb-4">
            <div>
              <span className="block text-eyebrow font-semibold tracking-seccion text-navy-tenue">
                TOTAL DEL RANGO
              </span>
              <span className="block text-pos-lg font-semibold tracking-sutil mt-[6px]">
                {periodos.length} {periodos.length === 1 ? "período" : "períodos"} ·{" "}
                {dias} {dias === 1 ? "día" : "días"} · {total.sorteos} sorteos
              </span>
            </div>
            <div className="text-right">
              <span className="block text-meta text-navy-tenue">Utilidad del rango</span>
              <span
                className={cn(
                  "block text-sim font-semibold tracking-titular mt-1",
                  total.utilidad < 0 ? "text-negativo-suave" : "text-positivo-claro",
                )}
              >
                {fmt(total.utilidad)}
              </span>
              <span className="block text-micro text-navy-tenue mt-[2px]">
                margen {margen.toFixed(2)}%
              </span>
            </div>
          </div>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(168px,1fr))]">
            {[
              { etiqueta: "Venta bruta", valor: total.venta },
              { etiqueta: "Comisiones", valor: total.comision },
              { etiqueta: "Premios pagados", valor: total.premios },
            ].map((k) => (
              <div
                key={k.etiqueta}
                className="bg-white/10 border border-white/15 rounded-pos px-[15px] py-[13px]"
              >
                <span className="block text-label text-navy-suave">{k.etiqueta}</span>
                <span className="block text-pos-xl font-semibold tracking-sutil mt-[7px]">
                  {fmt(k.valor)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <TarjetaNota>No se pudo cargar el análisis: {error.message}</TarjetaNota>
        ) : periodos.length === 0 ? (
          <TarjetaNota>
            No hay ningún sorteo liquidado en este rango con esos filtros.
          </TarjetaNota>
        ) : (
          <>
            <h2 className="text-h2 font-semibold tracking-sutil mt-2 mb-0">
              {grano === "sorteo"
                ? "Sorteo por sorteo"
                : grano === "dia"
                  ? "Día por día"
                  : grano === "semana"
                    ? "Semana por semana"
                    : grano === "mes"
                      ? "Mes por mes"
                      : "Año por año"}
            </h2>

            <div className="grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(298px,1fr))]">
              {visibles.map((p, i) => {
                const anterior = i > 0 ? periodos[i - 1] : null;
                const dif = anterior ? p.utilidad - anterior.utilidad : null;
                const margenP = p.venta ? (p.utilidad / p.venta) * 100 : 0;

                const filas: [string, string][] = [
                  ["Venta bruta", fmt(p.venta, false)],
                  ["Comisiones", fmt(p.comision, false)],
                  ["Premios", fmt(p.premios, false)],
                ];

                return (
                  <Tarjeta key={`${p.inicio}-${p.hora ?? ""}`} padding="16px 18px">
                    <div className="flex justify-between items-baseline border-b border-riel pb-3 gap-3">
                      <span className="text-cta font-semibold tracking-sutil">
                        {rotular(grano, p.inicio, p.fin)}
                      </span>
                      {/* A la derecha, lo que distingue a esta tarjeta de la
                          de al lado: la lotería si el corte es por sorteo
                          —donde «1 día» sería siempre igual y no diría nada—,
                          y si no, cuánto abarca. */}
                      <span className="text-micro text-secundario flex-none">
                        {p.hora ? hora12(p.hora) : `${p.dias} ${p.dias === 1 ? "día" : "días"}`}
                      </span>
                    </div>

                    <div className="grid [grid-template-columns:1fr_auto] gap-x-3 gap-y-[7px] mt-3">
                      {/* A este grano la tarjeta es un sorteo, así que hay un
                          número y es el que explica los premios de abajo. La
                          misma píldora que en el reporte del vendedor: un
                          número ganador se ve igual en todo el sistema. */}
                      {p.ganador !== null && (
                        <>
                          <span className="text-tabla text-secundario">Número ganador</span>
                          <span className="text-right">
                            <span className="inline-block min-w-[30px] text-center px-[7px] py-[2px] rounded-celda bg-acento-suave text-acento-fuerte font-semibold">
                              {pad2(p.ganador)}
                            </span>
                          </span>
                        </>
                      )}

                      {filas.map(([etiqueta, valor]) => (
                        <Fila key={etiqueta} etiqueta={etiqueta} valor={valor} />
                      ))}

                      <span className="text-tabla font-medium border-t border-riel pt-2">
                        Utilidad neta
                      </span>
                      <span
                        className={cn(
                          "text-card font-semibold text-right border-t border-riel pt-2",
                          p.utilidad < 0 ? "text-negativo" : "text-tinta",
                        )}
                      >
                        {fmt(p.utilidad, false)}
                      </span>

                      <span className="text-tabla text-secundario">Margen</span>
                      <span
                        className={cn(
                          "text-tabla text-right",
                          margenP < 0 ? "text-negativo" : "text-cuerpo",
                        )}
                      >
                        {margenP.toFixed(2)}%
                      </span>
                    </div>

                    {/*
                      El pie compara con el período ANTERIOR de la misma serie,
                      que es lo que uno quiere saber al mirar un resultado. En
                      el simulador este mismo sitio compara contra el escenario
                      inventado; aquí no hay escenario, hay historia.
                    */}
                    <div className="flex justify-between border-t border-riel mt-3 pt-3">
                      <span className="text-tabla text-secundario">
                        {dif === null ? "Primero del rango" : "Contra el anterior"}
                      </span>
                      <strong
                        className={cn(
                          "text-card font-semibold",
                          dif === null
                            ? "text-mudo"
                            : dif < 0
                              ? "text-negativo"
                              : "text-positivo",
                        )}
                      >
                        {dif === null ? "—" : `${dif > 0 ? "+" : ""}${fmtK(dif)}`}
                      </strong>
                    </div>
                  </Tarjeta>
                );
              })}
            </div>

            {periodos.length > visibles.length && (
              <TarjetaNota>
                Se dibujan las primeras {visibles.length} de {periodos.length} tarjetas. Las
                cifras de arriba sí son del rango completo — lo que se recorta es el dibujo, no
                la cuenta. Para ver el resto, acorte el rango o suba el corte a un grano más
                grueso.
              </TarjetaNota>
            )}
          </>
        )}
      </div>
    </Pagina>
  );
}

/** Una fila etiqueta–valor de la tarjeta. */
function Fila({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <>
      <span className="text-tabla text-secundario">{etiqueta}</span>
      <span className="text-tabla text-right text-cuerpo">{valor}</span>
    </>
  );
}
