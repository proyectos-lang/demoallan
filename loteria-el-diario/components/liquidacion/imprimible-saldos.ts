import { fechaLargaSinDia, pad2 } from "@/lib/format";

export type FilaSaldo = {
  codigo: string;
  nombre: string;
  anterior: number;
  semana: number;
  liquidado: number;
  actual: number;
};

export type Orientacion = "vertical" | "horizontal";

export type HojaSaldos = {
  semana: number | null;
  desde: string;
  hasta: string;
  filas: FilaSaldo[];
  orientacion: Orientacion;
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
 * La hoja de cobro: número, vendedor, saldo anterior y saldo actual.
 *
 * QUÉ ES Y PARA QUÉ SIRVE
 * -----------------------
 * Es la lista con la que se sale a cobrar, y se trabaja encima: se marca cada
 * vendedor al liquidarlo y se anota a mano lo que se acuerda. De ahí que sea
 * de tres columnas y no de seis — el saldo de la semana y lo ya liquidado son
 * datos de análisis, y en la calle sólo estorban la única cifra que importa:
 * cuánto tiene que entregar hoy este vendedor.
 *
 * La versión de seis columnas sigue existiendo en `imprimible-saldos-detallado`
 * por si hay que volver a ella.
 *
 * SIN COLORES DE FONDO, PERO CON EL ROJO
 * --------------------------------------
 * El fondo de color de cada vendedor se queda en la pantalla. En papel gasta
 * tóner, no sobrevive a una fotocopia y compite con lo que se escribe a mano
 * encima.
 *
 * El rojo del negativo SÍ se conserva, porque no es decoración: distingue al
 * vendedor que entrega dinero del que lo recibe, y confundirlos en el
 * mostrador cuesta caro. Va con `print-color-adjust: exact` para que el
 * navegador no lo convierta en gris al imprimir, y además con el signo menos
 * delante: si alguien fotocopia en blanco y negro, el signo sigue ahí.
 *
 * LA NUMERACIÓN ES CORRELATIVA, NO EL CÓDIGO
 * ------------------------------------------
 * 1, 2, 3… sobre el papel, como en la hoja que ya se usa. Sirve para cantar
 * la lista y para señalar una fila en voz alta —«el catorce»—, que con códigos
 * tipo `V-006` no se puede.
 *
 * EL SALDO ANTERIOR EN BLANCO CUANDO ES CERO
 * ------------------------------------------
 * La mayoría de vendedores no arrastran nada, y una columna llena de «0.00» no
 * dice nada y esconde los pocos que sí. En blanco, el ojo va directo a los que
 * traen deuda — y deja el hueco para anotar a mano, que es lo que se hace.
 *
 * DOS ORIENTACIONES. Con tres columnas el vertical cabe de sobra y es el que
 * se usará casi siempre; el horizontal se conserva porque con muchas filas
 * permite dos columnas de vendedores por hoja.
 */
export function documentoSaldos(h: HojaSaldos): string {
  const total = h.filas.reduce(
    (a, f) => ({ anterior: a.anterior + f.anterior, actual: a.actual + f.actual }),
    { anterior: 0, actual: 0 },
  );

  const fila = (f: FilaSaldo, i: number) => `<tr>
    <td class="i">${i + 1}</td>
    <td>${esc(f.nombre)}</td>
    <td class="n ${f.anterior < 0 ? "rojo" : ""}">${
      // Vacío, no «0.00»: quien no arrastra nada no tiene que ocupar la vista,
      // y el hueco sirve para escribir encima.
      f.anterior === 0 ? "" : money(f.anterior)
    }</td>
    <td class="n b ${f.actual < 0 ? "rojo" : ""}">L${money(f.actual)}</td>
  </tr>`;

  /*
   * En horizontal, dos columnas de vendedores por hoja.
   *
   * Un A4 apaisado gana ancho y pierde alto: con tres columnas sobra la mitad
   * del papel a la derecha y las filas se derraman a una segunda página. Se
   * parte la lista por la mitad y se ponen dos tablas lado a lado, que es
   * exactamente lo que ese formato permite y el vertical no.
   */
  const mitad = Math.ceil(h.filas.length / 2);
  const bloques =
    h.orientacion === "horizontal" && h.filas.length > 12
      ? [h.filas.slice(0, mitad), h.filas.slice(mitad)]
      : [h.filas];

  const tabla = (grupo: FilaSaldo[], desplazamiento: number) => `
    <table>
      <thead><tr>
        <th class="i">#</th>
        <th>Vendedor</th>
        <th class="n">Saldo anterior</th>
        <th class="n">Saldo actual</th>
      </tr></thead>
      <tbody>${grupo.map((f, i) => fila(f, desplazamiento + i)).join("")}</tbody>
    </table>`;

  const cuerpo =
    bloques.length === 2
      ? `<div class="dos">${tabla(bloques[0], 0)}${tabla(bloques[1], mitad)}</div>`
      : tabla(bloques[0], 0);

  const hoy = new Date();
  const emitido = `${pad2(hoy.getDate())}/${pad2(hoy.getMonth() + 1)}/${hoy.getFullYear()}`;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Saldos por vendedor · semana ${h.semana ?? ""}</title>
<style>
  @page { size: A4 ${h.orientacion === "vertical" ? "portrait" : "landscape"}; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Helvetica Neue", Arial, sans-serif;
    color: #000;
    /* Sin esto el navegador convierte el rojo en gris al imprimir, y con él
       se pierde la única señal de quién cobra en vez de pagar. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .cab {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #000;
    padding-bottom: ${h.orientacion === "vertical" ? "6px" : "4px"};
    margin-bottom: ${h.orientacion === "vertical" ? "10px" : "7px"};
  }
  h1 { font-size: 13pt; margin: 0; letter-spacing: -0.01em; }
  .sub { font-size: 8.5pt; color: #444; margin: 2px 0 0; }

  /* Las dos tablas del formato apaisado, lado a lado. */
  .dos { display: flex; gap: 14px; align-items: flex-start; }
  .dos table { flex: 1; }

  table { width: 100%; border-collapse: collapse; }
  th {
    background: #eee; border: 1px solid #555;
    padding: ${h.orientacion === "vertical" ? "4px 6px" : "3px 5px"};
    font-size: 8pt; letter-spacing: 0.04em; text-transform: uppercase;
    text-align: left;
  }
  td {
    border: 1px solid #999;
    padding: ${h.orientacion === "vertical" ? "3.5px 6px" : "1.5px 5px"};
    font-size: ${h.orientacion === "vertical" ? "9.5pt" : "8pt"};
  }
  /* Al partirse en páginas, la cabecera se repite: una tabla de cifras sin
     encabezado no se puede leer. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }

  th.i, td.i { width: 6%; text-align: center; color: #555; font-size: 8pt; }
  th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
  th.n { width: 22%; }
  td.b { font-weight: bold; }
  .rojo { color: #c00; }

  tfoot td { background: #eee; font-weight: bold; border-top: 1.5px solid #000; }
  .pie {
    margin-top: ${h.orientacion === "vertical" ? "12px" : "8px"};
    display: flex; justify-content: space-between; align-items: flex-end;
    gap: 40px;
  }
  .tot { font-size: 10pt; font-weight: bold; }
  .tot span { font-weight: normal; font-size: 8.5pt; color: #444; }
  .firma { display: flex; gap: 50px; flex: 1; max-width: 60%; }
  .firma div { flex: 1; border-top: 1px solid #000; padding-top: 3px; font-size: 8pt; }
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

${cuerpo}

<div class="pie">
  <div class="tot">
    Total a cuadrar: L${money(total.actual)}<br>
    <span>De semanas anteriores: L${money(total.anterior)} &middot; en rojo, lo que entrega la empresa</span>
  </div>
  <div class="firma">
    <div>Elaborado por</div>
    <div>Recibido por</div>
  </div>
</div>

</body></html>`;
}
