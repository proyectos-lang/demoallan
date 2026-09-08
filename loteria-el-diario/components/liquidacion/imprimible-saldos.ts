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
 * La hoja de cobro: la tabla y nada más.
 *
 * QUÉ LLEVA Y QUÉ NO
 * ------------------
 * Cuatro columnas —número, vendedor, saldo anterior, saldo actual— y ningún
 * adorno alrededor: ni encabezado, ni totales, ni firmas. Es la lista con la
 * que se sale a cobrar, se trabaja encima de ella, y todo lo que no sea una
 * fila de vendedor es sitio que le quita.
 *
 * La semana y la fecha no se imprimen a propósito: quien manda imprimir acaba
 * de elegirlas en la pantalla, y quien recibe el papel ya sabe de qué semana
 * le hablan. Ponerlas gasta una franja de hoja para contestar algo que nadie
 * está preguntando.
 *
 * La versión con encabezado, totales, firmas y las seis columnas de antes
 * sigue entera en `imprimible-saldos-detallado`.
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
 * DOS ORIENTACIONES. Sin encabezado ni pie, el vertical se lleva las filas que
 * antes ocupaban; el horizontal parte la lista en dos columnas de vendedores,
 * que es lo que ese formato permite y el vertical no.
 */
export function documentoSaldos(h: HojaSaldos): string {
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
   * Un A4 apaisado gana ancho y pierde alto: con cuatro columnas sobra la
   * mitad del papel a la derecha y las filas se derraman a una segunda página.
   * Se parte la lista por la mitad y se ponen dos tablas lado a lado, que es
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

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Saldos por vendedor${h.semana === null ? "" : ` · semana ${h.semana}`}</title>
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
  /*
     La cabecera de la tabla se repite en cada página.

     Es lo único del encabezado que sobrevive, y por un motivo distinto: sin
     ella, la segunda hoja son cuatro columnas de cifras sin decir cuál es
     cuál. La regla break-inside de abajo evita además que una fila se parta
     por la mitad entre dos páginas.
  */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }

  th.i, td.i { width: 6%; text-align: center; color: #555; font-size: 8pt; }
  th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; }
  th.n { width: 22%; }
  td.b { font-weight: bold; }
  .rojo { color: #c00; }
</style></head><body>

${cuerpo}

</body></html>`;
}
