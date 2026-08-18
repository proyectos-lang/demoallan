import "server-only";

import { GoogleGenAI, Type } from "@google/genai";

/**
 * Lectura de hojas manuscritas con Gemini.
 *
 * Principio §1: la IA no registra, propone. Aquí no se escribe nada en la base.
 * La salida es una propuesta que pasa por revisión humana antes de convertirse
 * en tickets.
 *
 * FORMATO REAL DE LAS HOJAS
 * -------------------------
 * Son cuadernos rayados. Las apuestas van en PARES DE FILAS que se leen por
 * columna: la fila de arriba lleva los números jugados y la de abajo, alineado
 * bajo cada número, el monto de esa apuesta.
 *
 *     90  91  92  93  94        ← números
 *     500 500 500 500 200       ← montos
 *
 * De ahí sale la comprobación estructural más útil que tenemos: **cada grupo
 * debe traer tantos montos como números**. Si no coinciden, la lectura de esa
 * franja es sospechosa aunque el modelo se declare seguro. Por eso el modelo
 * devuelve los grupos tal cual, y el emparejamiento lo hace este código.
 *
 * Las hojas observadas NO traen un total escrito al pie, así que el control de
 * cuadre del §8 se apoya en un total que teclea el operador (normalmente el
 * efectivo contado). El campo se pide igualmente por si alguna hoja lo trae.
 */

/** Cambiar el modelo aquí, no repartido por el código. */
export const MODELO = "gemini-3.5-flash";

/**
 * Tarifas en USD por millón de tokens (ai.google.dev/gemini-api/docs/pricing).
 * Los tokens de razonamiento se facturan como salida, no como entrada.
 */
const PRECIO_ENTRADA_POR_MILLON = 1.5;
const PRECIO_SALIDA_POR_MILLON = 9.0;

/** Por debajo de esto, el renglón se marca para revisión en la interfaz. */
export const CONFIANZA_BAJA = 0.85;

/**
 * Cuántas veces se lee cada hoja.
 *
 * No es redundancia por si acaso: medido sobre hojas reales, la confianza que
 * el modelo declara NO acierta dónde se equivoca — marcó 0.90–0.95 justo en las
 * celdas que leyó distinto entre pasadas. El desacuerdo entre lecturas sí las
 * señala con precisión. Tres permite además decidir por mayoría.
 */
const LECTURAS = 3;

export type LineaExtraida = {
  numero: string;
  monto: string;
  /** 0–1. Grado de ACUERDO entre las lecturas, no lo que el modelo declara. */
  confianza: number;
  /** Lecturas distintas de esta celda, cuando no hubo unanimidad. */
  alternativas?: string[];
  /** Índice del grupo de filas del que salió, para poder señalarlo. */
  grupo: number;
};

export type Extraccion = {
  lineas: LineaExtraida[];
  /** Lo que trae la cabecera: quién, qué día y de qué sorteo se trata. */
  encabezado: { nombre: string; fecha: string; franja: string };
  /** El total al pie, si la hoja lo trae. Casi nunca. */
  totalDeclarado: number | null;
  confianzaGlobal: number;
  /** Problemas de estructura detectados por código, no por el modelo. */
  avisos: string[];
  tokensEntrada: number;
  tokensSalida: number;
  costoUsd: number;
};

const ESQUEMA = {
  type: Type.OBJECT,
  properties: {
    encabezado: {
      type: Type.OBJECT,
      properties: {
        nombre: { type: Type.STRING, description: "Nombre escrito en la cabecera. Vacío si no hay." },
        fecha: { type: Type.STRING, description: "Fecha de la cabecera, tal cual está escrita." },
        franja: {
          type: Type.STRING,
          description:
            "Hora o franja del sorteo si aparece (por ejemplo '3PM', '11AM', 'noche'). Vacío si no hay.",
        },
      },
      required: ["nombre", "fecha", "franja"],
    },
    grupos: {
      type: Type.ARRAY,
      description:
        "Un elemento por PAR de filas de la hoja, en orden de arriba abajo. " +
        "Cada par son los números de la fila superior y los montos de la inferior.",
      items: {
        type: Type.OBJECT,
        properties: {
          numeros: {
            type: Type.ARRAY,
            description: "Números de la fila de ARRIBA, de izquierda a derecha. Dos dígitos cada uno.",
            items: { type: Type.STRING },
          },
          montos: {
            type: Type.ARRAY,
            description:
              "Montos de la fila de ABAJO, de izquierda a derecha, en el mismo orden. " +
              "Debe haber exactamente tantos montos como números.",
            items: { type: Type.STRING },
          },
          confianza: {
            type: Type.NUMBER,
            description:
              "De 0 a 1: qué tan seguro estás de haber leído bien ESTE par de filas. " +
              "Bájala si los trazos se tocan, si dudas de dónde termina un número y " +
              "empieza el siguiente, o si te faltó alineación entre las dos filas.",
          },
        },
        required: ["numeros", "montos", "confianza"],
      },
    },
    total_declarado: {
      type: Type.STRING,
      description:
        "Total escrito al pie de la hoja, sólo dígitos. Cadena vacía si la hoja no lo trae, " +
        "que es lo habitual. NO lo calcules tú.",
    },
  },
  required: ["encabezado", "grupos", "total_declarado"],
} as const;

const INSTRUCCIONES = `Eres un asistente de digitalización para una casa de lotería en Honduras.

La imagen es una hoja de cuaderno con apuestas escritas a mano. Las apuestas van
en PARES DE FILAS que se leen por columna:

    70  75  90  94  79     ← fila de números jugados (dos dígitos, 00 a 99)
    200 100 250 150 50     ← fila de montos en lempiras, alineados debajo

Cada columna es una apuesta: el 70 va con 200, el 75 con 100, y así.

La hoja puede traer varios de estos pares de filas, separados entre sí. Devuelve
cada par como un grupo, en el orden en que aparecen de arriba abajo.

Reglas:

- Dentro de un grupo debe haber EXACTAMENTE tantos montos como números. Si al
  leerlo no te cuadra la cantidad, devuelve lo que ves de todas formas y baja la
  confianza de ese grupo: no inventes ni elimines elementos para cuadrarlo.
- Los dígitos manuscritos se tocan a menudo. «3102» a mitad de una fila casi
  siempre son dos números, 31 y 02. Usa el espaciado y la alineación con la fila
  de abajo para separarlos, y baja la confianza si dudas.
- Transcribe lo que ves. No corrijas, no completes y no descartes nada. Un
  renglón dudoso marcado con confianza baja sirve; uno omitido no se detecta.
- No calcules el total. Si la hoja no lo trae escrito, devuelve cadena vacía.
- La cabecera suele llevar un nombre, una fecha y a veces la franja del sorteo
  ('3PM', 'Viernes 3PM'). Devuélvelos tal cual estén escritos.`;

let cliente: GoogleGenAI | null = null;
function obtenerCliente() {
  if (!cliente) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("Falta GOOGLE_API_KEY en el entorno.");
    cliente = new GoogleGenAI({ apiKey });
  }
  return cliente;
}

const soloDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

type Celda = { numero: string; monto: string; grupo: number };
type Pasada = {
  celdas: Celda[];
  encabezado: { nombre: string; fecha: string; franja: string };
  declarado: string;
  desalineados: number[];
  tokensEntrada: number;
  tokensSalida: number;
};

/** Una lectura de la hoja. Se llama varias veces en paralelo. */
async function leerUnaVez(imagenBase64: string, mimeType: string): Promise<Pasada> {
  const respuesta = await obtenerCliente().models.generateContent({
    model: MODELO,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: imagenBase64 } },
          { text: "Transcribe las apuestas de esta hoja." },
        ],
      },
    ],
    config: {
      systemInstruction: INSTRUCCIONES,
      responseMimeType: "application/json",
      responseSchema: ESQUEMA,
      // Sin razonamiento. Medido sobre estas hojas: seis veces más caro y cinco
      // veces más lento, con la misma transcripción. El presupuesto se gasta
      // mejor leyendo la hoja tres veces que pensando una.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let crudo: {
    encabezado?: { nombre?: string; fecha?: string; franja?: string };
    grupos?: { numeros?: string[]; montos?: string[] }[];
    total_declarado?: string;
  };
  try {
    crudo = JSON.parse(respuesta.text ?? "");
  } catch {
    throw new Error("El modelo no devolvió JSON válido.");
  }

  const celdas: Celda[] = [];
  const desalineados: number[] = [];

  (crudo.grupos ?? []).forEach((g, i) => {
    const numeros = (g.numeros ?? []).map(soloDigitos).filter(Boolean);
    const montos = (g.montos ?? []).map(soloDigitos).filter(Boolean);

    // En una hoja bien leída cada número tiene su monto debajo. Que no cuadre
    // suele significar dígitos pegados que se partieron mal.
    if (numeros.length !== montos.length) desalineados.push(i + 1);

    const n = Math.max(numeros.length, montos.length);
    for (let j = 0; j < n; j++) {
      celdas.push({
        // Normalizar el formato no es corregir el valor: '7' → '07' es
        // presentación; cambiar un 7 por otra cosa sería falsear la lectura.
        numero: (numeros[j] ?? "").slice(0, 2).padStart(2, "0"),
        monto: (montos[j] ?? "").slice(0, 6),
        grupo: i + 1,
      });
    }
  });

  const uso = respuesta.usageMetadata;
  return {
    celdas,
    encabezado: {
      nombre: String(crudo.encabezado?.nombre ?? "").trim(),
      fecha: String(crudo.encabezado?.fecha ?? "").trim(),
      franja: String(crudo.encabezado?.franja ?? "").trim(),
    },
    declarado: soloDigitos(crudo.total_declarado),
    desalineados,
    tokensEntrada: uso?.promptTokenCount ?? 0,
    // Los tokens de razonamiento se facturan como salida; sumarlos aunque el
    // presupuesto sea 0, para que el costo registrado nunca quede por debajo.
    tokensSalida: (uso?.candidatesTokenCount ?? 0) + (uso?.thoughtsTokenCount ?? 0),
  };
}

/** El valor que más se repite; si hay empate, el de la primera lectura. */
function porMayoria(valores: string[]): { valor: string; votos: number } {
  const cuenta = new Map<string, number>();
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  let valor = valores[0];
  let votos = 0;
  for (const [v, c] of cuenta) if (c > votos) { valor = v; votos = c; }
  return { valor, votos };
}

/**
 * Lee una hoja y devuelve los pares número/monto propuestos.
 *
 * Lee `LECTURAS` veces y decide por mayoría. La confianza de cada celda es el
 * grado de acuerdo entre lecturas, no lo que el modelo dice de sí mismo: sobre
 * hojas reales, lo segundo no acierta dónde se equivoca y lo primero sí.
 *
 * No persiste nada ni valida cupos: eso ocurre después, cuando un humano
 * confirma el lote.
 */
export async function extraerHoja(
  imagenBase64: string,
  mimeType: string,
): Promise<Extraccion> {
  const pasadas = await Promise.all(
    Array.from({ length: LECTURAS }, () => leerUnaVez(imagenBase64, mimeType)),
  );

  const avisos: string[] = [];

  // Si las lecturas ni siquiera coinciden en cuántas apuestas hay, la hoja es
  // difícil y conviene decirlo antes que cualquier otra cosa.
  const longitudes = [...new Set(pasadas.map((p) => p.celdas.length))];
  if (longitudes.length > 1) {
    avisos.push(
      `Las ${LECTURAS} lecturas no coinciden en cuántas apuestas hay (${longitudes.join(", ")}). ` +
        `Revise la hoja completa: puede faltar o sobrar un renglón.`,
    );
  }

  const desalineadosComunes = [...new Set(pasadas.flatMap((p) => p.desalineados))].sort((a, b) => a - b);
  for (const g of desalineadosComunes) {
    avisos.push(`Fila ${g}: la cantidad de números y de montos no coincide. Revise esa franja.`);
  }

  const referencia = pasadas.reduce((a, b) => (b.celdas.length > a.celdas.length ? b : a));
  const lineas: LineaExtraida[] = [];
  let dudosas = 0;

  referencia.celdas.forEach((celda, i) => {
    const lecturas = pasadas.map((p) => {
      const c = p.celdas[i];
      return c ? `${c.numero}:${c.monto}` : "";
    });

    const { valor, votos } = porMayoria(lecturas.filter(Boolean));
    const [numero, monto] = valor.split(":");
    const distintas = [...new Set(lecturas.filter(Boolean))];
    const unanime = distintas.length === 1;

    if (!unanime) dudosas++;

    lineas.push({
      numero: numero || celda.numero,
      monto: monto ?? celda.monto,
      // Unanimidad = 1. Mayoría simple = 0.5, por debajo del umbral de revisión.
      // Tres lecturas distintas = 0.2: hay que mirarla sí o sí.
      confianza: unanime ? 1 : votos >= 2 ? 0.5 : 0.2,
      grupo: celda.grupo,
      ...(unanime ? {} : { alternativas: distintas }),
    });
  });

  if (dudosas > 0) {
    avisos.push(
      `${dudosas} ${dudosas === 1 ? "apuesta difiere" : "apuestas difieren"} entre lecturas. ` +
        `Están marcadas para revisión con las variantes que se leyeron.`,
    );
  }

  // El total lo toma de la lectura que sí lo encontró, si alguna lo hizo.
  const declarado = pasadas.map((p) => p.declarado).find(Boolean) ?? "";

  const tokensEntrada = pasadas.reduce((a, p) => a + p.tokensEntrada, 0);
  const tokensSalida = pasadas.reduce((a, p) => a + p.tokensSalida, 0);

  return {
    lineas,
    encabezado: referencia.encabezado,
    totalDeclarado: declarado ? Number(declarado) : null,
    confianzaGlobal: lineas.length
      ? Number((lineas.reduce((a, l) => a + l.confianza, 0) / lineas.length).toFixed(3))
      : 0,
    avisos,
    tokensEntrada,
    tokensSalida,
    costoUsd: Number(
      (
        (tokensEntrada / 1_000_000) * PRECIO_ENTRADA_POR_MILLON +
        (tokensSalida / 1_000_000) * PRECIO_SALIDA_POR_MILLON
      ).toFixed(6),
    ),
  };
}
