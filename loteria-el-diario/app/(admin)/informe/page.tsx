import { Pestanas, type Vista } from "@/components/informe/pestanas";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";

import { VistaDiaria } from "./vista-diaria";
import { VistaFinanciera } from "./vista-financiera";
import { VistaSemanal } from "./vista-semanal";
import { VistaVendedor } from "./vista-vendedor";

export const dynamic = "force-dynamic";

const VISTAS: Vista[] = ["diaria", "semanal", "vendedor", "financiera"];

const SUBTITULO: Record<Vista, string> = {
  diaria:
    "Un día y un sorteo, vendedor por vendedor: venta, lo apostado al número que salió, lo que costó pagarlo, la comisión y lo que queda.",
  semanal:
    "Los cinco números de la semana y el padrón con los parámetros con los que se jugó. Las semanas de la izquierda son todas las que tienen movimiento liquidado.",
  vendedor:
    "Un vendedor a la vez: su acumulado, su peso dentro del negocio y su historia semana a semana.",
  financiera:
    "Toda la operación acumulada, cortada como la venía mirando la gerencia: semestre, trimestre, bimestre, mes, semana y día de la semana.",
};

/**
 * Informe de gerencia.
 *
 * Cuatro informes distintos bajo el mismo techo, porque los cuatro contestan a
 * la misma persona y sobre los mismos datos, sólo que cortados de otra manera:
 * un día, una semana, un vendedor, o toda la operación de una vez.
 *
 * La pestaña va en la dirección. Cada vista lee sus propios parámetros y hace
 * sus propias consultas: así abrir el resumen semanal no cuesta las consultas
 * de la captura diaria, que es lo que pasaría si la página trajera todo y
 * escondiera dos tercios.
 */
export default async function InformePage({ searchParams }: PageProps<"/informe">) {
  const params = await searchParams;

  const pedida = typeof params.vista === "string" ? params.vista : "";
  const vista: Vista = VISTAS.includes(pedida as Vista) ? (pedida as Vista) : "diaria";

  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  return (
    <Pagina>
      <EncabezadoPagina titulo="Informe de gerencia" subtitulo={SUBTITULO[vista]} />

      <div className="flex flex-col gap-4">
        <Pestanas vista={vista} />

        {vista === "diaria" && <VistaDiaria params={params} />}
        {vista === "semanal" && <VistaSemanal semanaPedida={texto("semana")} />}
        {vista === "vendedor" && <VistaVendedor vendedorPedido={texto("vendedor")} />}
        {vista === "financiera" && <VistaFinanciera />}
      </div>
    </Pagina>
  );
}
