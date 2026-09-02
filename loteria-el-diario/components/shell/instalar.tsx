"use client";

import { Download, RefreshCw, Share } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";

/**
 * El evento que Chrome dispara cuando la aplicación es instalable. No está en
 * la biblioteca de tipos del DOM porque no es estándar: sólo lo implementan
 * los navegadores basados en Chromium.
 */
type EventoInstalar = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const sinCambios = () => () => {};

/*
 * Los dos ganchos de aquí se llaman `useX` y no `usarX`, en contra del resto
 * del proyecto. `react-hooks/rules-of-hooks` reconoce un gancho por el prefijo
 * `use` del nombre, y con el nombre en español da por hecho que se está
 * llamando a un gancho desde una función cualquiera. Mismo motivo por el que
 * `lib/pos/use-pos.ts` se llama así.
 */

/**
 * Si la aplicación ya está abierta como aplicación instalada.
 *
 * Va con `useSyncExternalStore` y no con un efecto que llame a `setState`: es
 * exactamente para lo que sirve —leer un dato que vive fuera de React—, el
 * servidor recibe `false` sin tocar `window`, y no encadena un render de más.
 */
function useInstalada(): boolean {
  return useSyncExternalStore(
    (avisar) => {
      const m = window.matchMedia("(display-mode: standalone)");
      m.addEventListener("change", avisar);
      return () => m.removeEventListener("change", avisar);
    },
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      // Safari en iOS no implementa `display-mode` y usa esto en su lugar.
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );
}

/** Si es un iPhone o un iPad, donde la instalación se hace a mano. */
function useIOS(): boolean {
  return useSyncExternalStore(
    sinCambios,
    () => /iphone|ipad|ipod/i.test(window.navigator.userAgent),
    () => false,
  );
}

/**
 * Instalar el sistema y actualizarlo.
 *
 * INSTALAR. En Android y en el escritorio el navegador avisa de que la
 * aplicación es instalable y guarda el gesto; el botón lo dispara. En iPhone
 * ese aviso no existe —Safari obliga a pasar por «Compartir»— así que ahí el
 * botón explica los dos toques en vez de fingir que hace algo. Si ya está
 * instalada, el botón desaparece: no hay nada que ofrecer.
 *
 * ACTUALIZAR. Recarga entera, no un refresco de datos. Sirve para las dos
 * cosas que se piden: traer la versión nueva del sistema cuando se publica una
 * —el atajo instalado puede quedarse con la anterior en memoria— y volver a
 * pedir la información a la base. Un `router.refresh()` haría sólo lo segundo,
 * y el botón dice «actualizar el sistema».
 *
 * OJO: recargar tira lo que no esté registrado. Por eso vive en el menú y en
 * el acceso, nunca al lado del punto de venta, donde una tanda a medias se
 * perdería de un toque.
 */
export function BotonesApp({
  variante = "claro",
  className,
}: {
  /** `oscuro` para la barra lateral y el menú del vendedor, sobre el marino. */
  variante?: "claro" | "oscuro";
  className?: string;
}) {
  const instalada = useInstalada();
  const esIOS = useIOS();
  const [gesto, setGesto] = useState<EventoInstalar | null>(null);
  const [pasos, setPasos] = useState(false);
  const [recargando, setRecargando] = useState(false);

  useEffect(() => {
    const alPoder = (e: Event) => {
      // Sin esto el navegador enseña su propia barra de instalación, y quedan
      // dos sitios distintos para lo mismo.
      e.preventDefault();
      setGesto(e as EventoInstalar);
    };
    const alInstalar = () => setGesto(null);

    window.addEventListener("beforeinstallprompt", alPoder);
    window.addEventListener("appinstalled", alInstalar);
    return () => {
      window.removeEventListener("beforeinstallprompt", alPoder);
      window.removeEventListener("appinstalled", alInstalar);
    };
  }, []);

  const instalar = async () => {
    if (!gesto) return;
    await gesto.prompt();
    // El gesto se consume: guardarlo para un segundo intento no funciona, el
    // navegador lo rechaza. Se vuelve a ofrecer si el evento se dispara otra
    // vez.
    await gesto.userChoice;
    setGesto(null);
  };

  const base =
    "flex items-center gap-[10px] w-full px-3 py-[11px] rounded-campo text-meta font-medium text-left";
  const clase =
    variante === "oscuro"
      ? cn(base, "bg-nav-chip text-nav-item")
      : cn(base, "bg-panel border border-borde-campo text-cuerpo");
  const colorIcono = variante === "oscuro" ? "var(--color-nav-item)" : "var(--color-secundario)";

  const puedeInstalar = !instalada && (gesto !== null || esIOS);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {puedeInstalar && (
        <button
          type="button"
          onClick={() => (esIOS ? setPasos((p) => !p) : instalar())}
          className={clase}
        >
          {esIOS ? (
            <Share size={16} color={colorIcono} strokeWidth={2} absoluteStrokeWidth />
          ) : (
            <Download size={16} color={colorIcono} strokeWidth={2} absoluteStrokeWidth />
          )}
          Instalar el sistema
        </button>
      )}

      {/* En iPhone no hay nada que disparar: sólo se puede explicar. */}
      {puedeInstalar && esIOS && pasos && (
        <p
          className={cn(
            "text-label leading-[1.55] m-0 px-3 py-[10px] rounded-campo",
            variante === "oscuro" ? "bg-nav-hover text-nav-item" : "bg-panel text-cuerpo",
          )}
        >
          En el iPhone se instala desde Safari: toque <strong>Compartir</strong> —el cuadrado con
          la flecha, abajo— y luego <strong>Añadir a pantalla de inicio</strong>. El atajo queda
          con el icono del ticket y abre sin la barra del navegador.
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setRecargando(true);
          window.location.reload();
        }}
        disabled={recargando}
        className={cn(clase, recargando && "opacity-60")}
      >
        <RefreshCw size={16} color={colorIcono} strokeWidth={2} absoluteStrokeWidth />
        {recargando ? "Actualizando…" : "Actualizar el sistema"}
      </button>
    </div>
  );
}
