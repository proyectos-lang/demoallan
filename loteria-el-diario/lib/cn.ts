/** Une clases ignorando falsy. Suficiente para este proyecto: las variantes se
 *  resuelven con mapas de clases, no sobreescribiendo utilidades entre sí. */
export function cn(...partes: Array<string | false | null | undefined>): string {
  return partes.filter(Boolean).join(" ");
}
