/**
 * Tipos del esquema `public`, derivados de supabase/migrations/.
 *
 * Escritos a mano en vez de generados porque `supabase gen types` exige un
 * token personal o la contraseña de la base, que no tenemos. Si más adelante
 * hay alguno de los dos, este archivo se puede reemplazar por la salida de:
 *
 *     npx supabase gen types typescript \
 *       --project-id <ref> --schema public > lib/supabase/tipos.ts
 *
 * Mientras tanto: **al cambiar una migración, cambiar también este archivo.**
 */

/** Fila con los campos que la base rellena sola marcados como opcionales al insertar. */
type Insertable<Fila, Auto extends keyof Fila> = Omit<Fila, Auto> &
  Partial<Pick<Fila, Auto>>;

// --- Enumeraciones ---------------------------------------------------------

export type RolUsuario = "vendedor" | "digitador" | "administrador" | "auditor";
export type EstadoSorteo = "programado" | "abierto" | "cerrado" | "liquidado";
export type HoraSorteo = "11:00" | "15:00" | "20:00";
export type CanalTicket = "movil" | "ocr";
export type EstadoLote =
  | "cargado"
  | "extraido"
  | "en_revision"
  | "validado"
  | "rechazado";

// --- Filas -----------------------------------------------------------------

export type Vendedor = {
  id: string;
  codigo: string;
  nombre: string;
  identidad: string | null;
  telefono: string | null;
  correo: string | null;
  ciudad: string;
  barrio: string | null;
  zona: string;
  color: string;
  lat: number | null;
  lng: number | null;
  activo: boolean;
  creado_en: string;
  /** Baja definitiva. Sale del padrón; su historial queda intacto. */
  eliminado_en: string | null;
};

/** `comision` es FRACCIÓN (0.125 = 12.5 %), no porcentaje. */
export type ParametroVendedor = {
  id: string;
  vendedor_id: string;
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
  vigente_desde: string;
  /** `null` = fila vigente. Sólo puede haber una por vendedor. */
  vigente_hasta: string | null;
  creado_por: string | null;
};

export type Sorteo = {
  id: string;
  fecha: string;
  hora: HoraSorteo;
  estado: EstadoSorteo;
  hora_cierre: string;
  /** No nulo si y sólo si `estado === 'liquidado'`. */
  numero_ganador: number | null;
  liquidado_en: string | null;
  liquidado_por: string | null;
};

export type CupoNumero = {
  sorteo_id: string;
  numero: number;
  limite_casa: number;
  vendido: number;
};

export type Dispositivo = {
  id: string;
  etiqueta: string;
  vendedor_id: string | null;
  ultimo_visto: string | null;
  version_app: string | null;
  activo: boolean;
  creado_en: string;
};

export type CuotaDispositivo = {
  sorteo_id: string;
  dispositivo_id: string;
  numero: number;
  asignado: number;
  consumido: number;
};

export type Ticket = {
  id: string;
  folio: string;
  sorteo_id: string;
  vendedor_id: string;
  canal: CanalTicket;
  total: number;
  creado_en: string;
  creado_por: string | null;
  lat: number | null;
  lng: number | null;
  dispositivo_id: string | null;
  lote_ocr_id: string | null;
  anulado_en: string | null;
  anulado_por: string | null;
  motivo_anulacion: string | null;
  /** Registrado por administración con la venta ya cerrada. */
  forzado: boolean;
};

export type Linea = {
  id: string;
  ticket_id: string;
  numero: number;
  monto: number;
  /** Congelados en la venta. Cambiar los parámetros del vendedor no los toca. */
  comision_congelada: number;
  factor_congelado: number;
  gana: boolean;
  premio: number;
};

export type Liquidacion = {
  id: string;
  sorteo_id: string;
  vendedor_id: string;
  venta: number;
  comision: number;
  premios: number;
  utilidad: number;
  generada_en: string;
  usuario_id: string | null;
};

/** Un pago cerrado con un vendedor. Lo pagado son sus filas de CorteDetalle. */
export type CorteVendedor = {
  id: string;
  vendedor_id: string;
  desde: string;
  hasta: string;
  sorteos: number;
  venta: number;
  comision: number;
  premios: number;
  /** venta − comisión − premios. Positivo: el vendedor entrega. */
  saldo: number;
  nota: string | null;
  pagado_en: string;
  usuario_id: string | null;
};

/** El `unique` de `liquidacion_id` es lo que impide pagar dos veces un sorteo. */
/**
 * Venta capturada por totales, sin detalle de números (0047).
 *
 * No es un ticket: es un ajuste que entra en la liquidación como una fuente
 * más. Para el vendedor que trabajó en papel y entrega su cuenta al final.
 */
export type VentaTotal = {
  id: string;
  sorteo_id: string;
  vendedor_id: string;
  venta: number;
  premios: number;
  /** FRACCIÓN congelada al registrar: 0.15 = 15 %. */
  comision_congelada: number;
  nota: string | null;
  creado_en: string;
  creado_por: string | null;
  anulado_en: string | null;
};

export type CorteDetalle = {
  corte_id: string;
  liquidacion_id: string;
};

export type LoteOcr = {
  id: string;
  imagen_path: string;
  vendedor_id: string;
  sorteo_id: string;
  total_declarado: number;
  confianza_global: number | null;
  estado: EstadoLote;
  validado_por: string | null;
  validado_en: string | null;
  modelo: string | null;
  tokens_entrada: number | null;
  tokens_salida: number | null;
  costo_inferencia: number | null;
  creado_en: string;
};

export type Auditoria = {
  id: number;
  entidad: string;
  entidad_id: string | null;
  campo: string | null;
  valor_anterior: string | null;
  valor_nuevo: string | null;
  accion: string;
  usuario_id: string | null;
  ip: string | null;
  ocurrido_en: string;
};

export type UsuarioPerfil = {
  id: string;
  rol: RolUsuario;
  vendedor_id: string | null;
  nombre: string;
  creado_en: string;
};

export type Escenario = {
  id: string;
  nombre: string;
  desde: string;
  hasta: string;
  comision: number;
  factor_pago: number;
  creado_por: string | null;
  creado_en: string;
};

/**
 * Cuenta de acceso. Sustituye a `auth.users`: los usuarios se gestionan en el
 * esquema `public`, con la contraseña guardada como bcrypt (pgcrypto).
 *
 * El `hash` NO aparece aquí a propósito: ninguna consulta de la aplicación
 * debe traerlo, y omitirlo del tipo hace que el compilador lo recuerde.
 */
export type Usuario = {
  id: string;
  usuario: string;
  nombre: string;
  rol: RolUsuario;
  vendedor_id: string | null;
  activo: boolean;
  debe_cambiar: boolean;
  ultimo_acceso: string | null;
  creado_en: string;
  creado_por: string | null;
};

/** Límite de la casa por número, por franja horaria (§13). */
export type LimiteFranja = {
  hora: HoraSorteo;
  limite_casa: number;
  actualizado_en: string;
};

/** Única superficie legible sin autenticación. */
export type ResultadoPublico = {
  fecha: string;
  hora: HoraSorteo;
  numero_ganador: number;
};

// --- Forma que espera supabase-js ------------------------------------------

type Tabla<Fila, Auto extends keyof Fila> = {
  Row: Fila;
  Insert: Insertable<Fila, Auto>;
  Update: Partial<Fila>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      vendedor: Tabla<Vendedor, "id" | "activo" | "creado_en" | "eliminado_en">;
      parametro_vendedor: Tabla<ParametroVendedor, "id" | "vigente_desde" | "vigente_hasta" | "creado_por">;
      sorteo: Tabla<Sorteo, "id" | "estado" | "numero_ganador" | "liquidado_en" | "liquidado_por">;
      cupo_numero: Tabla<CupoNumero, "vendido">;
      dispositivo: Tabla<Dispositivo, "id" | "activo" | "creado_en" | "ultimo_visto" | "version_app" | "vendedor_id">;
      cuota_dispositivo: Tabla<CuotaDispositivo, "consumido">;
      ticket: Tabla<
        Ticket,
        | "id" | "creado_en" | "creado_por" | "lat" | "lng" | "dispositivo_id"
        | "lote_ocr_id" | "anulado_en" | "anulado_por" | "motivo_anulacion"
        | "forzado"
      >;
      linea: Tabla<Linea, "id" | "gana" | "premio">;
      liquidacion: Tabla<Liquidacion, "id" | "generada_en" | "usuario_id">;
      corte_vendedor: Tabla<CorteVendedor, "id" | "pagado_en" | "nota" | "usuario_id">;
      corte_detalle: Tabla<CorteDetalle, never>;
      venta_total: Tabla<
        VentaTotal,
        "id" | "comision_congelada" | "nota" | "creado_en" | "creado_por" | "anulado_en"
      >;
      lote_ocr: Tabla<
        LoteOcr,
        | "id" | "estado" | "creado_en" | "confianza_global" | "validado_por"
        | "validado_en" | "modelo" | "tokens_entrada" | "tokens_salida" | "costo_inferencia"
      >;
      auditoria: Tabla<Auditoria, "id" | "ocurrido_en">;
      usuario_perfil: Tabla<UsuarioPerfil, "creado_en" | "vendedor_id">;
      escenario: Tabla<Escenario, "id" | "creado_en" | "creado_por">;
      usuario: Tabla<
        Usuario,
        "id" | "activo" | "debe_cambiar" | "ultimo_acceso" | "creado_en" | "creado_por" | "vendedor_id"
      >;
      limite_franja: Tabla<LimiteFranja, "actualizado_en">;
    };
    Views: {
      v_resultado_publico: { Row: ResultadoPublico; Relationships: [] };
    };
    Functions: {
      fn_abrir_sorteo: {
        Args: { p_sorteo_id: string; p_limite_por_numero: number };
        Returns: undefined;
      };
      fn_cerrar_sorteo: {
        Args: { p_sorteo_id: string };
        Returns: undefined;
      };
      fn_registrar_ticket: {
        Args: {
          p_sorteo_id: string;
          p_vendedor_id: string;
          /** `[{ numero: 0..99, monto: number }]` */
          p_lineas: { numero: number; monto: number }[];
          p_lat?: number | null;
          p_lng?: number | null;
          p_dispositivo_id?: string | null;
          p_canal?: CanalTicket;
          p_lote_ocr_id?: string | null;
          /**
           * Levanta el corte por estado y por hora. Sólo la Server Action lo
           * pone a `true`, y sólo para un administrador: el navegador no
           * decide esto.
           */
          p_forzar?: boolean;
          p_usuario_id?: string | null;
        };
        Returns: { ticket_id: string; ticket_folio: string; ticket_total: number }[];
      };
      fn_registrar_tanda: {
        Args: {
          p_sorteo_id: string;
          p_vendedor_id: string;
          /** Un elemento por ticket: `[[{numero,monto}, …], [{…}], …]` */
          p_tickets: { numero: number; monto: number }[][];
          p_lat?: number | null;
          p_lng?: number | null;
          p_forzar?: boolean;
          p_usuario_id?: string | null;
          /** Marca del envío: la misma dos veces devuelve los folios ya
           *  creados en vez de duplicar la venta. Ver la 0056. */
          p_envio_id?: string | null;
        };
        /** `r_creado_en` es la hora que quedó guardada: es la que se imprime.
         *  `r_repetido` es true cuando el envío ya se había registrado. */
        Returns: {
          r_folio: string;
          r_total: number;
          r_creado_en: string;
          r_repetido: boolean;
        }[];
      };
      fn_reservar_cuota: {
        Args: {
          p_sorteo_id: string;
          p_dispositivo_id: string;
          p_monto_por_numero: number;
        };
        Returns: number;
      };
      fn_liquidar_sorteo: {
        Args: { p_sorteo_id: string; p_numero_ganador: number };
        Returns: {
          total_vendedores: number;
          total_lineas_ganadoras: number;
          total_premios: number;
        }[];
      };
      fn_anular_ticket: {
        Args: { p_ticket_id: string; p_motivo: string };
        Returns: undefined;
      };
      fn_guardar_parametros: {
        Args: {
          p_vendedor_id: string;
          /** Fracción: 0.125 para 12.5 %. */
          p_comision: number;
          p_factor_pago: number;
          p_tope_por_numero: number;
        };
        Returns: string;
      };
      /** Consulta de conveniencia. NO es autoritativa: la que manda es la de fn_registrar_ticket. */
      fn_cupo_disponible: {
        Args: { p_sorteo_id: string; p_vendedor_id: string; p_numero: number };
        Returns: number;
      };
      /**
       * Agregados del tablero. Corren como el invocador, así que RLS filtra:
       * un vendedor sólo agrega lo suyo. Liquidado y pendiente van separados.
       */
      fn_resumen_periodo: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          venta: number;
          comision: number;
          tickets: number;
          venta_liquidada: number;
          comision_liquidada: number;
          premios: number;
          utilidad: number;
          venta_pendiente: number;
          sorteos_liquidados: number;
          sorteos_pendientes: number;
        }[];
      };
      fn_resumen_mensual: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          anio: number;
          /** 0–11. */
          mes: number;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
          venta_pendiente: number;
        }[];
      };
      fn_resumen_vendedor: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          vendedor_id: string;
          codigo: string;
          nombre: string;
          color: string;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
        }[];
      };
      /** Simulador: recalcula el histórico liquidado con otros parámetros. */
      /** Ciclo automático de sorteos. Lo dispara pg_cron, no la aplicación. */
      fn_ciclo_sorteos: {
        Args: Record<string, never>;
        Returns: { accion: string; fecha: string; hora: HoraSorteo }[];
      };
      fn_simular: {
        Args: {
          p_desde: string;
          p_hasta: string;
          /** Fracción: 0.13 para 13 %. */
          p_comision: number;
          p_factor: number;
        };
        Returns: {
          anio: number;
          /** 0–11. */
          mes: number;
          dias: number;
          venta: number;
          comision_real: number;
          premios_real: number;
          utilidad_real: number;
          comision_sim: number;
          premios_sim: number;
          utilidad_sim: number;
        }[];
      };
      /** Comisión y factor reales del rango, ponderados por venta. */
      fn_parametros_ponderados: {
        Args: { p_desde: string; p_hasta: string };
        Returns: { comision_ponderada: number; factor_ponderado: number; venta: number }[];
      };
      fn_crear_lote_ocr: {
        Args: {
          p_imagen_path: string;
          p_vendedor_id: string;
          p_sorteo_id: string;
          p_total_declarado: number;
          p_confianza_global: number;
          p_modelo: string;
          p_tokens_entrada: number;
          p_tokens_salida: number;
          p_costo: number;
        };
        Returns: string;
      };
      /** Exige cuadre exacto y crea los tickets por la misma vía que la venta móvil. */
      fn_validar_lote_ocr: {
        Args: { p_lote_id: string; p_lineas: { numero: number; monto: number }[] };
        Returns: { ticket_id: string; ticket_folio: string; lineas: number }[];
      };
      fn_rechazar_lote_ocr: {
        Args: { p_lote_id: string; p_motivo: string };
        Returns: undefined;
      };
      fn_gasto_ocr: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          lotes: number;
          imagenes_validadas: number;
          costo_total: number;
          confianza_media: number;
        }[];
      };
      /** Filas paginadas del reporte. Los subtotales van aparte, a propósito. */
      fn_reporte_filas: {
        Args: {
          p_desde: string;
          p_hasta: string;
          p_vendedor_id?: string | null;
          p_hora?: HoraSorteo | null;
          p_numero?: number | null;
          p_limite?: number;
          p_desde_fila?: number;
        };
        Returns: {
          fecha: string;
          hora: HoraSorteo;
          estado: EstadoSorteo;
          numero_ganador: number | null;
          vendedor_id: string;
          vendedor: string;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
        }[];
      };
      /** Subtotales sobre el filtro COMPLETO, no sobre la página visible. */
      fn_reporte_totales: {
        Args: {
          p_desde: string;
          p_hasta: string;
          p_vendedor_id?: string | null;
          p_hora?: HoraSorteo | null;
          p_numero?: number | null;
        };
        Returns: {
          registros: number;
          dias: number;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
          venta_pendiente: number;
          registros_pendientes: number;
        }[];
      };
      /** La única consulta que baja a la línea individual. */
      fn_bitacora_vendedor: {
        Args: { p_vendedor_id: string; p_fecha: string; p_hora?: HoraSorteo | null };
        Returns: {
          creado_en: string;
          hora: HoraSorteo;
          estado: EstadoSorteo;
          folio: string;
          numero: number;
          monto: number;
          gana: boolean;
          premio: number;
          lat: number | null;
          lng: number | null;
        }[];
      };
      fn_actividad_horaria: {
        Args: { p_vendedor_id: string; p_fecha: string };
        Returns: { hora_reloj: number; monto: number }[];
      };
      fn_resumen_dia: {
        Args: { p_fecha: string };
        Returns: {
          sorteo_id: string;
          hora: HoraSorteo;
          estado: EstadoSorteo;
          numero_ganador: number | null;
          tickets: number;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
        }[];
      };
      /**
       * Un punto por ticket para el mapa, con las líneas ya contadas en la
       * base. Sustituye a traer las líneas del día y contarlas en el cliente.
       */
      /** Alta de cuenta. Devuelve el id del usuario creado. */
      fn_crear_usuario: {
        Args: {
          p_usuario: string;
          p_contrasena: string;
          p_nombre: string;
          p_rol: RolUsuario;
          p_vendedor_id?: string | null;
        };
        Returns: string;
      };
      /** Verifica con bcrypt dentro de la base. Sin filas = credenciales malas. */
      fn_autenticar: {
        Args: { p_usuario: string; p_contrasena: string };
        Returns: {
          r_id: string;
          r_nombre: string;
          r_rol: RolUsuario;
          r_vendedor_id: string | null;
          r_debe_cambiar: boolean;
        }[];
      };
      fn_cambiar_contrasena: {
        Args: { p_usuario_id: string; p_actual: string; p_nueva: string };
        Returns: undefined;
      };
      /** Por administración: no exige la actual y deja la nueva de un solo uso. */
      fn_restablecer_contrasena: {
        Args: { p_usuario_id: string; p_nueva: string };
        Returns: undefined;
      };
      fn_usuario: {
        Args: { p_id: string };
        Returns: {
          r_id: string;
          r_usuario: string;
          r_nombre: string;
          r_rol: RolUsuario;
          r_vendedor_id: string | null;
          r_activo: boolean;
          r_debe_cambiar: boolean;
        }[];
      };
      /** Qué vendedores ya tienen cuenta, para no ofrecer el alta dos veces. */
      fn_accesos_vendedor: {
        Args: Record<string, never>;
        Returns: { r_vendedor_id: string; r_usuario: string; r_activo: boolean }[];
      };
      /** El día de UN vendedor, sorteo por sorteo. El filtro va explícito. */
      fn_mi_dia: {
        Args: { p_vendedor_id: string; p_fecha: string };
        Returns: {
          r_sorteo_id: string;
          r_hora: HoraSorteo;
          r_estado: EstadoSorteo;
          r_ganador: number | null;
          r_tickets: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
        }[];
      };
      fn_mis_tickets: {
        Args: { p_vendedor_id: string; p_fecha: string; p_limite?: number };
        Returns: {
          r_folio: string;
          r_hora: HoraSorteo;
          r_creado_en: string;
          r_total: number;
          r_lineas: number;
          r_premio: number;
          r_anulado: boolean;
        }[];
      };
      /** Totales por vendedor en un rango. p_vendedores nulo = todos. */
      fn_control_vendedores: {
        Args: {
          p_desde: string;
          p_hasta: string;
          p_vendedores?: string[] | null;
          p_hora?: HoraSorteo | null;
        };
        Returns: {
          r_vendedor_id: string;
          r_codigo: string;
          r_nombre: string;
          r_zona: string;
          r_color: string;
          r_tickets: number;
          r_lineas: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_utilidad: number;
          r_pendiente: number;
        }[];
      };
      /** Venta por día del conjunto elegido. Incluye los días sin venta. */
      fn_control_serie: {
        Args: {
          p_desde: string;
          p_hasta: string;
          p_vendedores?: string[] | null;
          p_hora?: HoraSorteo | null;
        };
        Returns: { r_fecha: string; r_venta: number; r_tickets: number }[];
      };
      fn_control_actividad: {
        Args: { p_desde: string; p_hasta: string; p_vendedores?: string[] | null };
        Returns: { r_hora: number; r_monto: number }[];
      };
      /** La bitácora, por rango. Única vista que baja a la línea individual. */
      fn_bitacora_rango: {
        Args: {
          p_vendedor_id: string;
          p_desde: string;
          p_hasta: string;
          p_hora?: HoraSorteo | null;
          p_limite?: number;
        };
        Returns: {
          r_fecha: string;
          r_creado_en: string;
          r_hora: HoraSorteo;
          r_estado: EstadoSorteo;
          r_folio: string;
          r_numero: number;
          r_monto: number;
          r_gana: boolean;
          r_premio: number;
          r_lat: number | null;
          r_lng: number | null;
        }[];
      };
      fn_mapa_dia: {
        Args: { p_fecha: string; p_vendedor_id?: string | null };
        Returns: {
          r_folio: string;
          r_lat: number;
          r_lng: number;
          r_total: number;
          r_creado_en: string;
          r_vendedor_id: string;
          r_hora: HoraSorteo;
          r_lineas: number;
        }[];
      };
      /**
       * Lo vendido por cada vendedor en cada número de un sorteo. Dato de
       * conveniencia para el POS; NO es autoritativo (§3).
       */
      fn_vendido_por_vendedor: {
        Args: { p_sorteo_id: string };
        Returns: { r_vendedor_id: string; r_numero: number; r_vendido: number }[];
      };
      /** Utilidad del sorteo para cada uno de los 100 números posibles. */
      fn_utilidad_por_numero: {
        Args: { p_sorteo_id: string };
        Returns: { r_numero: number; r_pago: number; r_utilidad: number }[];
      };
      /** Repone las filas de cupo que falten, reconstruyendo lo vendido. */
      fn_reparar_cupo: {
        Args: { p_sorteo_id: string };
        Returns: number;
      };
      fn_desglose_dia: {
        Args: { p_fecha: string };
        Returns: {
          vendedor_id: string;
          nombre: string;
          hora: HoraSorteo;
          estado: EstadoSorteo;
          venta: number;
          comision: number;
          premios: number;
          utilidad: number;
        }[];
      };
      /** Lectura. Con `p_numero` nulo devuelve sólo venta, comisión y tickets. */
      fn_impacto_numero: {
        Args: { p_sorteo_id: string; p_numero?: number | null };
        Returns: {
          venta: number;
          comision: number;
          tickets: number;
          lineas_ganadoras: number;
          pago: number;
          utilidad: number;
        }[];
      };
      /** El número que más costaría si saliera (regla de peor escenario, §5). */
      fn_peor_escenario: {
        Args: { p_sorteo_id: string };
        Returns: { numero: number; pago: number; utilidad_peor: number }[];
      };
      fn_crear_vendedor: {
        Args: {
          p_nombre: string;
          p_telefono: string;
          p_correo: string;
          p_identidad: string;
          p_ciudad: string;
          p_barrio: string;
          p_lat: number;
          p_lng: number;
          p_color: string;
          /** Fracción: 0.125 para 12.5 %. */
          p_comision: number;
          p_factor_pago: number;
          p_tope_por_numero: number;
        };
        Returns: { vendedor_id: string; vendedor_codigo: string }[];
      };
      /** Crea los tres sorteos de una fecha, en estado `programado`. */
      fn_programar_dia: { Args: { p_fecha: string }; Returns: number };
      fn_es_servicio: { Args: Record<string, never>; Returns: boolean };
      fn_exige: { Args: { p_roles: RolUsuario[] }; Returns: undefined };
      fn_rol_actual: { Args: Record<string, never>; Returns: RolUsuario };
      fn_vendedor_actual: { Args: Record<string, never>; Returns: string | null };
      fn_auditar: {
        Args: {
          p_entidad: string;
          p_entidad_id: string;
          p_accion: string;
          p_campo?: string | null;
          p_valor_anterior?: string | null;
          p_valor_nuevo?: string | null;
        };
        Returns: undefined;
      };

      // --- Bajas de vendedor (0031) -------------------------------------
      fn_desactivar_vendedor: {
        Args: { p_vendedor_id: string; p_usuario_id?: string | null };
        Returns: undefined;
      };
      fn_activar_vendedor: {
        Args: { p_vendedor_id: string; p_usuario_id?: string | null };
        Returns: undefined;
      };
      fn_eliminar_vendedor: {
        Args: { p_vendedor_id: string; p_usuario_id?: string | null };
        Returns: undefined;
      };
      /** Lo que invalida una cookie de sesión, que por sí sola no se puede revocar. */
      fn_sesion_vigente: { Args: { p_usuario_id: string }; Returns: boolean };

      // --- Liquidación semanal (0032) -----------------------------------
      fn_liquidacion_pendiente: {
        Args: { p_vendedor_id: string; p_desde: string; p_hasta: string };
        Returns: {
          r_liquidacion_id: string;
          r_sorteo_id: string;
          r_fecha: string;
          r_hora: HoraSorteo;
          r_numero_ganador: number | null;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_saldo: number;
        }[];
      };
      fn_registrar_corte: {
        Args: {
          p_vendedor_id: string;
          p_liquidacion_ids: string[];
          p_desde: string;
          p_hasta: string;
          p_nota?: string | null;
          p_usuario_id?: string | null;
        };
        Returns: {
          r_corte_id: string;
          r_sorteos: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_saldo: number;
        }[];
      };
      fn_cortes_vendedor: {
        Args: { p_vendedor_id: string; p_limite?: number };
        Returns: {
          r_corte_id: string;
          r_desde: string;
          r_hasta: string;
          r_sorteos: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_saldo: number;
          r_nota: string | null;
          r_pagado_en: string;
        }[];
      };
      /** Los activos, más los de baja que todavía tienen sorteos sin pagar. */
      fn_vendedores_liquidables: {
        Args: Record<string, never>;
        Returns: {
          r_vendedor_id: string;
          r_codigo: string;
          r_nombre: string;
          r_activo: boolean;
          r_eliminado: boolean;
          r_pendientes: number;
        }[];
      };

      // --- Reporte del vendedor (0034) ----------------------------------
      /** Rejilla día × sorteo de un vendedor, con la marca de pago. */
      fn_mi_periodo: {
        Args: { p_vendedor_id: string; p_desde: string; p_hasta: string };
        Returns: {
          r_fecha: string;
          r_hora: HoraSorteo;
          r_estado: EstadoSorteo;
          r_ganador: number | null;
          r_tickets: number;
          r_venta: number;
          /** Lo APOSTADO al número que salió; `r_premios` es lo que costó pagarlo. */
          r_premiado: number;
          r_comision: number;
          r_premios: number;
          r_pagado: boolean;
        }[];
      };

      // --- Informe de gerencia (0036) -----------------------------------
      /** Una fila por vendedor, con el desglose de la hoja del gerente. */
      fn_informe_gerencia: {
        /** `p_hora` en nulo suma las tres loterías. */
        Args: { p_desde: string; p_hasta: string; p_hora?: HoraSorteo | null };
        Returns: {
          r_vendedor_id: string;
          r_codigo: string;
          r_nombre: string;
          /** Liquidada MÁS pendiente: la venta se conoce aunque no se liquide. */
          r_venta: number;
          /** La parte de `r_venta` que viene de sorteos sin liquidar. */
          r_venta_pendiente: number;
          /** Lo APOSTADO al número ganador, no lo pagado por él. */
          r_premiado: number;
          r_factor: number;
          /** NULL mientras no haya nada liquidado: sin número ganador no se
           *  sabe qué se pagó, y un 0 afirmaría que no se pagó nada. */
          r_pago: number | null;
          /** Fracción: 0.20, no 20. */
          r_porcentaje: number;
          r_comision: number;
          r_bruto: number;
          /** NULL mientras no haya nada liquidado. Ver `r_pago`. */
          r_neto: number | null;
          /** Si el día incluye sorteos todavía sin liquidar. */
          r_tiene_pendiente: boolean;
        }[];
      };

      // --- Análisis de resultados (0038) --------------------------------
      /** Una fila por período, al grano pedido. Sólo sorteos liquidados. */
      // --- Informes de gerencia por semana y por vendedor (0040) --------
      // --- Cobro semana a semana (0043) ---------------------------------
      // --- La semana entera y sus abonos (0046) --------------------------
      fn_semana_completa: {
        Args: { p_vendedor_id: string; p_desde: string; p_hasta: string };
        Returns: {
          r_liquidacion_id: string;
          r_fecha: string;
          r_hora: HoraSorteo;
          r_numero_ganador: number | null;
          r_venta: number;
          /** Lo APOSTADO al número que salió. */
          r_premiado: number;
          /** Multiplicador efectivo del sorteo: premios / premiado. */
          r_factor: number;
          r_comision: number;
          r_premios: number;
          r_saldo: number;
          /** En qué corte se cerró. Nulo mientras siga pendiente. */
          r_corte_id: string | null;
          r_pagado_en: string | null;
        }[];
      };

      fn_abonos_semana: {
        Args: { p_vendedor_id: string; p_desde: string; p_hasta: string };
        Returns: {
          r_corte_id: string;
          r_pagado_en: string;
          r_sorteos: number;
          /** La parte de ese corte que cae en esta semana, no el total. */
          r_saldo: number;
          r_nota: string | null;
        }[];
      };

      // --- Venta por totales (0047 / 0049) -------------------------------
      fn_registrar_venta_total: {
        Args: {
          p_sorteo_id: string;
          p_vendedor_id: string;
          p_venta: number;
          p_premios: number;
          p_nota?: string | null;
          p_usuario_id?: string | null;
        };
        Returns: { r_id: string; r_comision: number; r_saldo: number }[];
      };

      fn_anular_venta_total: {
        Args: { p_id: string; p_usuario_id?: string | null };
        Returns: undefined;
      };

      // --- Saldos por vendedor (0051) ------------------------------------
      fn_saldos_por_vendedor: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          r_vendedor_id: string;
          r_codigo: string;
          r_nombre: string;
          r_activo: boolean;
          /** Pendiente de las semanas anteriores a `p_desde`. */
          r_anterior: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          /** Saldo de la semana: venta − comisión − premios. */
          r_semana: number;
          r_liquidado: number;
          r_pendiente: number;
          /** `r_anterior` + `r_pendiente`. */
          r_actual: number;
        }[];
      };

      fn_liquidacion_por_semana: {
        /** Sin vendedor, el negocio entero. */
        Args: { p_vendedor_id?: string | null };
        Returns: {
          r_inicio: string;
          r_fin: string;
          r_semana: number;
          r_anio: number;
          r_sorteos: number;
          r_liquidaciones: number;
          r_pagadas: number;
          r_pendientes: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          /** Todo lo de la semana: `r_pagado` + `r_pendiente`. */
          r_saldo: number;
          r_pagado: number;
          /** En neto: `r_por_cobrar` − `r_por_pagar`. */
          r_pendiente: number;
          /** De lo pendiente, lo que entregan los vendedores que deben. */
          r_por_cobrar: number;
          /** De lo pendiente, lo que entrega la casa. Positivo. */
          r_por_pagar: number;
          /** Lo pendiente de las semanas ANTERIORES, en neto. */
          r_arrastre: number;
          /** `r_arrastre` + `r_pendiente`: la cuenta completa a esa fecha. */
          r_acumulado: number;
        }[];
      };

      fn_semanas_operadas: {
        Args: Record<string, never>;
        Returns: {
          r_inicio: string;
          r_fin: string;
          r_semana: number;
          r_anio: number;
          r_dias: number;
          r_sorteos: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_neto: number;
        }[];
      };

      fn_resumen_semanal: {
        Args: { p_desde: string; p_hasta: string };
        Returns: {
          r_vendedor_id: string;
          r_codigo: string;
          r_nombre: string;
          r_activo: boolean;
          /** Fracción vigente al cerrar la semana: 0.15 = 15 %. Nulo si nunca tuvo parámetros. */
          r_comision: number | null;
          r_tope: number | null;
          r_factor: number | null;
          r_venta: number;
          r_premiado: number;
          r_pago: number;
          /** La comisión en lempiras, no la tasa: la tasa es `r_comision`. */
          r_comision_l: number;
          r_bruto: number;
          r_neto: number;
        }[];
      };

      fn_historial_vendedor: {
        Args: { p_vendedor_id: string };
        Returns: {
          r_inicio: string;
          r_fin: string;
          r_semana: number;
          r_anio: number;
          r_sorteos: number;
          r_venta: number;
          r_premiado: number;
          r_premios: number;
          r_comision: number;
          r_neto: number;
        }[];
      };

      // --- Resultado por día de la semana (0041) -------------------------
      fn_resultado_por_dia_semana: {
        Args: Record<string, never>;
        Returns: {
          /** 1 = lunes … 7 = domingo. */
          r_dow: number;
          r_dias: number;
          r_sorteos: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_neto: number;
        }[];
      };

      fn_analisis_resultados: {
        Args: {
          p_desde: string;
          p_hasta: string;
          /** `sorteo` · `dia` · `semana` · `mes` · `anio`. */
          p_grano: string;
          p_vendedor_id?: string | null;
          p_hora?: HoraSorteo | null;
        };
        Returns: {
          r_inicio: string;
          r_fin: string;
          /** Sólo con el grano `sorteo`; nulo en los demás. */
          r_hora: HoraSorteo | null;
          /** Sólo con el grano `sorteo`: a ese grano la tarjeta ES un sorteo. */
          r_numero_ganador: number | null;
          r_dias: number;
          r_sorteos: number;
          r_venta: number;
          r_comision: number;
          r_premios: number;
          r_utilidad: number;
        }[];
      };

      // --- Venta de administración (0033) -------------------------------
      fn_recalcular_liquidacion: {
        Args: { p_sorteo_id: string; p_vendedor_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      rol_usuario: RolUsuario;
      estado_sorteo: EstadoSorteo;
      hora_sorteo: HoraSorteo;
      canal_ticket: CanalTicket;
      estado_lote: EstadoLote;
    };
    CompositeTypes: Record<string, Record<string, unknown>>;
  };
};
