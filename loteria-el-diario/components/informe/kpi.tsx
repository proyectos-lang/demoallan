import { Tarjeta } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";

/**
 * Una cifra suelta del informe: rótulo arriba, número grande, y un pie con la
 * proporción o la aclaración que haga falta.
 *
 * `esquina` es la proporción arriba a la derecha, como en las hojas que venía
 * mirando la gerencia. Va aparte del pie porque son dos cosas distintas: la
 * esquina es un porcentaje sobre otra cifra de la misma pantalla y el pie es
 * texto que explica de dónde sale el número.
 */
export function Kpi({
  etiqueta,
  valor,
  pie,
  color,
  esquina,
}: {
  etiqueta: string;
  valor: string;
  pie?: string;
  color?: string;
  esquina?: { texto: string; color?: string };
}) {
  return (
    <Tarjeta padding="14px 16px">
      <span className="flex items-start justify-between gap-2">
        <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
          {etiqueta}
        </span>
        {esquina && (
          <span
            className={cn(
              "text-label font-semibold flex-none",
              esquina.color ?? "text-secundario",
            )}
          >
            {esquina.texto}
          </span>
        )}
      </span>
      <span className={cn("block text-kpi font-semibold tracking-titular mt-[6px]", color)}>
        {valor}
      </span>
      {pie && <span className="block text-label text-mudo mt-[2px]">{pie}</span>}
    </Tarjeta>
  );
}
