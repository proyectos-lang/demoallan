import { TablaVendedores, type FilaVendedor } from "@/components/vendedores/tabla-vendedores";
import { Pagina } from "@/components/ui/pagina";
import { TarjetaNota } from "@/components/ui/tarjeta";
import { crearClienteServidor } from "@/lib/supabase/server";

// TODO(Fase 1): el límite global pasa a ser por franja horaria, leído de
// cupo_numero del sorteo vigente. Mientras no haya sorteos, este es el valor
// de referencia del prototipo.
const LIMITE_GLOBAL_REFERENCIA = 6000;

export default async function VendedoresPage() {
  const supabase = await crearClienteServidor();

  // `!inner` + vigente_hasta is null trae exactamente la fila de parámetros
  // vigente de cada vendedor; las versiones anteriores quedan fuera.
  // Quién ya tiene cuenta, para ofrecer el alta sólo a quien le falta.
  const { data: accesos } = await supabase.rpc("fn_accesos_vendedor");
  const usuarioPorVendedor = new Map(
    (accesos ?? []).map((a) => [a.r_vendedor_id, a.r_usuario]),
  );

  const { data, error } = await supabase
    .from("vendedor")
    .select(
      "id, codigo, nombre, identidad, telefono, correo, zona, color, parametro_vendedor!inner(comision, factor_pago, tope_por_numero, vigente_hasta)",
    )
    .eq("activo", true)
    .is("parametro_vendedor.vigente_hasta", null)
    .order("codigo");

  if (error) {
    return (
      <Pagina>
        <TarjetaNota>No se pudieron cargar los vendedores: {error.message}</TarjetaNota>
      </Pagina>
    );
  }

  const filas: FilaVendedor[] = (data ?? []).map((v) => {
    const p = Array.isArray(v.parametro_vendedor)
      ? v.parametro_vendedor[0]
      : v.parametro_vendedor;
    return {
      id: v.id,
      codigo: v.codigo,
      nombre: v.nombre,
      identidad: v.identidad,
      telefono: v.telefono,
      correo: v.correo,
      zona: v.zona,
      color: v.color,
      usuario: usuarioPorVendedor.get(v.id) ?? null,
      // La base guarda fracción; aquí se muestra porcentaje.
      comision: Number((Number(p.comision) * 100).toFixed(4)),
      factor_pago: Number(p.factor_pago),
      tope_por_numero: Number(p.tope_por_numero),
    };
  });

  return (
    <Pagina>
      <TablaVendedores filas={filas} limiteGlobal={LIMITE_GLOBAL_REFERENCIA} />
    </Pagina>
  );
}
