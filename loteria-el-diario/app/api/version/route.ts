import { VERSION } from "@/lib/version";

/**
 * Qué versión está sirviendo el servidor AHORA.
 *
 * El aparato del vendedor guarda la versión con la que cargó la pantalla y
 * pregunta aquí cada pocos minutos. Cuando lo que responde este endpoint deja
 * de coincidir con lo que él tiene, es que se publicó algo: entonces aparece
 * el aviso de actualizar.
 *
 * POR QUÉ NO SE CACHEA, DE TRES MANERAS
 * -------------------------------------
 * Un endpoint que dice «qué versión hay» y que se sirve desde una caché es
 * exactamente inútil: seguiría contestando la versión vieja después de
 * publicar, que es el único momento en que se le pregunta algo interesante.
 *
 * Por eso van las tres: `dynamic` para que Next no lo prerenderice en el
 * build, `revalidate = 0` para que no lo guarde, y `Cache-Control: no-store`
 * para que no lo guarden ni el CDN de Vercel ni el navegador.
 *
 * NO PIDE SESIÓN
 * --------------
 * No hay nada que proteger: devuelve el identificador del commit publicado, no
 * datos de nadie. Exigir sesión aquí sólo conseguiría que la comprobación
 * fallara justo cuando la cookie vence, que es cuando más falta hace poder
 * recargar.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export function GET() {
  return new Response(JSON.stringify({ version: VERSION }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0, must-revalidate",
    },
  });
}
