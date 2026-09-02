import { redirect } from "next/navigation";

import {
  PestanasLiquidacion,
  type VistaLiq,
} from "@/components/liquidacion/pestanas-liquidacion";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { sesionActual } from "@/lib/sesion";

import { VistaHoja } from "./vista-hoja";
import { VistaResumen } from "./vista-resumen";

export const dynamic = "force-dynamic";

const SUBTITULO: Record<VistaLiq, string> = {
  hoja: "Semana por semana y sorteo por sorteo, lo que queda por cuadrar con un vendedor. Liquidar cierra esos sorteos en la dirección que toque —los entrega el vendedor o los entrega la casa— y no vuelven a aparecer, así que un cierre parcial deja la hoja limpia.",
  resumen:
    "Cómo va la liquidación, semana a semana: cuánto había, cuánto se cerró, y lo que falta separado en lo que se cobra y lo que se paga. Sin vendedor es el padrón entero.",
};

export default async function LiquidacionPage({ searchParams }: PageProps<"/liquidacion">) {
  // Tercera guarda, además de la barra lateral y de `proxy.ts`. Aquí se entrega
  // dinero: que las tres digan lo mismo es barato y evita que un cambio de
  // enrutado abra la pantalla sin que nadie se entere.
  const sesion = await sesionActual();
  if (sesion && sesion.rol !== "administrador") redirect("/tablero");

  const params = await searchParams;
  const pedida = typeof params.vista === "string" ? params.vista : "";
  const vista: VistaLiq = pedida === "resumen" ? "resumen" : "hoja";
  const vendedorId = typeof params.vendedor === "string" ? params.vendedor : "";

  return (
    <Pagina>
      <EncabezadoPagina titulo="Liquidación semanal" subtitulo={SUBTITULO[vista]} />

      <div className="flex flex-col gap-4">
        <PestanasLiquidacion vista={vista} vendedorId={vendedorId} />

        {vista === "hoja" ? <VistaHoja params={params} /> : <VistaResumen params={params} />}
      </div>
    </Pagina>
  );
}
