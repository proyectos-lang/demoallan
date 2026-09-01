import type { Metadata } from "next";
import Link from "next/link";
import { AlignLeft } from "lucide-react";

import { fechaHonduras, fechaLarga, iso, pad2 } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

const HORAS = ["11:00", "15:00", "20:00"] as const;

/**
 * Los resultados de un día no cambian una vez liquidados, pero el día en curso
 * sí: se revalida cada minuto para que un sorteo recién liquidado aparezca sin
 * tener que redesplegar.
 */
export const revalidate = 60;

export async function generateMetadata(props: PageProps<"/r/[fecha]">): Promise<Metadata> {
  const { fecha } = await props.params;
  return {
    title: `Resultados del ${fecha} · Sistema de Control de Tickets`,
    description: "Números ganadores de los sorteos de las 11:00, 15:00 y 20:00.",
  };
}

export default async function ResultadosPublicosPage(props: PageProps<"/r/[fecha]">) {
  const { fecha } = await props.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return <Aviso texto="La fecha del enlace no es válida." fecha={fechaHonduras()} />;
  }

  const supabase = await crearClienteServidor();

  // La vista pública expone TRES columnas y sólo de sorteos liquidados. Nada de
  // montos, vendedores ni coordenadas: es la única superficie legible sin
  // autenticación y así debe seguir.
  const { data: resultados } = await supabase
    .from("v_resultado_publico")
    .select("hora, numero_ganador")
    .eq("fecha", fecha);

  const porHora = new Map((resultados ?? []).map((r) => [r.hora, r.numero_ganador]));

  const dia = new Date(`${fecha}T12:00:00`);
  const anterior = iso(new Date(dia.getTime() - 86_400_000));
  const siguiente = iso(new Date(dia.getTime() + 86_400_000));
  const hoy = fechaHonduras();

  return (
    <main className="min-h-screen flex flex-col items-center px-5 py-10">
      <div className="w-full max-w-[560px]">
        <div className="flex items-center gap-[11px] mb-7">
          <span
            className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
            style={{ background: "var(--gradiente-logo)" }}
          >
            <AlignLeft size={20} color="#fff" strokeWidth={2} absoluteStrokeWidth />
          </span>
          <span className="block text-h2 font-semibold tracking-sutil">
            Sistema de Control de Tickets
          </span>
        </div>

        <h1 className="text-h1 font-semibold tracking-titular m-0">Resultados</h1>
        <p className="text-tabla text-secundario mt-[6px] mb-5">{fechaLarga(fecha)}</p>

        <div className="flex flex-col gap-[14px]">
          {HORAS.map((hora) => {
            const numero = porHora.get(hora);
            const publicado = numero !== undefined && numero !== null;
            return (
              <div
                key={hora}
                className="bg-superficie border border-borde rounded-card shadow-card px-[22px] py-5 flex items-center justify-between gap-4"
              >
                <div>
                  <span className="block text-h2 font-semibold tracking-sutil">
                    Sorteo de las {hora}
                  </span>
                  <span className="block text-meta text-secundario mt-1">
                    {publicado ? "resultado oficial" : "pendiente de publicar"}
                  </span>
                </div>
                <span
                  className="w-[86px] h-[86px] flex-none rounded-hero flex items-center justify-center text-tile font-semibold tracking-titular"
                  style={
                    publicado
                      ? { background: "var(--color-navy)", color: "#fff" }
                      : { background: "var(--color-chip)", color: "var(--color-mudo)" }
                  }
                >
                  {publicado ? pad2(numero) : "—"}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between mt-6">
          <Link href={`/r/${anterior}`} className="text-tabla font-medium">
            ‹ Día anterior
          </Link>
          {fecha !== hoy && (
            <Link href={`/r/${hoy}`} className="text-tabla font-medium">
              Hoy
            </Link>
          )}
          <Link href={`/r/${siguiente}`} className="text-tabla font-medium">
            Día siguiente ›
          </Link>
        </div>

        <p className="text-label text-mudo leading-[1.55] mt-8 mb-0">
          Un sorteo aparece aquí sólo cuando está liquidado. Mientras no lo esté no tiene número
          ganador: publicarlo antes sería publicar algo que todavía puede cambiar.
        </p>
      </div>
    </main>
  );
}

function Aviso({ texto, fecha }: { texto: string; fecha: string }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-5 gap-4">
      <p className="text-tabla text-cuerpo m-0">{texto}</p>
      <Link href={`/r/${fecha}`} className="text-tabla font-medium">
        Ver los resultados de hoy
      </Link>
    </main>
  );
}
