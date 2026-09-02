import { redirect } from "next/navigation";

import { HojaPeriodo, type FilaPeriodo } from "@/components/vendedor/hoja-periodo";
import { RangoPeriodo, type Atajo } from "@/components/vendedor/rango-periodo";
import { hoyHonduras, iso } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** El lunes de la semana a la que pertenece una fecha. La semana va lunes a domingo. */
function lunesDe(d: Date): Date {
  const copia = new Date(d);
  // getDay(): 0 es domingo. Se corre hacia atrás hasta el lunes anterior.
  copia.setDate(copia.getDate() - ((copia.getDay() + 6) % 7));
  return copia;
}

function sumarDias(d: Date, n: number): Date {
  const copia = new Date(d);
  copia.setDate(copia.getDate() + n);
  return copia;
}

const RANGO = /^\d{4}-\d{2}-\d{2}$/;

export default async function MiReportePage({ searchParams }: PageProps<"/mi-reporte">) {
  const sesion = await sesionActual();
  if (!sesion?.vendedor_id) redirect("/login");

  // El vendedor sale de la SESIÓN, no de la petición. Es toda la diferencia
  // entre ver lo suyo y ver lo de cualquiera: la función de la base recibe un
  // id y no comprueba de quién es, así que quien lo elige es este servidor.
  const vendedorId = sesion.vendedor_id;

  const params = await searchParams;
  const hoy = hoyHonduras();
  const lunes = lunesDe(hoy);

  const atajos: Atajo[] = [
    { etiqueta: "Esta semana", desde: iso(lunes), hasta: iso(sumarDias(lunes, 6)) },
    {
      etiqueta: "Semana pasada",
      desde: iso(sumarDias(lunes, -7)),
      hasta: iso(sumarDias(lunes, -1)),
    },
    { etiqueta: "Este mes", desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: iso(hoy) },
    { etiqueta: "Hoy", desde: iso(hoy), hasta: iso(hoy) },
  ];

  // Sólo se acepta `YYYY-MM-DD`: lo demás cae al rango por omisión en vez de
  // llegar a la base como una fecha inventada.
  const texto = (k: string, omision: string) => {
    const v = params[k];
    return typeof v === "string" && RANGO.test(v) ? v : omision;
  };

  let desde = texto("desde", atajos[0].desde);
  let hasta = texto("hasta", atajos[0].hasta);
  if (desde > hasta) [desde, hasta] = [hasta, desde];

  // Las flechas mueven el rango completo, conservando su largo: con una semana
  // saltan de semana; con un rango a medida, otro tanto.
  const dias = Math.round(
    (Date.parse(`${hasta}T00:00:00`) - Date.parse(`${desde}T00:00:00`)) / 86_400_000,
  ) + 1;

  const correr = (n: number) => ({
    desde: iso(sumarDias(new Date(`${desde}T00:00:00`), n)),
    hasta: iso(sumarDias(new Date(`${hasta}T00:00:00`), n)),
  });

  const anterior = correr(-dias);
  const siguienteCrudo = correr(dias);
  // No se ofrece avanzar más allá de hoy: no hay nada que enseñar.
  const siguiente = siguienteCrudo.desde <= iso(hoy) ? siguienteCrudo : null;

  const supabase = await crearClienteServidor();
  const { data, error } = await supabase.rpc("fn_mi_periodo", {
    p_vendedor_id: vendedorId,
    p_desde: desde,
    p_hasta: hasta,
  });

  const filas: FilaPeriodo[] = (data ?? []).map((f) => ({
    fecha: f.r_fecha,
    hora: f.r_hora,
    estado: f.r_estado,
    ganador: f.r_ganador,
    venta: Number(f.r_venta),
    premiado: Number(f.r_premiado),
    comision: Number(f.r_comision),
    premios: Number(f.r_premios),
    pagado: f.r_pagado,
  }));

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-[820px] lg:max-w-[1180px] mx-auto">
      <div>
        <h1 className="text-h1 font-semibold tracking-titular m-0">Informes por período</h1>
        <p className="text-meta text-secundario mt-[5px] mb-0">
          Día por día y sorteo por sorteo, con las mismas columnas que mira la gerencia —pero
          sólo con lo suyo. Para cuadrar una semana entera con administración, «Mi liquidación».
        </p>
      </div>

      <RangoPeriodo
        desde={desde}
        hasta={hasta}
        atajos={atajos}
        anterior={anterior}
        siguiente={siguiente}
      />

      {error ? (
        <div className="bg-panel border border-borde rounded-card px-4 py-3 text-meta text-cuerpo">
          No se pudo cargar el reporte: {error.message}
        </div>
      ) : (
        <HojaPeriodo filas={filas} />
      )}
    </div>
  );
}
