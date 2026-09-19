"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Un modal grande con la hoja de un vendedor dentro, para cerrarle cuenta sin
 * salir de la pestaña de saldos.
 *
 * POR QUÉ UN IFRAME Y NO UN COMPONENTE
 * ------------------------------------
 * La hoja del vendedor es una pantalla entera —riel de semanas, cifras, cobrar,
 * saldar, imprimir, saldo de apertura, historial de cortes—, toda del lado del
 * servidor. Reescribirla como componente cliente sería duplicar cientos de
 * líneas y su lógica de datos, con dos versiones que se desincronizan. El
 * iframe carga la MISMA hoja, en la misma sesión y el mismo origen, y todo
 * funciona idéntico sin tocar nada.
 *
 * EL REFRESCO
 * -----------
 * Cada acción dentro de la hoja —pagar, saldar, reversar— revalida su propia
 * ruta, así que el iframe se actualiza solo. Lo que la tabla de saldos de
 * ATRÁS no sabe es que algo cambió: por eso, al cerrar, se hace `refresh()` de
 * la página de saldos para que recoja el nuevo saldo del vendedor.
 *
 * Sólo se refresca si hubo NAVEGACIÓN dentro del iframe (una acción recarga su
 * página), no por el simple hecho de abrir y cerrar: mirar sin tocar no tiene
 * por qué recargar la tabla.
 */
export function HojaModal({
  vendedorId,
  vendedor,
  semana,
  children,
}: {
  vendedorId: string;
  /** Rótulo para el título del modal: «V-012 · Alias». */
  vendedor: string;
  /** La semana abierta, para que el modal muestre la misma que la tabla. */
  semana: string;
  /** El disparador (el botón que abre el modal). */
  children: React.ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const router = useRouter();
  const iframe = useRef<HTMLIFrameElement | null>(null);
  // Cuántas veces cargó el iframe. La primera es la carga inicial; a partir de
  // la segunda, algo dentro navegó —una acción—, y entonces sí hay que
  // refrescar la tabla al cerrar.
  const cargas = useRef(0);
  const huboAccion = useRef(false);

  const url =
    `/liquidacion-hoja?vendedor=${encodeURIComponent(vendedorId)}` +
    (semana ? `&semana=${encodeURIComponent(semana)}` : "");

  const cerrar = () => {
    setAbierto(false);
    if (huboAccion.current) router.refresh();
    cargas.current = 0;
    huboAccion.current = false;
  };

  // Cerrar con Escape, como cualquier modal.
  useEffect(() => {
    if (!abierto) return;
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar();
    };
    document.addEventListener("keydown", alTecla);
    // Mientras el modal está abierto, el fondo no hace scroll.
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", alTecla);
      document.body.style.overflow = previo;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto]);

  return (
    <>
      <button type="button" onClick={() => setAbierto(true)} className="contents">
        {children}
      </button>

      {abierto && (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-2 sm:p-4 lg:p-6"
          onMouseDown={(e) => {
            // Sólo cierra si el clic empezó en el fondo, no si viene de soltar
            // dentro de la hoja tras seleccionar texto.
            if (e.target === e.currentTarget) cerrar();
          }}
        >
          <div className="bg-fondo w-full max-w-6xl rounded-card shadow-card overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-3 px-[18px] py-3 border-b border-riel bg-superficie flex-none">
              <h2 className="text-h2 font-semibold tracking-sutil m-0 truncate">
                Hoja de {vendedor}
              </h2>
              <button
                type="button"
                onClick={cerrar}
                className="inline-flex items-center gap-1.5 text-meta text-secundario hover:text-acento"
                aria-label="Cerrar la hoja y volver a saldos"
              >
                <X size={16} strokeWidth={2} />
                Cerrar
              </button>
            </div>

            <iframe
              ref={iframe}
              src={url}
              title={`Hoja de ${vendedor}`}
              className="flex-1 w-full border-0 bg-fondo"
              onLoad={() => {
                cargas.current += 1;
                if (cargas.current > 1) huboAccion.current = true;
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
