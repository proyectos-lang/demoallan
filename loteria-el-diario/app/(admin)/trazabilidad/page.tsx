import { redirect } from "next/navigation";

import { FiltrosTrazabilidad } from "@/components/trazabilidad/filtros-trazabilidad";
import { EncabezadoPagina, Pagina } from "@/components/ui/pagina";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLarga, hora12, hoyHonduras, iso } from "@/lib/format";
import { sesionActual } from "@/lib/sesion";
import { crearClienteServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cómo se lee cada acción.
 *
 * La base guarda verbos cortos —`editar`, `anular`— porque son el dato; aquí se
 * traducen a lo que entiende quien audita. Lo que no esté en la lista se
 * enseña tal cual: es mejor un verbo crudo que una fila que se pierde.
 */
const ACCIONES: Record<string, string> = {
  crear: "Creó",
  editar: "Corrigió",
  anular: "Anuló",
  registrar: "Registró",
  registrar_forzado: "Registró fuera de hora",
  pagar: "Pagó",
  actualizar: "Cambió",
  recalcular: "Recalculó hacia atrás",
  abrir: "Abrió",
  cerrar: "Cerró",
  liquidar: "Liquidó",
  programar_dia: "Programó el día",
  cambiar_contrasena: "Cambió la contraseña",
};

const ENTIDADES: Record<string, string> = {
  ticket: "Venta",
  venta_total: "Captura por totales",
  vendedor: "Vendedor",
  parametro_vendedor: "Parámetros",
  corte_vendedor: "Corte",
  abono_vendedor: "Abono",
  sorteo: "Sorteo",
  usuario: "Usuario",
};

/**
 * Trazabilidad: quién cambió qué, cuándo, y de qué valor a cuál.
 *
 * QUÉ PREGUNTA CONTESTA
 * ---------------------
 * «Esta venta decía otra cosa ayer» y «¿quién le subió la comisión?». Hasta
 * ahora eso sólo se podía averiguar consultando la base a mano, y el dato ya
 * estaba: `auditoria` lleva miles de apuntes con el valor anterior y el nuevo.
 *
 * NO SE TOCA NADA DESDE AQUÍ, a propósito. Es una pantalla de lectura; si
 * además dejara deshacer, cada deshacer generaría su propio apunte y la
 * trazabilidad empezaría a hablar de sí misma.
 *
 * LOS APUNTES VIEJOS NO TIENEN AUTOR. Antes de la 0083 el usuario se sacaba de
 * `auth.uid()`, que es nulo desde que la aplicación habla como `service_role`.
 * Se dice «no registrado» en vez de inventar un nombre.
 */
export default async function TrazabilidadPage({
  searchParams,
}: PageProps<"/trazabilidad">) {
  const sesion = await sesionActual();
  if (sesion && sesion.rol !== "administrador" && sesion.rol !== "auditor") {
    redirect("/tablero");
  }

  const params = await searchParams;
  const texto = (clave: string) =>
    typeof params[clave] === "string" ? (params[clave] as string) : "";

  const hoy = iso(hoyHonduras());
  const pedidoDesde = texto("desde");
  const pedidoHasta = texto("hasta");

  // Por omisión, hoy. Quien entra aquí viene de algo que acaba de pasar.
  const desde = FECHA.test(pedidoDesde) ? pedidoDesde : hoy;
  const hasta = FECHA.test(pedidoHasta) ? pedidoHasta : hoy;

  const accion = texto("accion");
  const entidad = texto("entidad");
  const usuarioPedido = texto("usuario");
  const usuario = UUID.test(usuarioPedido) ? usuarioPedido : "";

  const supabase = await crearClienteServidor();

  const [{ data: filas, error }, { data: opciones }] = await Promise.all([
    supabase.rpc("fn_trazabilidad", {
      p_desde: desde,
      p_hasta: hasta,
      p_accion: accion || null,
      p_entidad: entidad || null,
      p_usuario_id: usuario || null,
      p_limite: 500,
    }),
    supabase.rpc("fn_trazabilidad_filtros", { p_desde: desde, p_hasta: hasta }),
  ]);

  if (error) {
    return (
      <Pagina>
        <EncabezadoPagina titulo="Trazabilidad" subtitulo="Quién cambió qué, y cuándo." />
        <TarjetaNota>
          {error.code === "PGRST202"
            ? "La trazabilidad todavía no está habilitada en la base de datos. Falta aplicar la migración 0083."
            : `No se pudo cargar: ${error.message}`}
        </TarjetaNota>
      </Pagina>
    );
  }

  const deTipo = (t: string) =>
    (opciones ?? [])
      .filter((o) => o.r_tipo === t)
      .map((o) => ({ valor: o.r_valor, rotulo: o.r_rotulo, cuantos: o.r_cuantos }));

  const registros = filas ?? [];
  const sinAutor = registros.filter((f) => !f.r_usuario_id).length;

  return (
    <Pagina>
      <EncabezadoPagina
        titulo="Trazabilidad"
        subtitulo="Cada cambio registrado: quién lo hizo, a qué hora exacta, y de qué valor a cuál. No se puede modificar nada desde aquí."
      />

      <Tarjeta padding="14px 18px">
        <FiltrosTrazabilidad
          desde={desde}
          hasta={hasta}
          accion={accion}
          entidad={entidad}
          usuario={usuario}
          hoy={hoy}
          acciones={deTipo("accion").map((a) => ({
            ...a,
            rotulo: ACCIONES[a.valor] ?? a.valor,
          }))}
          entidades={deTipo("entidad").map((e) => ({
            ...e,
            rotulo: ENTIDADES[e.valor] ?? e.valor,
          }))}
          usuarios={deTipo("usuario").filter((u) => u.valor !== "")}
        />
      </Tarjeta>

      <Tarjeta padding="18px 20px">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-h2 font-semibold tracking-sutil m-0">
              {registros.length} {registros.length === 1 ? "cambio" : "cambios"}
              {registros.length === 500 && " (los más recientes)"}
            </h2>
            <p className="text-micro text-secundario mt-[5px] mb-0">
              {desde === hasta
                ? fechaLarga(desde)
                : `Del ${fechaLarga(desde)} al ${fechaLarga(hasta)}`}
            </p>
          </div>
        </div>

        {/*
          Los apuntes sin autor no son un fallo de esta pantalla: son de antes
          de que el sistema guardara quién hacía cada cosa. Decirlo aquí evita
          que alguien concluya que la trazabilidad no funciona.
        */}
        {sinAutor > 0 && (
          <p className="text-meta text-secundario mt-4 mb-0 leading-[1.5]">
            {sinAutor === registros.length
              ? "Ninguno de estos cambios tiene autor registrado"
              : `${sinAutor} de estos cambios no tienen autor registrado`}
            : son anteriores a que el sistema empezara a guardarlo. Los nuevos sí lo llevan.
          </p>
        )}
      </Tarjeta>

      {registros.length === 0 ? (
        <TarjetaNota>
          No hay ningún cambio registrado con esos filtros.
        </TarjetaNota>
      ) : (
        <Tarjeta padding="0">
          <div className="overflow-auto max-h-[70dvh]">
            <table className="w-full border-collapse text-tabla">
              <thead className="sticky top-0 z-10 bg-superficie">
                <tr className="text-left">
                  {["CUÁNDO", "QUIÉN", "QUÉ HIZO", "SOBRE", "ANTES", "DESPUÉS"].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "border-b border-borde py-[10px] px-3 text-eyebrow font-semibold tracking-seccion text-secundario",
                        i === 0 && "pl-4",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {registros.map((f) => (
                  <tr key={f.r_id}>
                    <td className="border-b border-fondo py-[10px] pl-4 pr-3 whitespace-nowrap align-top">
                      <span className="block text-cuerpo tabular-nums">
                        {new Date(f.r_ocurrido_en).toLocaleTimeString("es-HN", {
                          timeZone: "America/Tegucigalpa",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: true,
                        })}
                      </span>
                      <span className="block text-label text-mudo">
                        {new Date(f.r_ocurrido_en).toLocaleDateString("es-HN", {
                          timeZone: "America/Tegucigalpa",
                          day: "2-digit",
                          month: "2-digit",
                        })}
                      </span>
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 align-top">
                      {f.r_usuario ? (
                        <>
                          <span className="block text-cuerpo">{f.r_usuario}</span>
                          <span className="block text-label text-mudo">{f.r_rol}</span>
                        </>
                      ) : (
                        <span className="text-label text-mudo italic">no registrado</span>
                      )}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 align-top">
                      <span className="block text-cuerpo">
                        {ACCIONES[f.r_accion] ?? f.r_accion}
                      </span>
                      {f.r_campo && (
                        <span className="block text-label text-mudo">{f.r_campo}</span>
                      )}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 align-top">
                      <span className="block text-cuerpo">
                        {ENTIDADES[f.r_entidad] ?? f.r_entidad}
                      </span>
                      {/* De quién y de qué sorteo, cuando se puede saber: sin
                          esto un apunte dice «se corrigió una venta» y hay que
                          ir a buscar cuál. */}
                      {f.r_vendedor && (
                        <span className="block text-label text-mudo">
                          {f.r_codigo} · {f.r_vendedor}
                          {f.r_fecha && f.r_hora
                            ? ` · ${fechaLarga(f.r_fecha)} ${hora12(f.r_hora)}`
                            : ""}
                        </span>
                      )}
                    </td>
                    {/*
                      Los dos valores en monoespaciada: muchos son jugadas
                      —`07:100  42:250`— y alineadas se comparan de un vistazo
                      en vez de leerlas enteras.
                    */}
                    <td className="border-b border-fondo py-[10px] px-3 align-top font-mono text-micro text-secundario max-w-[280px] break-words">
                      {f.r_valor_anterior ?? "—"}
                    </td>
                    <td className="border-b border-fondo py-[10px] px-3 align-top font-mono text-micro text-cuerpo max-w-[280px] break-words">
                      {f.r_valor_nuevo ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      )}
    </Pagina>
  );
}
