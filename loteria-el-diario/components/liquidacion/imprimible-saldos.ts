import { fechaLargaSinDia, pad2 } from "@/lib/format";

export type FilaSaldo = {
  codigo: string;
  nombre: string;
  anterior: number;
  semana: number;
  liquidado: number;
  actual: number;
};

export type HojaSaldos = {
  semana: number | null;
  desde: string;
  hasta: string;
  filas: FilaSaldo[];
};

/** `2,590.00`, con el menos de verdad (U+2212) para los negativos. */
function money(n: number): string {
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n < 0 ? "−" : "") + s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * El cuadro de saldos del padrón, en papel.
 *
 * Documento suelto que se imprime en un marco aparte, por el mismo motivo que
 * la hoja de liquidación: el `@media print` de la aplicación fija `@page` en
 * 58 mm para el ticket térmico, y `@page` es del documento entero. Dos
 * formatos de papel obligan a dos documentos.
 *
 * Va en horizontal. Son cinco columnas de cifras por treinta y pico filas, y
 * en vertical la tabla cabe pero deja media hoja vacía a la derecha mientras
 * parte el padrón en dos páginas.
 *
 * EL ROJO SE IMPRIME. Con `print-color-adjust: exact` el navegador no lo
 * convierte en gris: sin eso, la única señal de que la empresa le debe a un
 * vendedor desaparece justo en el papel, que es donde se cobra.
 */
export function documentoSaldos(h: HojaSaldos): string {
  const total = h.filas.reduce(
    (a, f) => ({
      anterior: a.anterior + f.anterior,
      semana: a.semana + f.semana,
      liquidado: a.liquidado + f.liquidado,
      actual: a.actual + f.actual,
    }),
    { anterior: 0, semana: 0, liquidado: 0, actual: 0 },
  );

  const filas = h.filas
    .map(
      (f) => `<tr>
        <td>${esc(f.codigo)}</td>
        <td>${esc(f.nombre)}</td>
        <td class="n ${f.anterior < 0 ? "rojo" : ""}">${money(f.anterior)}</td>
        <td class="n ${f.semana < 0 ? "rojo" : ""}">${money(f.semana)}</td>
        <td class="n">${f.liquidado === 0 ? "&mdash;" : money(f.liquidado)}</td>
        <td class="n b ${f.actual < 0 ? "rojo" : ""}">${money(f.actual)}</td>
      </tr>`,
    )
    .join("");

  const hoy = new Date();
  const emitido = `${pad2(hoy.getDate())}/${pad2(hoy.getMonth() + 1)}/${hoy.getFullYear()}`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Saldos por vendedor · semana ${h.semana ?? ""}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 10pt;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .cab {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px;
  }
  h1 { font-size: 14pt; margin: 0; letter-spacing: -0.01em; }
  .sub { font-size: 9pt; color: #444; margin: 3px 0 0; }
  table { width: 100%; border-collapse: collapse; }
  th {
    background: #eee; border: 1px solid #666; padding: 5px 7px;
    font-size: 8pt; letter-spacing: 0.05em; text-transform: uppercase;
    text-align: left;
  }
  td { border: 1px solid #999; padding: 4px 7px; font-size: 9.5pt; }
  th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.b { font-weight: bold; }
  .rojo { color: #e11d48; }
  tfoot td { background: #eee; font-weight: bold; border-top: 1.5px solid #000; }
  .nota { margin-top: 10px; font-size: 8.5pt; color: #444; line-height: 1.45; }
  .firma { margin-top: 24px; display: flex; gap: 60px; }
  .firma div { flex: 1; border-top: 1px solid #000; padding-top: 4px; font-size: 8.5pt; }
</style></head><body>

<div class="cab">
  <div>
    <h1>Saldos por vendedor</h1>
    <p class="sub">
      ${h.semana === null ? "" : `Semana #${h.semana} &middot; `}${esc(fechaLargaSinDia(h.desde))} &mdash; ${esc(fechaLargaSinDia(h.hasta))}
    </p>
  </div>
  <div style="text-align:right">
    <p class="sub">Sistema de Control de Tickets &middot; Cort&eacute;s, Honduras</p>
    <p class="sub">Emitido ${esc(emitido)} &middot; ${h.filas.length} vendedores</p>
  </div>
</div>

<table>
  <thead><tr>
    <th style="width:9%">Código</th>
    <th>Vendedor</th>
    <th class="n" style="width:15%">Saldo anterior</th>
    <th class="n" style="width:15%">Saldo de la semana</th>
    <th class="n" style="width:15%">Liquidado</th>
    <th class="n" style="width:16%">Saldo actual</th>
  </tr></thead>
  <tbody>${filas}</tbody>
  <tfoot><tr>
    <td colspan="2">Totales &middot; ${h.filas.length} vendedores</td>
    <td class="n ${total.anterior < 0 ? "rojo" : ""}">${money(total.anterior)}</td>
    <td class="n ${total.semana < 0 ? "rojo" : ""}">${money(total.semana)}</td>
    <td class="n">${money(total.liquidado)}</td>
    <td class="n ${total.actual < 0 ? "rojo" : ""}">${money(total.actual)}</td>
  </tr></tfoot>
</table>

<p class="nota">
  <strong>Saldo anterior</strong> es lo que quedó sin liquidar de las semanas previas a ésta.
  <strong>Saldo de la semana</strong> es venta menos comisión menos premios de estos siete días, y
  <strong>liquidado</strong> la parte que ya se cerró en un corte. El <strong>saldo actual</strong>
  es el anterior más lo que falta de esta semana: es la cantidad que hay que cuadrar hoy con cada
  vendedor. En negro la entrega el vendedor; en rojo y en negativo la entrega la empresa, porque
  los premios que adelantó superaron su venta.
</p>

<div class="firma">
  <div>Elaborado por</div>
  <div>Revisado por</div>
</div>

</body></html>`;
}
