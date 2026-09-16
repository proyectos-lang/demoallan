"use client";

import { cn } from "@/lib/cn";
import { pad2 } from "@/lib/format";
import { GRUPOS, SIMBOLOS, rotuloSimbolo } from "@/lib/pos/simbologia";

/**
 * Las piezas de la simbología en la rejilla de venta.
 *
 * EL PROBLEMA DE SITIO, QUE AQUÍ ES EL PROBLEMA ENTERO
 * ----------------------------------------------------
 * La celda mide 34px de alto en la laptop y 38 en el teléfono, y esa medida no
 * es negociable: lo que la fija es que los cien números quepan sin desplazar,
 * que costó rehacer la rejilla entera. Un emoji a tamaño de texto normal pide
 * unos 16px y, apilado bajo la cifra, obliga a subir la celda a ~48px. Diez
 * filas por catorce píxeles son 140px más: vuelve el desplazamiento que se
 * quitó, y con él el problema que de verdad le costaba tiempo al vendedor.
 *
 * Por eso el símbolo se pinta a 11px —`leading-none` para que no arrastre
 * interlineado— y la cifra conserva su tamaño y su peso. Cuando hay que
 * sacrificar algo, se sacrifica el símbolo: el número es lo que se vende.
 *
 * TRES VISTAS Y NO DOS
 * --------------------
 * Se pidieron dos botones —uno para cambiar a símbolos y otro para ver ambos—.
 * Son tres estados de una misma cosa: qué se pinta en la celda. Un solo mando
 * de tres posiciones evita el estado sin sentido de «símbolos» y «ambos»
 * encendidos a la vez, que con dos interruptores sueltos hay que salir a
 * impedir por separado.
 */

/** Qué se pinta dentro de cada celda de la rejilla. */
export type VistaCelda = "numero" | "simbolo" | "ambos";

export const VISTAS: { id: VistaCelda; etiqueta: string; titulo: string }[] = [
  { id: "numero", etiqueta: "Números", titulo: "Sólo el número, como siempre" },
  { id: "simbolo", etiqueta: "Símbolos", titulo: "Sólo la figura" },
  { id: "ambos", etiqueta: "Ambos", titulo: "El número con su figura debajo" },
];

/**
 * El mando de tres posiciones.
 *
 * Va arriba de la rejilla y no dentro de un menú: se cambia a media venta,
 * cuando llega un cliente que pide por figura y el siguiente por número.
 */
export function SelectorVista({
  valor,
  alCambiar,
  className,
}: {
  valor: VistaCelda;
  alCambiar: (v: VistaCelda) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Qué se ve en la rejilla"
      className={cn("inline-flex rounded-campo border border-borde-campo overflow-hidden", className)}
    >
      {VISTAS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => alCambiar(v.id)}
          aria-pressed={valor === v.id}
          title={v.titulo}
          className={cn(
            "px-[13px] py-[7px] text-meta font-medium cursor-pointer border-0 border-l border-borde-campo first:border-l-0",
            valor === v.id ? "bg-acento text-white" : "bg-superficie text-cuerpo hover:bg-panel",
          )}
        >
          {v.etiqueta}
        </button>
      ))}
    </div>
  );
}

/**
 * El contenido de una celda, según la vista.
 *
 * `compacta` es la rejilla del teléfono, donde hay un par de píxeles más de
 * alto y el emoji puede permitirse 12px en vez de 11.
 *
 * En «ambos» la cifra baja un punto de tamaño para que las dos líneas quepan
 * sin tocar el borde. Es el único caso donde el número cede algo, y cede
 * tamaño, nunca presencia: sigue arriba y en negrita.
 */
export function CeldaNumero({
  n,
  vista,
  compacta = false,
}: {
  n: number;
  vista: VistaCelda;
  compacta?: boolean;
}) {
  const s = SIMBOLOS[n];

  if (vista === "numero" || !s) return <>{pad2(n)}</>;

  /*
   * EL DETALLE QUE COSTÓ MEDIR. Fijar `font-size` y `leading-none` NO basta:
   * un emoji arrastra la caja de la fuente con que se pinte —en Windows,
   * Segoe UI Emoji— y esa caja es más alta que el tamaño pedido. Medido en
   * Chrome, la celda pasaba de 34 a 34.8px. Ocho décimas por celda no se ven,
   * pero son ocho décimas que la rejilla no tiene de sobra, y en otra máquina
   * con otra fuente de emoji pueden ser tres píxeles.
   *
   * `block` con alto explícito y `overflow-hidden` encierra la figura en una
   * caja que el navegador no puede agrandar. La rejilla deja de depender de
   * qué fuente de emoji tenga instalada la máquina del vendedor.
   */
  if (vista === "simbolo")
    return (
      <span
        className={cn(
          "block overflow-hidden leading-none",
          compacta ? "text-[17px] h-[19px]" : "text-[15px] h-[17px]",
        )}
        // El número sigue estando para quien no ve la pantalla, y para quien
        // no reconozca la figura: el título de la celda lo dice entero.
        aria-label={pad2(n)}
      >
        {s.emoji}
      </span>
    );

  return (
    <span className="flex flex-col items-center justify-center leading-none gap-0">
      <span className={cn("block leading-none", compacta ? "text-[13px]" : "text-[12px]")}>
        {pad2(n)}
      </span>
      <span
        className={cn(
          "block overflow-hidden leading-none",
          compacta ? "text-[12px] h-[13px]" : "text-[11px] h-[12px]",
        )}
        aria-hidden
      >
        {s.emoji}
      </span>
    </span>
  );
}

/** «03 · Muerto 💀 · disponible L 300» — lo que se lee al posar el ratón. */
export function tituloCelda(n: number, disponible: string): string {
  return `${pad2(n)} · ${rotuloSimbolo(n)} · disponible ${disponible}`;
}

/**
 * La tira de agrupaciones.
 *
 * QUÉ HACE UN CLIC AQUÍ
 * ---------------------
 * Manda los números del grupo a `pedirMonto`, que es la misma puerta por la
 * que entra el botón de decena. Así el grupo hereda, sin escribir nada nuevo,
 * dos comportamientos que ya estaban decididos: en modo «marcar varios»
 * acumula sobre lo que hubiera, y fuera de ese modo abre la hoja del monto
 * para todo el grupo de una vez.
 *
 * LOS SIN CUPO NO SE CUENTAN
 * --------------------------
 * `pedirMonto` filtra por cupo disponible, así que un grupo con la mitad de
 * sus números topados vende la otra mitad en vez de fallar entero. El botón
 * dice cuántos quedan vivos, porque «Animales · 25» cuando sólo entran 12 es
 * una promesa que la venta no va a cumplir.
 */
export function TiraGrupos({
  disponible,
  alElegir,
  className,
}: {
  disponible: Record<number, number>;
  alElegir: (numeros: number[]) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {GRUPOS.map((g) => {
        const vivos = g.numeros.filter((n) => (disponible[n] ?? 0) > 0);
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => alElegir(g.numeros)}
            disabled={vivos.length === 0}
            title={
              vivos.length === 0
                ? `${g.nombre}: ningún número con cupo`
                : `${g.nombre}: ${vivos.map((n) => pad2(n)).join(", ")}`
            }
            className={cn(
              "flex items-center gap-[6px] px-[11px] py-[7px] rounded-campo text-meta font-medium border",
              vivos.length === 0
                ? "bg-riel text-mudo border-riel cursor-not-allowed"
                : "bg-superficie text-cuerpo border-borde-campo cursor-pointer hover:bg-acento-suave hover:border-acento",
            )}
          >
            <span aria-hidden>{g.emoji}</span>
            {g.nombre}
            <span className="text-mudo tabular-nums">{vivos.length}</span>
          </button>
        );
      })}
    </div>
  );
}
