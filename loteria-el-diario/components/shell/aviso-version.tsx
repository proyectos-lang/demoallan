"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { VERSION, VERSION_CONOCIDA } from "@/lib/version";

/** Cada cuánto se pregunta al servidor si hay versión nueva. */
const CADA = 3 * 60 * 1000;

/**
 * «Hay una nueva versión del sistema».
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * Los vendedores dejan la aplicación abierta días enteros en el teléfono: la
 * abren por la mañana y no la vuelven a cargar. Una corrección publicada al
 * mediodía no les llega hasta que algo les obliga a recargar, y mientras tanto
 * siguen trabajando con la versión vieja sin saberlo — y reportando fallos ya
 * arreglados.
 *
 * POR QUÉ AVISA Y NO RECARGA SOLO
 * -------------------------------
 * Porque recargar tira lo que haya tecleado sin confirmar. Un vendedor con
 * ocho números puestos y el cliente delante perdería la venta a medias por una
 * publicación que no pidió, y esa pérdida es peor que seguir un rato más con
 * la versión anterior. El aviso espera; quien decide cuándo es él.
 *
 * Por lo mismo la barra va ABAJO y no tapa nada: el pie del punto de venta
 * —subtotal y «Confirmar»— es lo único que no se puede estorbar, así que el
 * aviso se coloca por encima de la zona segura pero sin cubrir la pantalla.
 *
 * CÓMO SABE QUE HAY VERSIÓN NUEVA
 * -------------------------------
 * `VERSION` queda cocida en el paquete que el navegador cargó; `/api/version`
 * dice la que el servidor sirve ahora. Si difieren, es que se publicó algo.
 * Comparar dos cadenas es todo: no hace falta service worker ni nada que haya
 * que mantener.
 */
export function AvisoVersion() {
  const [hayNueva, setHayNueva] = useState(false);
  const [recargando, setRecargando] = useState(false);

  useEffect(() => {
    // En desarrollo no hay SHA que comparar y el aviso saldría en cada
    // recompilación. Se apaga y no se pide nada.
    if (!VERSION_CONOCIDA) return;

    let vivo = true;

    const mirar = async () => {
      // Sin conexión no se molesta: un vendedor en la calle pierde señal a
      // ratos, y un fallo de red no significa que haya versión nueva.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;

      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const { version } = (await r.json()) as { version?: string };
        // Sólo se avisa si el servidor da una versión concreta y distinta.
        // Sin la comprobación de `version`, una respuesta rara pondría el
        // cartel para siempre y el vendedor recargaría sin que cambiara nada.
        if (vivo && version && version !== VERSION) setHayNueva(true);
      } catch {
        // Silencio a propósito: esto corre cada tres minutos en segundo plano
        // y un fallo de red no es algo que el vendedor tenga que ver.
      }
    };

    mirar();
    const reloj = setInterval(mirar, CADA);

    /*
     * Y también al volver a la pantalla.
     *
     * Es el caso que más se da: el vendedor deja el teléfono, atiende, y
     * vuelve media hora después. Los navegadores móviles congelan los
     * temporizadores de las pestañas en segundo plano, así que sin esto el
     * reloj de arriba podría no haber corrido ni una vez.
     */
    const alVolver = () => {
      if (document.visibilityState === "visible") mirar();
    };
    document.addEventListener("visibilitychange", alVolver);

    return () => {
      vivo = false;
      clearInterval(reloj);
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, []);

  /*
   * Se marca el documento mientras la barra está puesta.
   *
   * El pie del punto de venta —subtotal y «Confirmar»— también va fijo abajo,
   * y sin esto la barra se le encimaría justo encima del botón que más se
   * pulsa. Con la marca, el CSS aparta lo que haga falta; sin ella, todo queda
   * exactamente como estaba.
   *
   * Va en un efecto y no en el render porque tocar el DOM mientras se pinta es
   * un efecto secundario, y React lo puede repetir.
   */
  useEffect(() => {
    const raiz = document.documentElement;
    if (hayNueva) raiz.dataset.avisoVersion = "";
    else delete raiz.dataset.avisoVersion;
    return () => {
      delete raiz.dataset.avisoVersion;
    };
  }, [hayNueva]);

  if (!hayNueva) return null;

  const actualizar = () => {
    setRecargando(true);
    /*
     * `location.reload()` a secas, y no un truco con la URL.
     *
     * Lo que hay que renovar es el HTML del documento, que es quien apunta a
     * los paquetes de JavaScript: esos ya vienen con un identificador distinto
     * en cada compilación, así que en cuanto el HTML es el nuevo, el navegador
     * pide los nuevos por su cuenta. Añadir `?v=` a la dirección sólo
     * ensuciaría la barra y rompería el enlace que el vendedor tenga guardado.
     */
    window.location.reload();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      /*
       * Fijo abajo y por encima de todo lo demás, pero SIN tapar el pie del
       * punto de venta: por eso `bottom` sale de la zona segura del aparato
       * más el alto de la propia barra, y el contenido de la página recibe un
       * relleno equivalente desde el layout.
       */
      className="fixed left-0 right-0 bottom-0 z-[60] px-3 pb-[calc(10px+env(safe-area-inset-bottom))] pt-[10px] bg-nav-titulo text-white shadow-[0_-2px_12px_rgba(0,0,0,0.18)]"
    >
      <div className="max-w-[820px] mx-auto flex items-center gap-3">
        <span className="flex-1 text-meta leading-[1.4]">
          <strong className="font-semibold">Hay una nueva versión del sistema.</strong>{" "}
          <span className="text-navy-pie">Actualice para tenerla.</span>
        </span>
        <button
          type="button"
          onClick={actualizar}
          disabled={recargando}
          className="flex-none inline-flex items-center gap-2 bg-white text-nav-titulo rounded-boton px-4 py-[9px] text-meta font-semibold disabled:opacity-70"
        >
          <RefreshCw
            size={14}
            strokeWidth={2.4}
            absoluteStrokeWidth
            className={recargando ? "animate-spin" : undefined}
          />
          {recargando ? "Actualizando…" : "Actualizar"}
        </button>
      </div>
    </div>
  );
}
