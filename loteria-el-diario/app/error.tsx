"use client";

import { AlertTriangle } from "lucide-react";

import { Boton } from "@/components/ui/boton";

/**
 * Red de seguridad para cualquier error del servidor.
 *
 * Sin esto, Next muestra «A server error occurred. Reload to try again.» — un
 * mensaje que no dice qué pasó ni qué hacer, y que en producción ni siquiera
 * distingue entre una consulta lenta y un fallo de programación.
 *
 * El `digest` es el identificador que Next escribe también en el registro del
 * servidor: enseñarlo es lo único que permite cruzar lo que vio el usuario con
 * lo que registró el servidor, porque el mensaje real no se envía al navegador
 * a propósito (podría filtrar detalles internos).
 */
export default function ErrorGlobal({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-[440px] max-w-full bg-superficie border border-borde rounded-card shadow-card px-7 py-7">
        <div className="flex items-center gap-[11px] mb-4">
          <span className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center bg-ambar-fondo">
            <AlertTriangle
              size={19}
              color="var(--color-ambar-texto)"
              strokeWidth={2}
              absoluteStrokeWidth
            />
          </span>
          <span className="block text-h2 font-semibold tracking-sutil">
            No se pudo cargar la pantalla
          </span>
        </div>

        {/*
          El texto NO adivina la causa.
 
          Antes decía que «lo más común es que la consulta tardara más de lo que
          la base permite». Esa frase mandó a buscar un problema de rendimiento
          cuando lo que había era un fallo al guardar: la pantalla afirmaba una
          causa que no podía conocer, y el diagnóstico se fue detrás. Aquí sólo
          se dice lo que se sabe —que falló y si se guardó o no— y se señala el
          registro, que es donde está el motivo de verdad.
        */}
        <p className="text-base text-cuerpo leading-[1.6] mt-0 mb-3">
          Algo falló en el servidor al preparar esta pantalla. Si venía de guardar algo,{" "}
          <strong>compruebe antes de repetirlo</strong>: el fallo puede haber ocurrido después de
          que el dato quedara guardado.
        </p>
        <p className="text-meta text-secundario leading-[1.55] mt-0 mb-3">
          El motivo exacto queda en el registro del servidor, no aquí —enviarlo al navegador
          podría filtrar detalles internos—. Si es una consulta muy grande, acortar el rango de
          fechas suele bastar.
        </p>

        {error.digest && (
          <p className="text-meta text-secundario m-0 mb-5">
            Referencia para el registro del servidor:{" "}
            <span className="font-medium">{error.digest}</span>
          </p>
        )}

        <div className="flex gap-[10px] flex-wrap">
          <Boton onClick={reset}>Reintentar</Boton>
          <a
            href="/tablero"
            className="text-tabla font-medium px-[15px] py-[9px] rounded-boton border border-borde-campo bg-superficie hover:bg-panel"
          >
            Ir al tablero
          </a>
        </div>
      </div>
    </main>
  );
}
