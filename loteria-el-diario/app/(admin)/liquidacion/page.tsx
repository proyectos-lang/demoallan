import { redirect } from "next/navigation";

import {
  FiltrosLiquidacion,
  type OpcionVendedorLiq,
} from "@/components/liquidacion/filtros-liquidacion";
import {
  HojaLiquidacion,
  type FilaLiquidacion,
} from "@/components/liquidacion/hoja-liquidacion";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { cn } from "@/lib/cn";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { fechaLargaSinDia, fmt, hoyHonduras, iso } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** El lunes de la semana a la que pertenece una fecha. La semana va lunes a domingo. */
function lunesDe(d: Date): Date {
  const copia = new Date(d);
  // getDay(): 0 es domingo. Se corre hacia atrás hasta el lunes anterior.
  const desplazamiento = (copia.getDay() + 6) % 7;
  copia.setDate(copia.getDate() - desplazamiento);
  return copia;
}

function sumarDias(d: Date, n: number): Date {
  const copia = new Date(d);
  copia.setDate(copia.getDate() + n);
  return copia;
}

export default async function LiquidacionPage({ searchParams }: PageProps<"/liquidacion">) {
  // Tercera guarda, además de la barra lateral y de `proxy.ts`. Aquí se entrega
  // dinero: que las tres digan lo mismo es barato y evita que un cambio de
  // enrutado abra la pantalla sin que nadie se entere.
  const sesion = await sesionActual();
  if (sesion && sesion.rol !== "administrador") redirect("/tablero");

  const supabase = await crearClienteServidor();
  const params = await searchParams;

  const hoy = hoyHonduras();
  const lunes = lunesDe(hoy);

  const semanas = [
    { etiqueta: "Esta semana", desde: iso(lunes), hasta: iso(sumarDias(lunes, 6)) },
    {
      etiqueta: "Semana pasada",
      desde: iso(sumarDias(lunes, -7)),
      hasta: iso(sumarDias(lunes, -1)),
    },
    {
      etiqueta: "Hace dos semanas",
      desde: iso(sumarDias(lunes, -14)),
      hasta: iso(sumarDias(lunes, -8)),
    },
    {
      etiqueta: "Últimos 30 días",
      desde: iso(sumarDias(hoy, -29)),
      hasta: iso(hoy),
    },
  ];

  const texto = (k: string, omision: string) =>
    typeof params[k] === "string" && params[k] ? (params[k] as string) : omision;

  const desde = texto("desde", semanas[0].desde);
  const hasta = texto("hasta", semanas[0].hasta);
  const vendedorId = texto("vendedor", "");

  // El padrón de este módulo NO filtra por `activo`: a un vendedor dado de baja
  // con saldo pendiente hay que poder pagarle. Es la diferencia con reportes y
  // control, que sí lo filtran.
  const { data: crudos } = await supabase.rpc("fn_vendedores_liquidables");

  const vendedores: OpcionVendedorLiq[] = (crudos ?? []).map((v) => ({
    id: v.r_vendedor_id,
    codigo: v.r_codigo,
    nombre: v.r_nombre,
    activo: v.r_activo,
    eliminado: v.r_eliminado,
    pendientes: Number(v.r_pendientes),
  }));

  const vendedor = vendedores.find((v) => v.id === vendedorId) ?? null;

  const encabezado = (
    <EncabezadoPagina
      titulo="Liquidación semanal"
      subtitulo={
        <>
          Día por día y sorteo por sorteo, lo que queda por cuadrar con cada vendedor. Un sorteo
          pagado no vuelve a aparecer, así que un corte parcial —lunes y martes hoy, el resto el
          jueves— deja el informe limpio.
        </>
      }
    />
  );

  if (!vendedor) {
    return (
      <Pagina>
        {encabezado}
        <FiltrosLiquidacion
          vendedores={vendedores}
          vendedorId=""
          desde={desde}
          hasta={hasta}
          semanas={semanas}
        />
        <div className="mt-4">
          <TarjetaNota>
            Elija un vendedor para ver su hoja. La cuenta se cierra con uno a la vez: el pago es
            un gesto por persona, no un total del padrón.
          </TarjetaNota>
        </div>
      </Pagina>
    );
  }

  const [{ data: pendientes }, { data: sorteosRango }, { data: cortes }] = await Promise.all([
    supabase.rpc("fn_liquidacion_pendiente", {
      p_vendedor_id: vendedor.id,
      p_desde: desde,
      p_hasta: hasta,
    }),
    // Para avisar de que la semana no está completa. Un sorteo sin número
    // ganador no tiene fila en `liquidacion` y por eso no puede pagarse.
    supabase
      .from("sorteo")
      .select("id")
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .neq("estado", "liquidado"),
    supabase.rpc("fn_cortes_vendedor", { p_vendedor_id: vendedor.id, p_limite: 8 }),
  ]);

  const filas: FilaLiquidacion[] = (pendientes ?? []).map((f) => ({
    liquidacionId: f.r_liquidacion_id,
    fecha: f.r_fecha,
    hora: f.r_hora,
    ganador: f.r_numero_ganador,
    venta: Number(f.r_venta),
    comision: Number(f.r_comision),
    premios: Number(f.r_premios),
    saldo: Number(f.r_saldo),
  }));

  return (
    <Pagina>
      {encabezado}

      <div className="flex flex-col gap-4">
        <FiltrosLiquidacion
          vendedores={vendedores}
          vendedorId={vendedor.id}
          desde={desde}
          hasta={hasta}
          semanas={semanas}
        />

        <HojaLiquidacion
          filas={filas}
          vendedorId={vendedor.id}
          vendedorNombre={`${vendedor.codigo} · ${vendedor.nombre}`}
          desde={desde}
          hasta={hasta}
          sinLiquidar={sorteosRango?.length ?? 0}
        />

        {(cortes?.length ?? 0) > 0 && (
          <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
            <div className="px-[22px] py-4 border-b border-riel">
              <h2 className="text-h2 font-semibold tracking-sutil m-0">Pagos anteriores</h2>
              <p className="text-meta text-secundario mt-[5px] mb-0">
                Lo que ya se cerró con {vendedor.nombre}. Sus sorteos no vuelven al informe.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-tabla min-w-[640px]">
                <thead>
                  <tr className="bg-tinte">
                    {["RANGO", "SORTEOS", "VENTA", "COMISIÓN", "PREMIOS", "SALDO", "NOTA"].map(
                      (th, i) => (
                        <th
                          key={th}
                          className={cn(
                            "text-th font-semibold tracking-th text-secundario border-b border-riel py-[10px]",
                            i >= 1 && i <= 5 ? "text-right" : "text-left",
                            i === 0 ? "pl-4 pr-3" : i === 6 ? "pl-3 pr-4" : "px-3",
                          )}
                        >
                          {th}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {(cortes ?? []).map((c) => (
                    <tr key={c.r_corte_id}>
                      <td className="border-b border-fondo py-[11px] pl-4 pr-3 text-cuerpo">
                        {fechaLargaSinDia(c.r_desde)} — {fechaLargaSinDia(c.r_hasta)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right">
                        {c.r_sorteos}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right">
                        {fmt(Number(c.r_venta), false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(Number(c.r_comision), false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right text-cuerpo">
                        {fmt(Number(c.r_premios), false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] px-3 text-right font-semibold">
                        {fmt(Number(c.r_saldo), false)}
                      </td>
                      <td className="border-b border-fondo py-[11px] pl-3 pr-4 text-label text-secundario">
                        {c.r_nota ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Pagina>
  );
}
