import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** Contenedor de pantalla. El prototipo usa padding 24/28/60 en todas salvo geo. */
export function Pagina({
  children,
  className,
  compacta = false,
  ancho,
}: {
  children: ReactNode;
  className?: string;
  /** `geo` recorta el padding inferior a 40px porque el mapa ya ocupa el alto. */
  compacta?: boolean;
  /** Algunas pantallas limitan el ancho (resultados usa 1120px). */
  ancho?: number;
}) {
  return (
    <div
      className={cn("px-7 pt-6", compacta ? "pb-10" : "pb-[60px]", className)}
      style={ancho ? { maxWidth: ancho } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Encabezado de pantalla. Dos formas en el prototipo: el simple (título +
 * subtítulo) y el de dos columnas, con acciones alineadas al pie del bloque.
 */
export function EncabezadoPagina({
  titulo,
  subtitulo,
  acciones,
}: {
  titulo: string;
  subtitulo?: ReactNode;
  acciones?: ReactNode;
}) {
  if (!acciones) {
    return (
      <>
        <h1 className="text-h1 font-semibold tracking-titular m-0">{titulo}</h1>
        {subtitulo && (
          <p className="text-tabla text-secundario mt-[6px] mb-[18px]">
            {subtitulo}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="flex items-end justify-between gap-5 flex-wrap mb-[18px]">
      <div>
        <h1 className="text-h1 font-semibold tracking-titular m-0">{titulo}</h1>
        {subtitulo && (
          <p className="text-tabla text-secundario mt-[6px] mb-0">{subtitulo}</p>
        )}
      </div>
      <div className="flex items-center gap-[10px] flex-wrap">{acciones}</div>
    </div>
  );
}
