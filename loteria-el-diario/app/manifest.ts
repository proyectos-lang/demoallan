import type { MetadataRoute } from "next";

/**
 * El manifiesto que hace instalable el sistema.
 *
 * Con esto, Android y el escritorio ofrecen «instalar» y el atajo abre sin
 * barra de direcciones; en iPhone, «Compartir → Añadir a pantalla de inicio»
 * usa el mismo nombre y el mismo icono.
 *
 * NO HAY SERVICE WORKER, Y ES DELIBERADO.
 * ---------------------------------------
 * La guía de esta versión de Next lo dice: el aviso de instalar no necesita
 * soporte sin conexión. Y aquí no lo queremos: esto es un punto de venta con
 * cupos por número y sorteos que cierran al minuto. Una caché que sirva una
 * pantalla vieja enseñaría un sorteo abierto que ya cerró o un cupo que ya se
 * agotó, y el vendedor cobraría una apuesta que la base va a rechazar. Sin
 * conexión, esta aplicación no debe funcionar: debe decir que no hay conexión.
 *
 * `start_url` es la raíz y no una pantalla concreta porque el reparto lo hace
 * `proxy.ts` según el rol —el vendedor cae en su punto de venta y el
 * administrador en el tablero—, y quien abre el atajo puede ser cualquiera de
 * los dos.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sistema de Control de Tickets",
    // Lo que cabe debajo del icono en la pantalla de inicio de un teléfono.
    short_name: "Tickets",
    description: "Control de ventas de lotería · Cortés, Honduras",
    start_url: "/",
    display: "standalone",
    // El marino de la barra lateral: al abrir el atajo, la barra de estado del
    // teléfono queda del mismo color que la cabecera de la aplicación.
    theme_color: "#0f2547",
    background_color: "#f4f7fb",
    lang: "es",
    /*
     * El mismo archivo aparece dos veces por tamaño, una por propósito.
     *
     * La especificación admite `purpose: "any maskable"` en una sola entrada,
     * pero el tipo de Next sólo acepta un valor. Repetir el `src` es
     * equivalente y no cuesta una descarga de más: es la misma URL. El ticket
     * cabe en el círculo del 80 % que recorta Android, así que el dibujo sirve
     * tal cual para las dos formas.
     */
    icons: [
      { src: "/icono-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icono-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icono-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icono-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
