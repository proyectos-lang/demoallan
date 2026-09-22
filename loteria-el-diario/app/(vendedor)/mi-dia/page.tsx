import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { redirect } from "next/navigation";

import { AnularMiVenta } from "@/components/vendedor/anular-mi-venta";
import { CorregirMiVenta } from "@/components/vendedor/corregir-mi-venta";
import { ReimprimirTicket } from "@/components/vendedor/reimprimir-ticket";
import { fechaHonduras, fechaLarga, fmt, hora12, horaHonduras12, pad2 } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Suma (o resta) días a una fecha `YYYY-MM-DD` sin pasar por UTC. */
function correrDia(iso: string, dias: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const x = new Date(a, m - 1, d + dias);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/**
 * Mis ventas del día.
 *
 * Vivía debajo del punto de venta, y allí estorbaba: mientras hay una cola, lo
 * único que importa es registrar. Aquí es lo contrario — se entra a propósito,
 * a mirar cómo va el día.
 *
 * SE PUEDE RETROCEDER A DÍAS ANTERIORES, pero sólo para MIRAR y REIMPRIMIR. En
 * un día pasado no se corrige ni se anula: esas acciones ya se limitan solas a
 * un sorteo abierto, y aquí además se ocultan, para que quede claro que el
 * histórico es de sólo lectura. La fecha llega por la URL (`?dia=`) y nunca
 * puede ser futura.
 */
export default async function MiDiaPage({ searchParams }: PageProps<"/mi-dia">) {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();
  const hoy = fechaHonduras();

  const params = await searchParams;
  const pedido = typeof params.dia === "string" ? params.dia : "";
  // La fecha que se mira: la pedida si es válida y no futura, si no, hoy.
  const dia = FECHA.test(pedido) && pedido <= hoy ? pedido : hoy;
  const esHoy = dia === hoy;
  const anterior = correrDia(dia, -1);
  const siguiente = correrDia(dia, 1);

  // Página de tickets. Cuarenta por página; la primera es la 1.
  const POR_PAGINA = 40;
  const pagPedida = typeof params.pag === "string" ? parseInt(params.pag, 10) : 1;
  const pagina = Number.isFinite(pagPedida) && pagPedida > 0 ? pagPedida : 1;

  // Cuántos tickets tiene ese día en total, para saber cuántas páginas hay. Es
  // un conteo barato, filtrado por el vendedor de la sesión.
  const { count: totalTickets } = await supabase
    .from("ticket")
    .select("id, sorteo:sorteo_id!inner(fecha)", { count: "exact", head: true })
    .eq("vendedor_id", vendedorId)
    .eq("sorteo.fecha", dia);

  const totales = totalTickets ?? 0;
  const paginas = Math.max(1, Math.ceil(totales / POR_PAGINA));
  const pagActual = Math.min(pagina, paginas);
  const desde = (pagActual - 1) * POR_PAGINA;

  // Todo va filtrado por `vendedorId`, que sale de la SESIÓN y no de la
  // petición. Es la diferencia entre ver lo suyo y ver lo de todos.
  const [{ data: resumenDia }, ticketsRes] = await Promise.all([
    supabase.rpc("fn_mi_dia", { p_vendedor_id: vendedorId, p_fecha: dia }),
    supabase.rpc("fn_mis_tickets", {
      p_vendedor_id: vendedorId,
      p_fecha: dia,
      p_limite: POR_PAGINA,
      p_desde: desde,
    }),
  ]);

  /*
   * Respaldo si la base aún no tiene la 0127 (p_desde). El despliegue de la
   * app y el de la base son dos gestos distintos; si el código llega primero,
   * PostgREST no encuentra la firma con `p_desde` (PGRST202) y la lista se
   * caería. Se reintenta sin paginar —se ve la primera página— hasta que la
   * migración esté.
   */
  let tickets = ticketsRes.data;
  if (ticketsRes.error?.code === "PGRST202") {
    const r = await supabase.rpc("fn_mis_tickets", {
      p_vendedor_id: vendedorId,
      p_fecha: dia,
      p_limite: POR_PAGINA,
    });
    tickets = r.data;
  }

  const filas = resumenDia ?? [];
  // Enlace a otra página conservando el día que se mira.
  const enlacePagina = (p: number) =>
    `/mi-dia?${esHoy ? "" : `dia=${dia}&`}pag=${p}`;
  const venta = filas.reduce((a, f) => a + Number(f.r_venta), 0);
  const comision = filas.reduce((a, f) => a + Number(f.r_comision), 0);
  const premios = filas.reduce((a, f) => a + Number(f.r_premios), 0);
  const nTickets = filas.reduce((a, f) => a + f.r_tickets, 0);

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-[820px] mx-auto">
      <div>
        <h1 className="text-h1 font-semibold tracking-titular m-0">
          {esHoy ? "Mis ventas del día" : "Mis ventas"}
        </h1>
        {/*
          Navegar entre días. La flecha de retroceder siempre está; la de
          avanzar sólo hasta hoy —no hay ventas del futuro que mirar—. En un día
          pasado se ofrece volver a hoy de un toque.
        */}
        <div className="mt-[6px] flex items-center gap-2 flex-wrap">
          <Link
            href={`/mi-dia?dia=${anterior}`}
            aria-label="Día anterior"
            className="inline-flex items-center justify-center w-8 h-8 rounded-campo border border-borde bg-superficie hover:border-acento hover:text-acento"
          >
            <ChevronLeft size={18} strokeWidth={2} />
          </Link>
          <span className="text-meta text-secundario min-w-0">{fechaLarga(dia)}</span>
          {esHoy ? (
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center w-8 h-8 rounded-campo border border-borde/60 text-mudo opacity-40"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </span>
          ) : (
            <Link
              href={`/mi-dia?dia=${siguiente}`}
              aria-label="Día siguiente"
              className="inline-flex items-center justify-center w-8 h-8 rounded-campo border border-borde bg-superficie hover:border-acento hover:text-acento"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </Link>
          )}
          {!esHoy && (
            <Link
              href="/mi-dia"
              className="text-meta text-acento font-medium ml-1"
            >
              Volver a hoy
            </Link>
          )}
        </div>
      </div>

      {!esHoy && (
        <div className="rounded-banner bg-panel border border-borde px-[14px] py-[10px] text-meta text-secundario leading-[1.5]">
          Estás viendo un día anterior. Aquí sólo puedes <strong>mirar y reimprimir</strong>{" "}
          tickets; corregir o anular sólo se puede el mismo día, con el sorteo abierto.
        </div>
      )}

      {/* Lo que gana hoy, que es lo primero que quiere saber. */}
      <div
        className="rounded-card px-[22px] py-5 text-nav-titulo"
        style={{ background: "var(--gradiente-dia)" }}
      >
        <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
          {esHoy ? "MI COMISIÓN DE HOY" : "MI COMISIÓN DEL DÍA"}
        </span>
        <span className="block text-tile font-semibold tracking-titular mt-1">
          {fmt(comision)}
        </span>
        <span className="block text-meta text-navy-pie mt-2">
          sobre {fmt(venta)} vendidos en {nTickets} {nTickets === 1 ? "ticket" : "tickets"}
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        {[
          { etiqueta: esHoy ? "VENDIDO HOY" : "VENDIDO", valor: fmt(venta) },
          { etiqueta: "TICKETS", valor: String(nTickets) },
          { etiqueta: "PREMIOS PAGADOS", valor: fmt(premios) },
        ].map((k) => (
          <div
            key={k.etiqueta}
            className="flex-1 basis-[150px] bg-superficie border border-borde rounded-card shadow-card px-4 py-[14px]"
          >
            <span className="block text-eyebrow font-semibold tracking-seccion text-mudo">
              {k.etiqueta}
            </span>
            <span className="block text-h1 font-semibold tracking-titular mt-1">{k.valor}</span>
          </div>
        ))}
      </div>

      {/* Sorteo por sorteo. El premio sólo aparece cuando está liquidado: antes
          de eso el sorteo no tiene número ganador y decir otra cosa sería
          inventar. */}
      <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
        {/* El desplazamiento horizontal vive en la tabla, no en la página. */}
        <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[420px]">
          <thead>
            <tr className="bg-tinte">
              {["SORTEO", "ESTADO", "VENDIDO", "COMISIÓN", "PREMIOS"].map((h, i) => (
                <th
                  key={h}
                  className={`text-th font-semibold tracking-seccion text-secundario px-4 py-[10px] ${i > 1 ? "text-right" : "text-left"}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.r_sorteo_id} className="border-t border-fondo">
                <td className="px-4 py-[11px] text-tabla font-medium">{hora12(f.r_hora)}</td>
                <td className="px-4 py-[11px] text-meta text-secundario">
                  {f.r_estado === "liquidado"
                    ? `ganó el ${pad2(f.r_ganador ?? 0)}`
                    : f.r_estado === "abierto"
                      ? "en venta"
                      : "cerrado · pendiente"}
                </td>
                <td className="px-4 py-[11px] text-tabla text-right">{fmt(Number(f.r_venta))}</td>
                <td className="px-4 py-[11px] text-tabla text-right">{fmt(Number(f.r_comision))}</td>
                <td className="px-4 py-[11px] text-tabla text-right">
                  {f.r_estado === "liquidado" ? fmt(Number(f.r_premios)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Un día anterior sin ventas: se dice, en vez de dejar la pantalla en
          blanco como si algo hubiera fallado. */}
      {!esHoy && (tickets?.length ?? 0) === 0 && (
        <div className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-6 text-center text-meta text-secundario">
          No registraste ninguna venta el {fechaLarga(dia)}.
        </div>
      )}

      {/* Sus tickets del día, para poder responder «¿me registró usted esto?». */}
      {(tickets?.length ?? 0) > 0 && (
        <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
          <div className="px-[22px] py-4 border-b border-fondo flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              {esHoy ? "Mis tickets de hoy" : "Mis tickets del día"}
            </h2>
            {totales > POR_PAGINA && (
              <span className="text-meta text-secundario">
                {totales} tickets · página {pagActual} de {paginas}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[640px]">
            <thead>
              <tr className="bg-tinte">
                {["HORA", "FOLIO", "SORTEO", "LÍNEAS", "TOTAL", "PREMIO", ""].map((h, i) => (
                  <th
                    key={h || "acciones"}
                    className={`text-th font-semibold tracking-seccion text-secundario px-4 py-[10px] ${i > 2 && i < 6 ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(tickets ?? []).map((t) => (
                <tr key={t.r_ticket_id} className="border-t border-fondo">
                  <td className="px-4 py-[10px] text-meta text-secundario">
                    {horaHonduras12(t.r_creado_en)}
                  </td>
                  <td className="px-4 py-[10px] text-meta">{t.r_folio}</td>
                  <td className="px-4 py-[10px] text-meta text-secundario">{hora12(t.r_hora)}</td>
                  <td className="px-4 py-[10px] text-tabla text-right">{t.r_lineas}</td>
                  <td className="px-4 py-[10px] text-tabla text-right">
                    {t.r_anulado ? <s>{fmt(Number(t.r_total))}</s> : fmt(Number(t.r_total))}
                  </td>
                  <td className="px-4 py-[10px] text-tabla text-right">
                    {Number(t.r_premio) > 0 ? fmt(Number(t.r_premio)) : "—"}
                  </td>
                  {/* Reimprimir vive en su propia columna, al final de la fila:
                      es una acción, no un dato, y mezclarla con las cifras
                      invita al clic accidental sobre la fila equivocada. */}
                  <td className="px-4 py-[10px] text-right whitespace-nowrap">
                    <span className="inline-flex items-center gap-3">
                      <ReimprimirTicket folio={t.r_folio} />
                      {/*
                        Quitar sólo donde se puede: sorteo abierto y venta
                        viva. Ofrecerlo en las demás para que la base rechace
                        la mitad enseñaría a esperar errores, y quien los
                        espera deja de leerlos.
                      */}
                      {/*
                        Corregir y anular SÓLO el mismo día. En un día anterior
                        el histórico es de sólo lectura: la reimpresión queda,
                        estas dos no. (Además ya se limitan al sorteo abierto,
                        que en un día pasado no existe; ocultarlas lo deja
                        explícito.)
                      */}
                      {esHoy && t.r_estado === "abierto" && !t.r_anulado && (
                        <>
                          {/*
                            Corregir va ANTES de anular, y no por orden
                            alfabético: es la acción que casi siempre se
                            quiere. Un monto mal tecleado se arregla
                            cambiándolo, no borrando la venta entera y
                            volviendo a teclear las otras once líneas. Poner
                            primero la salida destructiva invita a usarla.
                          */}
                          <CorregirMiVenta
                            ticketId={t.r_ticket_id}
                            folio={t.r_folio}
                            sorteo={hora12(t.r_hora)}
                            jugada={t.r_jugada ?? ""}
                          />
                          <AnularMiVenta
                            ticketId={t.r_ticket_id}
                            folio={t.r_folio}
                            sorteo={hora12(t.r_hora)}
                            total={fmt(Number(t.r_total))}
                          />
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {/* Pasar de página. Sólo aparece si hay más de una. */}
          {paginas > 1 && (
            <div className="px-[22px] py-3 border-t border-fondo flex items-center justify-between gap-3">
              {pagActual > 1 ? (
                <Link
                  href={enlacePagina(pagActual - 1)}
                  className="inline-flex items-center gap-1.5 text-meta text-acento font-medium"
                >
                  <ChevronLeft size={16} strokeWidth={2} />
                  Anteriores
                </Link>
              ) : (
                <span className="text-meta text-mudo opacity-40">Anteriores</span>
              )}
              <span className="text-meta text-secundario">
                {pagActual} / {paginas}
              </span>
              {pagActual < paginas ? (
                <Link
                  href={enlacePagina(pagActual + 1)}
                  className="inline-flex items-center gap-1.5 text-meta text-acento font-medium"
                >
                  Más antiguos
                  <ChevronRight size={16} strokeWidth={2} />
                </Link>
              ) : (
                <span className="text-meta text-mudo opacity-40">Más antiguos</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
