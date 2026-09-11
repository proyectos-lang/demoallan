import {
  fechaHonduras,
  fechaLargaSinDia,
  hora12,
  horaHonduras12,
  jornada,
  pad2,
} from "@/lib/format";

export type LineaImpresa = {
  fecha: string;
  hora: string;
  ganador: number | null;
  venta: number;
  /** Lo APOSTADO al número que salió: premio ÷ factor. */
  premiado: number;
  /** El multiplicador efectivo de ese sorteo. */
  factor: number;
  comision: number;
  premios: number;
  saldo: number;
  /** Si ya se liquidó. El renglón se queda en el papel, marcado. */
  pagado: boolean;
};

export type AbonoImpreso = {
  pagadoEn: string;
  sorteos: number;
  /** La parte de ESTA semana. Cero en un pago que sólo saldó lo de atrás. */
  saldo: number;
  nota: string | null;
  /** Lo que ese pago cerró de semanas ANTERIORES. */
  arrastre?: number;
};

export type HojaImpresa = {
  vendedor: string;
  /** La tasa vigente, como fracción: 0.15 = 15 %. */
  comisionTasa: number | null;
  desde: string;
  hasta: string;
  semana: number | null;
  /** La semana ENTERA, liquidados incluidos. */
  lineas: LineaImpresa[];
  /** Los cierres que ya tocaron esta semana, para dejar constancia. */
  abonos: AbonoImpreso[];
  /**
   * Lo que quedó sin liquidar de las semanas ANTERIORES a ésta.
   *
   * Va en la cabecera y no en el resumen a propósito: es una deuda que el
   * vendedor trae puesta antes de que empiece esta hoja, y leerla al final
   * —después de haber sumado la semana— invita a confundirla con parte de
   * ella. Arriba se lee como lo que es: el punto de partida.
   */
  arrastre: number;
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

/**
 * `LUNES 31` y `AGOS 26` en dos líneas, como la hoja que ya se usa a mano.
 *
 * El NOMBRE DEL DÍA es lo que permite ubicarse al repasar la hoja con el
 * vendedor: se habla de «lo del martes», no de «lo del día 1». Y en dos líneas
 * porque la columna es estrecha y de una sola se partiría por donde cayera.
 */
function diaDeHoja(iso: string): { dia: string; mes: string } {
  const [a, m, d] = iso.split("-").map(Number);
  const DOW = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
  const MES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGOS", "SEP", "OCT", "NOV", "DIC"];
  return {
    dia: `${DOW[new Date(a, m - 1, d).getDay()]} ${pad2(d)}`,
    mes: `${MES[m - 1]} ${String(a).slice(2)}`,
  };
}

/** `dd/mm/aaaa`. */
function corta(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

/** `dd/mm/aaaa h:mm AM` a partir de un instante, en hora de Honduras. */
function instanteCorto(instante: string): string {
  const [a, m, d] = fechaHonduras(instante).split("-");
  return `${d}/${m}/${a} ${horaHonduras12(instante)}`;
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
      premiado: a.premiado + l.premiado,
      comision: a.comision + l.comision,
      premios: a.premios + l.premios,
      saldo: a.saldo + l.saldo,
    }),
    { venta: 0, premiado: 0, comision: 0, premios: 0, saldo: 0 },
  );

  // Lo liquidado y lo que falta, por separado: el total de la semana es la
  // suma de los dos y el vendedor tiene que poder seguir esa resta.
  const liquidado = h.lineas
    .filter((l) => l.pagado)
    .reduce((a, l) => a + l.saldo, 0);
  const pendiente = total.saldo - liquidado;

  /*
   * La cuenta completa: lo que falta de esta semana MÁS lo que se traía.
   *
   * Sin el arrastre, el pie de la hoja anuncia una cantidad que no es la que
   * se le va a pedir al vendedor, y él firma un papel que no cuadra con lo que
   * entrega. Cuando no hay arrastre —la primera semana, o todo al día— la
   * fila no se dibuja y el pendiente de la semana ES el cierre.
   */
  const conArrastre = Math.round(h.arrastre * 100) !== 0;
  const acumulado = pendiente + h.arrastre;
  const totalEntrega = acumulado >= 0;

  // Una fila por sorteo, con la fecha escrita sólo en el primero del día: es
  // como está la hoja de papel y hace la columna mucho más fácil de recorrer.
  /*
   * Una fila por sorteo, y tras los tres de cada día su GRAN TOTAL.
   *
   * El subtotal diario es lo que permite cuadrar día a día con el vendedor en
   * el mostrador; sin él hay que sumar tres renglones de cabeza, que es donde
   * aparecen las discusiones.
   *
   * La fecha se escribe sólo en el primer sorteo del día y abarca los tres con
   * `rowspan`, como el recuadro de la hoja de papel.
   */
  const porDia: { fecha: string; lineas: typeof h.lineas }[] = [];
  for (const l of h.lineas) {
    const ultimo = porDia[porDia.length - 1];
    if (ultimo && ultimo.fecha === l.fecha) ultimo.lineas.push(l);
    else porDia.push({ fecha: l.fecha, lineas: [l] });
  }

  const filas = porDia
    .map(({ fecha, lineas }) => {
      const { dia, mes } = diaDeHoja(fecha);
      const saldoDia = lineas.reduce((a, l) => a + l.saldo, 0);

      const renglones = lineas
        .map((l, i) => {
          const celdaFecha =
            i === 0
              ? `<td class="f" rowspan="${lineas.length}"><span class="d1">${esc(dia)}</span><span class="d2">${esc(mes)}</span></td>`
              : "";
          return `<tr class="${i === 0 ? "dia " : ""}${l.pagado ? "pagado" : ""}">
        ${celdaFecha}
        <td>${esc(jornada(l.hora))}${l.pagado ? ' <span class="sello">liquidado</span>' : ""}</td>
        <td class="c rojo b">${l.ganador === null ? "&mdash;" : pad2(l.ganador)}</td>
        <td class="n">${money(l.venta)}</td>
        <td class="n rojo">${l.premiado > 0 ? money(l.premiado) : "&mdash;"}</td>
        <td class="n rojo">${money(l.premios)}</td>
        <td class="n">${money(l.comision)}</td>
        <td class="n b ${l.saldo < 0 ? "rojo" : ""}">${money(l.saldo)}</td>
      </tr>`;
        })
        .join("");

      return `${renglones}<tr class="grantotal">
        <td colspan="7">Gran total</td>
        <td class="n b ${saldoDia < 0 ? "rojo" : ""}">${money(saldoDia)}</td>
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
  .datos .destacado { font-weight: bold; font-size: 11pt; }
  .datos .sub { font-weight: normal; font-size: 8.5pt; color: #555; }
  table.detalle { width: 100%; border-collapse: collapse; }
  table.detalle th {
    background: #eee; border: 1px solid #666; padding: 4px 6px;
    font-size: 8pt; letter-spacing: 0.05em; text-transform: uppercase;
  }
  table.detalle td { border: 1px solid #999; padding: 2.5px 6px; font-size: 9.5pt; }
  table.detalle tr.dia td { border-top: 1.5px solid #666; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.c, th.c { text-align: center; }
  /*
     La celda del día, como el recuadro de la hoja de papel: abarca los tres
     sorteos con rowspan, centrada y con el nombre del día encima de la fecha.
     Las dos líneas van en span de bloque porque un salto dentro de una celda
     con rowspan no centra igual en todos los navegadores.
  */
  td.f {
    white-space: nowrap;
    vertical-align: middle;
    text-align: center;
    font-weight: bold;
    font-size: 8.5pt;
    line-height: 1.25;
    background: #fafafa;
  }
  td.f .d1, td.f .d2 { display: block; }
  td.f .d2 { font-weight: normal; color: #444; }

  /* El gran total del día: se lee de un vistazo al repasar la hoja, así que
     va con fondo y una línea que lo separa del día siguiente. */
  tr.grantotal td {
    background: #f0ece2;
    font-weight: bold;
    font-size: 9pt;
    border-top: 1px solid #999;
  }
  tr.grantotal td:first-child {
    text-align: right;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #555;
  }
  td.b { font-weight: bold; }
  /*
     EL ROJO MARCA LO QUE TIENE QUE VER CON EL PREMIO: el número que salió, lo
     que se le apostó y lo que se pagó. Son las tres cifras que se leen juntas
     cuando alguien comprueba un premio, y en una columna de números todos
     iguales encontrarlas costaba recorrer la fila entera.

     Sigue marcando además los saldos negativos, que es lo que era antes. No
     se confunden: el saldo va en su columna, en negrita, y con el signo menos
     delante — que es lo que de verdad lo distingue en una fotocopia.

     Funciona porque el body lleva print-color-adjust en exacto: sin eso el
     navegador lo convierte en gris al imprimir y todo esto se pierde justo en
     el papel, que es donde se cobra.

     Sin acentos graves aquí dentro: este CSS vive en una plantilla de
     JavaScript y un acento grave cierra la cadena.
  */
  .rojo { color: #e11d48; }
  tr.pagado td { background: #f2f2f2; color: #555; }
  tr.pagado td.b { color: #555; }
  tr.pagado td.b.rojo { color: #b4415e; }
  .sello {
    font-size: 7pt; text-transform: uppercase; letter-spacing: 0.06em;
    border: 1px solid #888; border-radius: 3px; padding: 0 3px; color: #555;
  }
  tfoot td { background: #eee; font-weight: bold; border-top: 1.5px solid #000; }
  .resumen { margin-top: 10px; width: 62%; border-collapse: collapse; }
  .resumen td { padding: 4px 8px; border: 1px solid #999; font-size: 10pt; }
  .resumen .et { background: #eee; font-weight: bold; }
  .resumen tr.saldo td { border-top: 2px solid #000; font-size: 12pt; font-weight: bold; }
  .nota { margin-top: 10px; font-size: 8.5pt; color: #444; line-height: 1.45; }
  .abonos { margin-top: 12px; width: 100%; border-collapse: collapse; }
  .abonos td { border: 1px solid #999; padding: 4px 8px; font-size: 9pt; }
  .abonos .et { background: #eee; font-weight: bold; width: 18%; padding: 4px 8px; }
  .abonos .sub { color: #666; font-size: 8pt; }
  .firma { margin-top: 14px; display: flex; gap: 40px; }
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
    <td class="et">Comisión</td>
    <td>${h.comisionTasa === null ? "&mdash;" : `${(h.comisionTasa * 100).toFixed(2)} %`}</td>
  </tr>
  <tr>
    <td class="et">Semana</td>
    <td colspan="3">${h.semana === null ? "" : `#${h.semana} &middot; `}${esc(fechaLargaSinDia(h.desde))} &mdash; ${esc(fechaLargaSinDia(h.hasta))}</td>
  </tr>
  ${
    Math.round(h.arrastre * 100) === 0
      ? ""
      : `<tr>
          <td class="et">Saldo anterior</td>
          <td colspan="3" class="destacado ${h.arrastre < 0 ? "rojo" : ""}">L ${money(h.arrastre)}
            <span class="sub">
              &middot; ${
                h.arrastre < 0
                  ? "sin liquidar de semanas anteriores, lo entrega la empresa"
                  : "sin liquidar de semanas anteriores, lo entrega el vendedor"
              }
            </span>
          </td>
        </tr>`
  }
</tbody></table>

<table class="detalle">
  <thead><tr>
    <th style="text-align:left">Fecha</th>
    <th style="text-align:left">Sorteo</th>
    <th class="c">Ganador</th>
    <th class="n">Venta</th>
    <th class="n">Valor premiado</th>
    <th class="n">Premios</th>
    <th class="n">Comisión</th>
    <th class="n">Saldo</th>
  </tr></thead>
  <tbody>${filas}</tbody>
  <tfoot><tr>
    <td colspan="3">Totales</td>
    <td class="n">${money(total.venta)}</td>
    <td class="n rojo">${money(total.premiado)}</td>
    <td class="n rojo">${money(total.premios)}</td>
    <td class="n">${money(total.comision)}</td>
    <td class="n ${total.saldo < 0 ? "rojo" : ""}">${money(total.saldo)}</td>
  </tr></tfoot>
</table>

<table class="resumen"><tbody>
  <tr><td class="et">Venta total</td><td class="n">L ${money(total.venta)}</td></tr>
  <tr><td class="et">Comisión</td><td class="n rojo">L ${money(total.comision)}</td></tr>
  <tr><td class="et">Premios pagados</td><td class="n rojo">L ${money(total.premios)}</td></tr>
  <tr>
    <td class="et">Saldo de la semana</td>
    <td class="n ${total.saldo < 0 ? "rojo" : ""}">L ${money(total.saldo)}</td>
  </tr>
  ${
    liquidado === 0
      ? ""
      : `<tr><td class="et">Ya liquidado</td><td class="n">L ${money(liquidado)}</td></tr>`
  }
  <tr${conArrastre ? "" : ' class="saldo"'}>
    <td class="et">Pendiente de esta semana</td>
    <td class="n ${pendiente < 0 ? "rojo" : ""}">L ${money(pendiente)}</td>
  </tr>
  ${
    !conArrastre
      ? ""
      : `<tr>
          <td class="et">Saldo anterior</td>
          <td class="n ${h.arrastre < 0 ? "rojo" : ""}">L ${money(h.arrastre)}</td>
        </tr>
        <tr class="saldo">
          <td class="et">${totalEntrega ? "El vendedor entrega" : "La empresa le entrega"}</td>
          <td class="n ${acumulado < 0 ? "rojo" : ""}">L ${money(Math.abs(acumulado))}</td>
        </tr>`
  }
</tbody></table>

<p class="nota">
  El <strong>saldo</strong> es la venta menos la comisión menos los premios que el vendedor
  pagó de su bolsillo; el <strong>gran total</strong> de cada día suma sus tres sorteos. En
  rojo y en negativo, la empresa le debe a él.
  ${
    liquidado === 0
      ? ""
      : " Los renglones marcados <strong>liquidado</strong> ya se cerraron; se dejan a la vista para que la semana se vea completa."
  }
  ${
    conArrastre
      ? " El <strong>saldo anterior</strong> es lo que quedó de semanas previas: no entra en los totales de la tabla, pero sí en el cierre de abajo."
      : ""
  }
</p>

<table class="abonos"><tbody>
  ${
    h.abonos.length === 0
      ? `<tr><td class="et">Abono 1</td><td></td><td class="et">Fecha</td><td></td></tr>
         <tr><td class="et">Abono 2</td><td></td><td class="et">Fecha</td><td></td></tr>
         <tr><td class="et">Abono 3</td><td></td><td class="et">Fecha</td><td></td></tr>`
      : h.abonos
          .map(
            (a, i) => {
              /*
               * Un pago puede cerrar sorteos de esta semana, de anteriores, o
               * de las dos. Se dice CUÁNTO de cada cosa: si sólo se imprimiera
               * la parte de esta semana, un pago de arrastre saldría en cero y
               * parecería que no se cobró nada.
               */
              const deAtras = a.arrastre ?? 0;
              const total = a.saldo + deAtras;
              const detalle = [
                `${a.sorteos} ${a.sorteos === 1 ? "sorteo" : "sorteos"}`,
                deAtras !== 0 && a.saldo !== 0
                  ? `de los cuales L ${money(deAtras)} de semanas anteriores`
                  : deAtras !== 0
                    ? "de semanas anteriores"
                    : "",
                a.nota ?? "",
              ].filter(Boolean);
              return `<tr>
              <td class="et">Abono ${i + 1}</td>
              <td class="n b ${total < 0 ? "rojo" : ""}">L ${money(total)}</td>
              <td class="et">Fecha</td>
              <td>${esc(instanteCorto(a.pagadoEn))}<span class="sub"> &middot; ${detalle.map((d) => esc(d)).join(" &middot; ")}</span></td>
            </tr>`;
            },
          )
          .join("")
  }
</tbody></table>

<div class="firma">
  <div>Firma del vendedor</div>
  <div>Recibido por</div>
</div>

</body></html>`;
}
