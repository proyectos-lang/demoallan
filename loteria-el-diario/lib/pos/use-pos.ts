"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import {
  registrarVenta,
  type LineaVenta,
  type TicketRegistrado,
} from "@/app/(admin)/punto-de-venta/acciones";
import { fmt, pad2 } from "@/lib/format";

export type EstadoSorteoPos = "programado" | "abierto" | "cerrado" | "liquidado";

export type SorteoPos = {
  id: string;
  /** `YYYY-MM-DD`. Va impresa en el ticket, junto a la hora del sorteo. */
  fecha: string;
  /** Etiqueta del enum: `"11:00"`, `"15:00"`, `"20:00"`. No es un instante. */
  hora: string;
  hora_cierre: string;
  estado: EstadoSorteoPos;
};

export type VendedorPos = {
  id: string;
  codigo: string;
  nombre: string;
  /** Fracción, como en la base. */
  comision: number;
  factor_pago: number;
  tope_por_numero: number;
};

export type DatosPos = {
  sorteo: SorteoPos;
  /**
   * Los sorteos del día, para el selector. Para un vendedor trae uno solo: no
   * elige, se le asigna el que está vendiendo.
   */
  sorteos: SorteoPos[];
  vendedores: VendedorPos[];
  /** Por número: lo que le queda a la casa. */
  disponibleCasa: number[];
  /** Por vendedor y número: lo que ese vendedor ya vendió. */
  vendidoPropio: Record<string, number[]>;
  /**
   * Modo del propio vendedor: el selector desaparece porque el vendedor sale
   * de la sesión, no de una lista. Quién vende de verdad lo decide el servidor
   * en la acción de registro; esto es sólo la interfaz.
   */
  propio?: boolean;
  /**
   * Si este perfil puede registrar con la venta ya cerrada. Lo calcula el
   * servidor a partir de la sesión y aquí sólo se usa para pintar; la acción
   * lo vuelve a decidir por su cuenta y no se cree lo que venga del navegador.
   */
  puedeForzar?: boolean;
};

/** Un ticket cerrado que espera a que se confirme la tanda. */
export type TicketEnTanda = { lineas: LineaVenta[]; total: number };

export type Foco = "numero" | "monto";
export type Modo = "teclado" | "rapida" | "rejilla";

export const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "←"];
export const MONTOS_RAPIDOS = [10, 20, 50, 100];
export const ATAJOS: [number, number][] = [
  [47, 50],
  [23, 20],
  [88, 100],
  [5, 10],
];

/** Umbral bajo el cual el cupo se pinta en ámbar, como el prototipo. */
export const CUPO_BAJO = 300;

/**
 * Todo el estado del punto de venta, en un solo sitio.
 *
 * Se llama `usePos` y no `usarPos`, que es lo que pediría el resto del código:
 * la regla `react-hooks/rules-of-hooks` reconoce los hooks por el prefijo
 * `use` y con un nombre en español rechaza cada `useState` de aquí dentro. Es
 * la única concesión al inglés del proyecto, y es del linter, no de gusto.
 *
 * Vive fuera del componente porque las dos vistas —escritorio y móvil— son
 * disposiciones distintas del MISMO estado. Si cada una llevara el suyo, un
 * cambio de tamaño de ventana perdería el ticket a medio teclear, y habría dos
 * copias de la aritmética de cupo que mantener a la par.
 */
export function usePos(datos: DatosPos) {
  const [vendedorId, setVendedorId] = useState(datos.vendedores[0]?.id ?? "");
  const [modo, setModo] = useState<Modo>("teclado");
  const [numero, setNumero] = useState("");
  const [monto, setMonto] = useState("");
  const [foco, setFoco] = useState<Foco>("numero");

  /** El ticket que se está tecleando. */
  const [carrito, setCarrito] = useState<LineaVenta[]>([]);
  /** Los tickets ya cerrados que esperan la confirmación final. */
  const [tanda, setTanda] = useState<TicketEnTanda[]>([]);

  const [rapidaTexto, setRapidaTexto] = useState("");
  const [rapidaAviso, setRapidaAviso] = useState("");
  const [rapidaOk, setRapidaOk] = useState<boolean | null>(null);

  const [recibo, setRecibo] = useState<{ tickets: TicketRegistrado[]; total: number } | null>(
    null,
  );
  const [errorVenta, setErrorVenta] = useState("");
  const [enviando, iniciar] = useTransition();

  /*
   * Arranca en 0 y no en `Date.now()`.
   *
   * El estado inicial se evalúa también en el render del servidor, así que
   * sembrarlo con la hora daba dos valores distintos —uno en el HTML y otro al
   * hidratar— y React avisaba del desajuste. Con 0 las dos pasadas coinciden y
   * el reloj empieza a contar cuando el componente ya está montado.
   */
  const [ahora, setAhora] = useState(0);

  useEffect(() => {
    // El primer valor va por `setTimeout` y no directo: llamar a `setAhora`
    // en el cuerpo del efecto encadena un render de más, y la regla
    // `react-hooks/set-state-in-effect` lo rechaza. Con 0 ms se aplica en
    // cuanto el navegador pinta, así que el reloj no se nota vacío.
    const arranque = setTimeout(() => setAhora(Date.now()), 0);
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => {
      clearTimeout(arranque);
      clearInterval(t);
    };
  }, []);

  const montado = ahora > 0;
  const vendedor = datos.vendedores.find((v) => v.id === vendedorId) ?? datos.vendedores[0];

  /**
   * Cupo disponible por número: el mínimo entre lo que le queda a la casa y lo
   * que le queda al vendedor, descontando además lo que ya lleva sin confirmar
   * —tanto en el ticket en curso como en los que ya cerró en la tanda.
   */
  const disponible = useMemo(() => {
    const propio = datos.vendidoPropio[vendedorId] ?? new Array(100).fill(0);
    const pendiente = new Array(100).fill(0);

    for (const t of tanda) for (const l of t.lineas) pendiente[l.numero] += l.monto;
    for (const l of carrito) pendiente[l.numero] += l.monto;

    return Array.from({ length: 100 }, (_, n) =>
      Math.max(
        0,
        Math.min(
          datos.disponibleCasa[n] - pendiente[n],
          (vendedor?.tope_por_numero ?? 0) - propio[n] - pendiente[n],
        ),
      ),
    );
  }, [datos, vendedorId, carrito, tanda, vendedor]);

  const numeroActual = numero.length === 2 ? parseInt(numero, 10) : null;
  const disp = numeroActual != null ? disponible[numeroActual] : null;
  const montoNum = parseInt(monto || "0", 10);
  const totalTicket = carrito.reduce((a, l) => a + l.monto, 0);
  const totalTanda = tanda.reduce((a, t) => a + t.total, 0) + totalTicket;
  const puedeAgregar = disp != null && disp > 0 && montoNum > 0 && montoNum <= disp;

  /** Cuántos tickets se registrarían ahora mismo. */
  const ticketsPorRegistrar = tanda.length + (carrito.length > 0 ? 1 : 0);

  /*
   * La venta cerrada se detecta aquí, no sólo en el servidor.
   *
   * Antes la cuenta regresiva llegaba a 00:00:00 y no pasaba nada: el vendedor
   * seguía tecleando y sólo descubría el rechazo al confirmar, con el ticket
   * entero escrito. Ahora el botón se apaga en el momento.
   */
  const cerrada =
    montado &&
    (datos.sorteo.estado !== "abierto" || ahora >= Date.parse(datos.sorteo.hora_cierre));

  const bloqueada = cerrada && !datos.puedeForzar;

  const banner =
    disp == null
      ? {
          texto: "Ingrese un número de dos dígitos para ver el cupo disponible.",
          clase: "bg-chip text-cuerpo",
        }
      : disp <= 0
        ? {
            texto: `Cupo agotado en el ${pad2(numeroActual!)}: no se acepta monto.`,
            clase: "bg-negativo-fondo text-negativo-texto",
          }
        : disp < CUPO_BAJO
          ? {
              texto: `Cupo bajo en el ${pad2(numeroActual!)}: disponible ${fmt(disp)}.`,
              clase: "bg-ambar-fondo text-ambar-texto",
            }
          : {
              texto: `Disponible en el ${pad2(numeroActual!)}: ${fmt(disp)}.`,
              clase: "bg-positivo-fondo text-positivo-texto",
            };

  const limpiarEntrada = () => {
    setNumero("");
    setMonto("");
    setFoco("numero");
    setRapidaTexto("");
  };

  const agregar = (n: number, m: number) => {
    setCarrito((c) => [...c, { numero: n, monto: m }]);
    limpiarEntrada();
    setErrorVenta("");
  };

  const quitarLinea = (i: number) => setCarrito((c) => c.filter((_, j) => j !== i));

  /** Cierra el ticket en curso y lo deja esperando en la tanda. */
  const cerrarTicket = () => {
    if (!carrito.length) return;
    setTanda((t) => [...t, { lineas: carrito, total: totalTicket }]);
    setCarrito([]);
    limpiarEntrada();
    setErrorVenta("");
  };

  const quitarTicket = (i: number) => setTanda((t) => t.filter((_, j) => j !== i));

  const tecla = (k: string) => {
    const actual = foco === "numero" ? numero : monto;
    const set = foco === "numero" ? setNumero : setMonto;

    if (k === "C") return set("");
    if (k === "←") return set(actual.slice(0, -1));

    if (foco === "numero") {
      // Ventana deslizante de dos dígitos: teclear un tercero corre el número.
      const nuevo = (numero + k).slice(-2);
      setNumero(nuevo);
      setMonto("");
      // Sólo salta al monto si ese número tiene cupo; si no, se queda para
      // que el vendedor corrija sin descubrir el rechazo al final.
      const libre = nuevo.length === 2 && disponible[parseInt(nuevo, 10)] > 0;
      setFoco(libre ? "monto" : "numero");
      return;
    }

    if (monto.length < 5 && (disp ?? 0) > 0) setMonto(monto + k);
  };

  const enviarRapida = () => {
    const m = rapidaTexto.trim().match(/^(\d{1,2})\s*[\s\-x,]\s*(\d{1,5})$/);
    if (!m) {
      setRapidaOk(false);
      return setRapidaAviso("Formato: número espacio monto. Ejemplo: 47 50");
    }
    const n = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const dp = disponible[n];

    if (dp <= 0) {
      setRapidaOk(false);
      return setRapidaAviso(`Cupo agotado en el ${pad2(n)}.`);
    }
    if (mo > dp) {
      setRapidaOk(false);
      return setRapidaAviso(`Máximo vendible en el ${pad2(n)}: ${fmt(dp)}.`);
    }
    agregar(n, mo);
    setRapidaOk(true);
    setRapidaAviso(`${pad2(n)} × ${fmt(mo)} agregado. Siga escribiendo.`);
  };

  /**
   * Registra todo lo pendiente: los tickets cerrados de la tanda más el que
   * esté a medio teclear, si tiene líneas. Va en una sola llamada porque la
   * base lo resuelve en UNA transacción: o entran todos o no entra ninguno.
   */
  const confirmar = () => {
    if (!vendedor) return;

    const tickets = [
      ...tanda.map((t) => t.lineas),
      ...(carrito.length ? [carrito] : []),
    ];
    if (!tickets.length) return;

    setErrorVenta("");

    const enviar = (coord?: { lat: number; lng: number }) =>
      iniciar(async () => {
        const r = await registrarVenta(datos.sorteo.id, vendedor.id, tickets, coord);
        if (!r.ok) return setErrorVenta(r.mensaje);
        setRecibo({ tickets: r.tickets, total: r.total });
        setTanda([]);
        setCarrito([]);
        limpiarEntrada();
      });

    // La coordenada es dato operativo, no un requisito: si el vendedor no da
    // permiso, la venta se registra igual.
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => enviar({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => enviar(),
        { timeout: 4000 },
      );
    } else {
      enviar();
    }
  };

  const cambiarVendedor = (id: string) => {
    setVendedorId(id);
    setCarrito([]);
    setTanda([]);
    limpiarEntrada();
    setRecibo(null);
  };

  return {
    // datos
    datos,
    vendedor,
    vendedorId,
    disponible,
    numero,
    monto,
    foco,
    modo,
    carrito,
    tanda,
    rapidaTexto,
    rapidaAviso,
    rapidaOk,
    recibo,
    errorVenta,
    ahora,
    montado,
    enviando,

    // derivados
    numeroActual,
    disp,
    montoNum,
    totalTicket,
    totalTanda,
    puedeAgregar,
    ticketsPorRegistrar,
    cerrada,
    bloqueada,
    banner,

    // acciones
    setModo,
    setFoco,
    setNumero,
    setMonto,
    setRapidaTexto,
    setRapidaOk,
    setRapidaAviso,
    setRecibo,
    cambiarVendedor,
    agregar,
    quitarLinea,
    cerrarTicket,
    quitarTicket,
    tecla,
    enviarRapida,
    confirmar,
  };
}

export type Pos = ReturnType<typeof usePos>;
