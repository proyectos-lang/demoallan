import { cn } from "@/lib/cn";
import { fechaLarga, fmt, hora12, jornada, pad2 } from "@/lib/format";

export type FilaLiquidacion = {
  liquidacionId: string;
  fecha: string;
  hora: string;
  ganador: number | null;
  venta: number;
  comision: number;
  premios: number;
  /** venta − comisión − premios. */
  saldo: number;
  /**
   * Cuándo se liquidó ese sorteo, si ya se liquidó.
   *
   * Los liquidados YA NO DESAPARECEN de la tabla: la semana se mira entera y
   * ellos salen marcados. Antes se caían de la vista en cuanto se cobraban y
   * con ellos se caía la venta de esos días, así que la hoja de una semana a
   * medias no se parecía a la semana que el vendedor había jugado.
   */
  pagadoEn?: string | null;
  /** Lo apostado al número que salió, y el multiplicador de ese sorteo. */
  premiado?: number;
  factor?: number;
};

export type Seleccion = {
  marcados: Set<string>;
  alternar: (id: string) => void;
  alternarDia: (delDia: FilaLiquidacion[]) => void;
};

/** Los sorteos agrupados por día, en el orden en que llegan. */
export function agruparPorDia(filas: FilaLiquidacion[]): [string, FilaLiquidacion[]][] {
  const mapa = new Map<string, FilaLiquidacion[]>();
  for (const f of filas) {
    const lista = mapa.get(f.fecha) ?? [];
    lista.push(f);
    mapa.set(f.fecha, lista);
  }
  return [...mapa.entries()];
}

/**
 * La rejilla de sorteos de una semana, día a día.
 *
 * Compacta a propósito: una semana son veintiún sorteos y con la fila alta no
 * cabía una semana entera en pantalla. El día no es una columna ancha repetida
 * tres veces sino una fila de grupo, que es además donde tienen sentido la
 * casilla que marca el día entero y el subtotal.
 *
 * SIN `seleccion` ES DE SÓLO LECTURA. Es la misma tabla que ve el vendedor en
 * su portal, donde no hay nada que marcar porque no puede liquidar. Vive en un
 * solo sitio a propósito: dos tablas que enseñan el mismo dinero acaban
 * diciendo cosas distintas en cuanto una se corrige y la otra no.
 */
export function TablaSorteos({
  filas,
  seleccion,
}: {
  filas: FilaLiquidacion[];
  seleccion?: Seleccion;
}) {
  const porDia = agruparPorDia(filas);
  const marcada = (id: string) => (seleccion ? seleccion.marcados.has(id) : true);

  const encabezados = ["SORTEO", "GANADOR", "VENTA", "COMISIÓN", "PREMIOS", "SALDO"];

  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          "w-full border-collapse text-tabla",
          seleccion ? "min-w-[620px]" : "min-w-[560px]",
        )}
      >
        <thead>
          <tr className="bg-tinte">
            {seleccion && <th className="border-b border-riel py-[8px] pl-4 pr-2 w-9" />}
            {encabezados.map((th, i) => (
              <th
                key={th}
                className={cn(
                  "text-th font-semibold tracking-th text-secundario border-b border-riel py-[8px]",
                  i >= 2 ? "text-right" : "text-left",
                  i === 0 && !seleccion ? "pl-4 pr-3" : i === 5 ? "pl-3 pr-4" : "px-3",
                )}
              >
                {th}
              </th>
            ))}
          </tr>
        </thead>

        {porDia.map(([fecha, delDia]) => {
          // Sólo se puede marcar lo que sigue pendiente.
          const marcables = delDia.filter((f) => !f.pagadoEn);
          const marcadasDelDia = marcables.filter((f) => marcada(f.liquidacionId));
          // El subtotal es del DÍA entero, liquidado incluido: es el resumen de
          // lo que pasó ese día, no de lo que se va a cobrar ahora.
          const subtotal = delDia.reduce((a, f) => a + f.saldo, 0);
          const todos = marcables.length > 0 && marcadasDelDia.length === marcables.length;
          const algunos = marcadasDelDia.length > 0 && !todos;
          const cerradas = delDia.filter((f) => f.pagadoEn).length;

          return (
            <tbody key={fecha}>
              <tr className="bg-tinte">
                {seleccion && (
                  <td className="border-b border-riel py-[6px] pl-4 pr-2">
                    <input
                      type="checkbox"
                      checked={todos}
                      disabled={marcables.length === 0}
                      // El estado intermedio no se puede poner por atributo: es
                      // una propiedad del elemento y hay que escribirla.
                      ref={(el) => {
                        if (el) el.indeterminate = algunos;
                      }}
                      onChange={() => seleccion.alternarDia(marcables)}
                      aria-label={`Marcar el día ${fecha} entero`}
                      className="w-4 h-4 accent-[var(--color-acento)]"
                    />
                  </td>
                )}
                <td
                  colSpan={4}
                  className={cn(
                    "border-b border-riel py-[6px]",
                    seleccion ? "px-3" : "pl-4 pr-3",
                  )}
                >
                  <span className="text-meta font-semibold">{fechaLarga(fecha)}</span>
                  {seleccion && marcables.length > 0 && (
                    <span className="text-th text-secundario ml-2">
                      {marcadasDelDia.length} de {marcables.length}
                    </span>
                  )}
                  {cerradas > 0 && (
                    <span className="text-th text-positivo ml-2">
                      {cerradas === delDia.length
                        ? "liquidado"
                        : `${cerradas} liquidado${cerradas === 1 ? "" : "s"}`}
                    </span>
                  )}
                </td>
                <td
                  className={cn(
                    "border-b border-riel py-[6px] pl-3 pr-4 text-right text-meta font-semibold",
                    subtotal < 0 && "text-negativo",
                  )}
                >
                  {fmt(subtotal, false)}
                </td>
              </tr>

              {delDia.map((f) => (
                <tr
                  key={f.liquidacionId}
                  className={cn(
                    // Un sorteo ya liquidado se queda a la vista pero apagado:
                    // es historial, no trabajo pendiente.
                    f.pagadoEn ? "bg-tinte/60" : !marcada(f.liquidacionId) && "opacity-45",
                  )}
                >
                  {seleccion && (
                    <td className="border-b border-fondo py-[6px] pl-4 pr-2">
                      {f.pagadoEn ? (
                        <span className="block w-4 h-4" aria-hidden="true" />
                      ) : (
                        <input
                          type="checkbox"
                          checked={marcada(f.liquidacionId)}
                          onChange={() => seleccion.alternar(f.liquidacionId)}
                          aria-label={`Liquidar ${fecha} ${f.hora}`}
                          className="w-4 h-4 accent-[var(--color-acento)]"
                        />
                      )}
                    </td>
                  )}
                  <td
                    className={cn(
                      "border-b border-fondo py-[6px] text-cuerpo",
                      seleccion ? "px-3" : "pl-4 pr-3",
                    )}
                  >
                    {jornada(f.hora)}
                    <span className="text-th text-mudo ml-[6px]">{hora12(f.hora)}</span>
                    {f.pagadoEn && (
                      <span className="block text-th text-positivo font-medium">liquidado</span>
                    )}
                  </td>
                  <td className="border-b border-fondo py-[6px] px-3">
                    <span className="inline-block min-w-[28px] text-center px-[6px] py-px rounded-celda bg-acento-suave text-acento-fuerte text-meta font-semibold">
                      {f.ganador === null ? "—" : pad2(f.ganador)}
                    </span>
                  </td>
                  <td className="border-b border-fondo py-[6px] px-3 text-right">
                    {fmt(f.venta, false)}
                  </td>
                  <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                    {fmt(f.comision, false)}
                  </td>
                  <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                    {fmt(f.premios, false)}
                  </td>
                  <td
                    className={cn(
                      "border-b border-fondo py-[6px] pl-3 pr-4 text-right font-semibold",
                      f.saldo < 0 && "text-negativo",
                    )}
                  >
                    {fmt(f.saldo, false)}
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
