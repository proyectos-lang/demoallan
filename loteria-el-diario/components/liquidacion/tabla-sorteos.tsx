"use client";

import { useState } from "react";

import { CeldaEditable } from "@/components/liquidacion/celda-editable";
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
   * Si el sorteo tiene tickets con números vivos. Esos NO se editan a mano
   * desde la hoja —su venta es la suma de tickets reales, atada al cupo y al
   * premiado— y se corrigen desde la venta. Sólo los de venta por totales
   * (`tieneLineas` falso) son editables aquí.
   */
  tieneLineas?: boolean;
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

/**
 * Edición manual de venta/premios, sólo en la hoja del administrador. Cuando se
 * pasa, las celdas de venta y premios de los sorteos POR TOTALES se editan en el
 * sitio; `onEditar` manda las dos cifras a la base y devuelve la fila rehecha.
 */
export type Edicion = {
  onEditar: (
    liquidacionId: string,
    venta: number,
    premios: number,
  ) => Promise<{ ok: boolean; venta: number; comision: number; premios: number; saldo: number; mensaje?: string }>;
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
  edicion,
}: {
  filas: FilaLiquidacion[];
  seleccion?: Seleccion;
  edicion?: Edicion;
}) {
  const marcada = (id: string) => (seleccion ? seleccion.marcados.has(id) : true);

  /*
   * Copia local editable: al guardar una celda, la base devuelve la fila
   * rehecha —venta, comisión, premios, saldo— y se sobrescribe aquí para que la
   * tabla la pinte al instante, sin esperar a que la página revalide. Si la
   * página se recarga, `filas` vuelve a mandar.
   */
  const [locales, setLocales] = useState<Record<string, Partial<FilaLiquidacion>>>({});
  const [guardando, setGuardando] = useState<Set<string>>(new Set());
  const [errorEdicion, setErrorEdicion] = useState("");

  const conLocal = (f: FilaLiquidacion): FilaLiquidacion => ({ ...f, ...locales[f.liquidacionId] });

  const guardar = async (
    id: string,
    campo: "venta" | "premios",
    fila: FilaLiquidacion,
    nuevo: number,
  ) => {
    if (!edicion) return;
    setErrorEdicion("");
    setGuardando((s) => new Set(s).add(id));
    const actual = conLocal(fila);
    const venta = campo === "venta" ? nuevo : actual.venta;
    const premios = campo === "premios" ? nuevo : actual.premios;
    const r = await edicion.onEditar(id, venta, premios);
    setGuardando((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    if (!r.ok) {
      setErrorEdicion(r.mensaje ?? "No se pudo guardar el cambio.");
      return;
    }
    setLocales((prev) => ({
      ...prev,
      [id]: { venta: r.venta, comision: r.comision, premios: r.premios, saldo: r.saldo },
    }));
  };

  const filasVista = filas.map(conLocal);
  const porDia = agruparPorDia(filasVista);

  const encabezados = ["SORTEO", "GANADOR", "VENTA", "COMISIÓN", "PREMIOS", "SALDO"];

  return (
    <div className="overflow-x-auto">
      {errorEdicion && (
        <div className="m-3 rounded-banner bg-negativo-fondo text-negativo-texto px-[13px] py-[10px] text-tabla font-medium">
          {errorEdicion}
        </div>
      )}
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
                  {(() => {
                    // Editable sólo en la hoja del administrador (hay `edicion`)
                    // y sólo en sorteos por totales: los que tienen tickets con
                    // números se corrigen desde la venta, no aquí.
                    const editable = Boolean(edicion) && !f.tieneLineas;
                    const enCurso = guardando.has(f.liquidacionId);
                    return (
                      <>
                        <td className="border-b border-fondo py-[6px] px-3 text-right">
                          {editable ? (
                            <CeldaEditable
                              valor={f.venta}
                              guardando={enCurso}
                              titulo="Editar la venta de este sorteo"
                              onGuardar={(n) => guardar(f.liquidacionId, "venta", f, n)}
                            />
                          ) : (
                            fmt(f.venta, false)
                          )}
                        </td>
                        <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                          {fmt(f.comision, false)}
                        </td>
                        <td className="border-b border-fondo py-[6px] px-3 text-right text-cuerpo">
                          {editable ? (
                            <CeldaEditable
                              valor={f.premios}
                              guardando={enCurso}
                              titulo="Editar los premios de este sorteo"
                              onGuardar={(n) => guardar(f.liquidacionId, "premios", f, n)}
                            />
                          ) : (
                            fmt(f.premios, false)
                          )}
                        </td>
                      </>
                    );
                  })()}
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
