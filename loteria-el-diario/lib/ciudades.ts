/**
 * Las ciudades del departamento, con su coordenada de referencia.
 *
 * POR QUÉ VIVEN AQUÍ Y NO EN `acciones.ts`
 * ----------------------------------------
 * Estaban exportadas desde el módulo `"use server"` del alta de vendedores, y
 * eso las rompía en producción. En un archivo `"use server"` TODO lo exportado
 * tiene que ser una función asíncrona: es el contrato de las acciones de
 * servidor. Un objeto exportado desde ahí no viaja como dato — Next lo
 * convierte en una referencia de servidor, y el componente de cliente que lo
 * importaba para pintar el selector recibía algo que no se puede recorrer.
 *
 * En desarrollo pasaba desapercibido; en el paquete de producción tumbaba la
 * pantalla entera con un error minificado que no decía nada. Es el mismo error
 * que ya se cometió con `JORNADA`, que acabó en `lib/format.ts` por lo mismo.
 *
 * Un módulo sin directiva lo importan los dos lados sin ceremonia, que es lo
 * que corresponde a una constante.
 */
export const CIUDADES = {
  "San Pedro Sula": { lat: 15.5045, lng: -88.025 },
  Choloma: { lat: 15.6136, lng: -87.9525 },
  Villanueva: { lat: 15.3167, lng: -88.0 },
  "La Lima": { lat: 15.4386, lng: -87.9161 },
} as const;

export type Ciudad = keyof typeof CIUDADES;
