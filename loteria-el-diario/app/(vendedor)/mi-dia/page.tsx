import { redirect } from "next/navigation";

import { fechaHonduras, fechaLarga, fmt, hora12, horaHonduras12, pad2 } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Mis ventas del día.
 *
 * Vivía debajo del punto de venta, y allí estorbaba: mientras hay una cola, lo
 * único que importa es registrar. Aquí es lo contrario — se entra a propósito,
 * a mirar cómo va el día.
 */
export default async function MiDiaPage() {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  const vendedorId = sesion.vendedor_id;
  const supabase = await crearClienteServidor();
  const hoy = fechaHonduras();

  // Todo va filtrado por `vendedorId`, que sale de la SESIÓN y no de la
  // petición. Es la diferencia entre ver lo suyo y ver lo de todos.
  const [{ data: dia }, { data: tickets }] = await Promise.all([
    supabase.rpc("fn_mi_dia", { p_vendedor_id: vendedorId, p_fecha: hoy }),
    supabase.rpc("fn_mis_tickets", { p_vendedor_id: vendedorId, p_fecha: hoy, p_limite: 25 }),
  ]);

  const filas = dia ?? [];
  const venta = filas.reduce((a, f) => a + Number(f.r_venta), 0);
  const comision = filas.reduce((a, f) => a + Number(f.r_comision), 0);
  const premios = filas.reduce((a, f) => a + Number(f.r_premios), 0);
  const nTickets = filas.reduce((a, f) => a + f.r_tickets, 0);

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-[820px] mx-auto">
      <div>
        <h1 className="text-h1 font-semibold tracking-titular m-0">Mis ventas del día</h1>
        <p className="text-meta text-secundario mt-[5px] mb-0">{fechaLarga(hoy)}</p>
      </div>

      {/* Lo que gana hoy, que es lo primero que quiere saber. */}
      <div
        className="rounded-card px-[22px] py-5 text-nav-titulo"
        style={{ background: "var(--gradiente-dia)" }}
      >
        <span className="block text-eyebrow font-semibold tracking-seccion text-navy-etiqueta">
          MI COMISIÓN DE HOY
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
          { etiqueta: "VENDIDO HOY", valor: fmt(venta) },
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

      {/* Sus tickets del día, para poder responder «¿me registró usted esto?». */}
      {(tickets?.length ?? 0) > 0 && (
        <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
          <div className="px-[22px] py-4 border-b border-fondo">
            <h2 className="text-h2 font-semibold tracking-sutil m-0">Mis tickets de hoy</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[560px]">
            <thead>
              <tr className="bg-tinte">
                {["HORA", "FOLIO", "SORTEO", "LÍNEAS", "TOTAL", "PREMIO"].map((h, i) => (
                  <th
                    key={h}
                    className={`text-th font-semibold tracking-seccion text-secundario px-4 py-[10px] ${i > 2 ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(tickets ?? []).map((t) => (
                <tr key={t.r_folio} className="border-t border-fondo">
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
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
