import { fechaLargaSinDia, hora12, jornada, pad2 } from "@/lib/format";

export type LineaImpresa = {
  fecha: string;
  hora: string;
  ganador: number | null;
  venta: number;
  comision: number;
  premios: number;
  saldo: number;
};

export type HojaImpresa = {
  vendedor: string;
  factor: number | null;
  /** La tasa vigente, como fracción: 0.15 = 15 %. */
  comisionTasa: number | null;
  desde: string;
  hasta: string;
  semana: number | null;
  lineas: LineaImpresa[];
  /** Sorteos de la semana que ya se pagaron y por eso no salen en el papel. */
  yaPagados: number;
};

/** `2,590.00`. Dos decimales, como la hoja que los vendedores ya conocen. */
function money(n: number): string {
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // U+2212, el menos de verdad: el guion del teclado se lee como un separador.
  return (n < 0 ? "−" : "") + s;
}

/** `dd/mm/aaaa`. */
function corta(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/** Nada de lo que entra aquí es de confianza: el nombre lo teclea alguien. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * La hoja de liquidación en papel.
 *
 * Devuelve un documento HTML completo y suelto, que se imprime dentro de un
 * marco aparte. NO usa el `@media print` de la aplicación a propósito: ese
 * bloque fija `@page { size: 58mm auto }` para el ticket térmico, y una hoja
 * de liquidación en un rollo de 58 mm no se puede leer. `@page` es del
 * documento entero y no se puede acotar a un elemento, así que la única forma
 * de tener dos formatos de papel en la misma aplicación es imprimir dos
 * documentos distintos. De paso, no hay manera de que un cambio de aquí
 * estropee la impresión del ticket, que costó varias rondas dejar bien.
 *
 * LO YA PAGADO NO SALE. La hoja se arma con lo que sigue pendiente, porque es
 * un documento de cobro: si un lunes ya se cobró, imprimirlo otra vez invita a
 * cobrarlo dos veces. Pero el papel DICE cuántos sorteos se omitieron —callarlo
 * haría pensar que faltan días por capturar.
 */
export function documentoLiquidacion(h: HojaImpresa): string {
  const total = h.lineas.reduce(
    (a, l) => ({
      venta: a.venta + l.venta,
      comision: a.comision + l.comision,
      premios: a.premios + l.premios,
      saldo: a.saldo + l.saldo,
    }),
    { venta: 0, comision: 0, premios: 0, saldo: 0 },
  );

  const entrega = total.saldo >= 0;

  // Una fila por sorteo, con la fecha escrita sólo en el primero del día: es
  // como está la hoja de papel y hace la columna mucho más fácil de recorrer.
  let ultimaFecha = "";
  const filas = h.lineas
    .map((l) => {
      const primera = l.fecha !== ultimaFecha;
      ultimaFecha = l.fecha;
      return `<tr${primera ? ' class="dia"' : ""}>
        <td class="f">${primera ? esc(fechaLargaSinDia(l.fecha)) : ""}</td>
        <td>${esc(jornada(l.hora))}</td>
        <td class="c">${l.ganador === null ? "&mdash;" : pad2(l.ganador)}</td>
        <td class="n">${money(l.venta)}</td>
        <td class="n">${money(l.comision)}</td>
        <td class="n">${money(l.premios)}</td>
        <td class="n b">${money(l.saldo)}</td>
      </tr>`;
    })
    .join("");

  const emitido = new Date();
  const sello = `${corta(
    `${emitido.getFullYear()}-${pad2(emitido.getMonth() + 1)}-${pad2(emitido.getDate())}`,
  )} ${hora12(`${pad2(emitido.getHours())}:${pad2(emitido.getMinutes())}`)}`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Liquidación · ${esc(h.vendedor)}</title>
<style>
  @page { size: A4 portrait; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Arial, sans-serif;
    font-size: 10.5pt;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 13pt; margin: 0; letter-spacing: -0.01em; }
  .sub { font-size: 8.5pt; color: #444; margin: 2px 0 0; }
  .cab {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 16px; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px;
  }
  .datos { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .datos td { padding: 4px 8px; border: 1px solid #999; font-size: 9.5pt; }
  .datos .et { background: #eee; font-weight: bold; width: 22%; }
  table.detalle { width: 100%; border-collapse: collapse; }
  table.detalle th {
    background: #eee; border: 1px solid #666; padding: 5px 6px;
    font-size: 8pt; letter-spacing: 0.05em; text-transform: uppercase;
  }
  table.detalle td { border: 1px solid #999; padding: 4px 6px; font-size: 9.5pt; }
  table.detalle tr.dia td { border-top: 1.5px solid #666; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.c, th.c { text-align: center; }
  td.f { white-space: nowrap; }
  td.b { font-weight: bold; }
  tfoot td { background: #eee; font-weight: bold; border-top: 1.5px solid #000; }
  .resumen { margin-top: 14px; width: 62%; border-collapse: collapse; }
  .resumen td { padding: 5px 8px; border: 1px solid #999; font-size: 10pt; }
  .resumen .et { background: #eee; font-weight: bold; }
  .resumen tr.saldo td { border-top: 2px solid #000; font-size: 12pt; font-weight: bold; }
  .nota { margin-top: 10px; font-size: 8.5pt; color: #444; line-height: 1.45; }
  .abonos { margin-top: 18px; width: 100%; border-collapse: collapse; }
  .abonos td { border: 1px solid #999; padding: 12px 8px; font-size: 9pt; }
  .abonos .et { background: #eee; font-weight: bold; width: 18%; padding: 6px 8px; }
  .firma { margin-top: 26px; display: flex; gap: 40px; }
  .firma div { flex: 1; border-top: 1px solid #000; padding-top: 4px; font-size: 8.5pt; }
</style></head><body>

<div class="cab">
  <div>
    <h1>Liquidación semanal</h1>
    <p class="sub">Sistema de Control de Tickets &middot; Cortés, Honduras</p>
  </div>
  <div style="text-align:right">
    <p class="sub">Emitido ${esc(sello)}</p>
  </div>
</div>

<table class="datos"><tbody>
  <tr>
    <td class="et">Vendedor</td><td>${esc(h.vendedor)}</td>
    <td class="et">Factor de premio</td><td>${h.factor === null ? "&mdash;" : h.factor.toFixed(2)}</td>
  </tr>
  <tr>
    <td class="et">Semana</td>
    <td>${h.semana === null ? "" : `#${h.semana} &middot; `}${esc(fechaLargaSinDia(h.desde))} &mdash; ${esc(fechaLargaSinDia(h.hasta))}</td>
    <td class="et">Comisión</td>
    <td>${h.comisionTasa === null ? "&mdash;" : `${(h.comisionTasa * 100).toFixed(2)} %`}</td>
  </tr>
</tbody></table>

<table class="detalle">
  <thead><tr>
    <th style="text-align:left">Fecha</th>
    <th style="text-align:left">Sorteo</th>
    <th class="c">Ganador</th>
    <th class="n">Venta</th>
    <th class="n">Comisión</th>
    <th class="n">Premios</th>
    <th class="n">Saldo</th>
  </tr></thead>
  <tbody>${filas}</tbody>
  <tfoot><tr>
    <td colspan="3">Totales</td>
    <td class="n">${money(total.venta)}</td>
    <td class="n">${money(total.comision)}</td>
    <td class="n">${money(total.premios)}</td>
    <td class="n">${money(total.saldo)}</td>
  </tr></tfoot>
</table>

<table class="resumen"><tbody>
  <tr><td class="et">Venta total</td><td class="n">L ${money(total.venta)}</td></tr>
  <tr><td class="et">Comisión</td><td class="n">L ${money(total.comision)}</td></tr>
  <tr><td class="et">Premios pagados</td><td class="n">L ${money(total.premios)}</td></tr>
  <tr class="saldo">
    <td class="et">${entrega ? "El vendedor entrega" : "La casa le entrega al vendedor"}</td>
    <td class="n">L ${money(Math.abs(total.saldo))}</td>
  </tr>
</tbody></table>

<p class="nota">
  El saldo es la venta menos la comisión menos los premios que el vendedor pagó de su bolsillo.
  ${
    h.yaPagados > 0
      ? `En esta hoja no aparecen ${h.yaPagados} ${h.yaPagados === 1 ? "sorteo ya liquidado" : "sorteos ya liquidados"} de esta misma semana: su cuenta ya se cerró y este documento es para cerrar la que queda.`
      : "Aparecen todos los sorteos liquidados de la semana; ninguno se ha cerrado todavía."
  }
</p>

<table class="abonos"><tbody>
  <tr><td class="et">Abono 1</td><td></td><td class="et">Fecha</td><td></td></tr>
  <tr><td class="et">Abono 2</td><td></td><td class="et">Fecha</td><td></td></tr>
  <tr><td class="et">Abono 3</td><td></td><td class="et">Fecha</td><td></td></tr>
</tbody></table>

<div class="firma">
  <div>Firma del vendedor</div>
  <div>Recibido por</div>
</div>

</body></html>`;
}
