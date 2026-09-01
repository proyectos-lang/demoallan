import { TarjetaPeriodo, type Periodo } from "@/components/analisis/tarjeta-periodo";
import { BarrasNeto } from "@/components/informe/barras-neto";
import { Kpi } from "@/components/informe/kpi";
import { Tarjeta, TarjetaNota } from "@/components/ui/tarjeta";
import { cn } from "@/lib/cn";
import { fechaLargaSinDia, fmt, fmtK } from "@/lib/format";
import { crearClienteServidor } from "@/lib/supabase/server";

/** El año del negocio son 52 semanas. La proyección se mide contra eso. */
const SEMANAS_DEL_ANIO = 52;

const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

type Semana = {
  inicio: string;
  fin: string;
  semana: number;
  venta: number;
  comision: number;
  premios: number;
  neto: number;
};

/** Un título de sección, con su franja de color a la izquierda como en la hoja. */
function Seccion({
  titulo,
  nota,
  children,
}: {
  titulo: string;
  nota?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-h2 font-semibold tracking-sutil m-0">{titulo}</h2>
        {nota && <p className="text-meta text-secundario mt-[4px] mb-0">{nota}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Parte la serie de semanas en bloques consecutivos de `tamano`.
 *
 * Es como la gerencia arma sus semestres, trimestres y bimestres: no por
 * calendario sino contando semanas operadas desde la primera. Un semestre son
 * veintiséis semanas de las que hubo, no de las que trae el año.
 */
function bloques(semanas: Semana[], tamano: number, sigla: string): Periodo[] {
  const salida: Periodo[] = [];
  for (let i = 0; i < semanas.length; i += tamano) {
    const trozo = semanas.slice(i, i + tamano);
    const n = Math.floor(i / tamano) + 1;
    salida.push({
      titulo: `${sigla}${n} · semanas #${trozo[0].semana} a #${trozo[trozo.length - 1].semana}`,
      meta: `${trozo.length} ${trozo.length === 1 ? "semana" : "semanas"}`,
      venta: trozo.reduce((a, s) => a + s.venta, 0),
      comision: trozo.reduce((a, s) => a + s.comision, 0),
      premios: trozo.reduce((a, s) => a + s.premios, 0),
      neto: trozo.reduce((a, s) => a + s.neto, 0),
    });
  }
  return salida;
}

/**
 * Análisis financiero.
 *
 * El acumulado de toda la operación, mirado desde todos los cortes que la
 * gerencia venía usando en su hoja: semestre, trimestre, bimestre, mes, semana
 * y día de la semana. Sin filtros a propósito — es la foto entera, y para
 * mirar un trozo están las otras pestañas y el análisis de resultados.
 *
 * Todos los cortes salen de la MISMA serie semanal salvo el de meses y el de
 * días de la semana, que no se pueden derivar de ella: una semana puede caer a
 * caballo entre dos meses. Esos dos se piden a la base.
 */
export async function VistaFinanciera() {
  const supabase = await crearClienteServidor();

  const { data: semanasRaw, error } = await supabase.rpc("fn_semanas_operadas");

  // La función las devuelve de la más reciente a la más vieja, que es como se
  // leen en el riel. Aquí hace falta al revés: una serie se acumula hacia
  // adelante.
  const semanas: Semana[] = [...(semanasRaw ?? [])]
    .reverse()
    .map((s) => ({
      inicio: s.r_inicio,
      fin: s.r_fin,
      semana: s.r_semana,
      venta: Number(s.r_venta),
      comision: Number(s.r_comision),
      premios: Number(s.r_premios),
      neto: Number(s.r_neto),
    }));

  if (error) {
    return <TarjetaNota>No se pudo cargar el análisis: {error.message}</TarjetaNota>;
  }
  if (semanas.length === 0) {
    return (
      <TarjetaNota>
        Todavía no hay ninguna semana con sorteos liquidados. El análisis financiero se arma desde
        las liquidaciones, así que un sorteo sin número ganador todavía no cuenta.
      </TarjetaNota>
    );
  }

  const primera = semanas[0];
  const ultima = semanas[semanas.length - 1];

  const [{ data: meses, error: errorMeses }, { data: porDia, error: errorDias }] =
    await Promise.all([
      supabase.rpc("fn_analisis_resultados", {
        p_desde: primera.inicio,
        p_hasta: ultima.fin,
        p_grano: "mes",
        p_vendedor_id: null,
        p_hora: null,
      }),
      supabase.rpc("fn_resultado_por_dia_semana"),
    ]);

  const total = semanas.reduce(
    (a, s) => ({
      venta: a.venta + s.venta,
      comision: a.comision + s.comision,
      premios: a.premios + s.premios,
      neto: a.neto + s.neto,
    }),
    { venta: 0, comision: 0, premios: 0, neto: 0 },
  );

  const n = semanas.length;
  const promedio = {
    venta: total.venta / n,
    comision: total.comision / n,
    premios: total.premios / n,
    neto: total.neto / n,
  };

  const mejor = semanas.reduce((a, s) => (s.neto > a.neto ? s : a), semanas[0]);
  const peor = semanas.reduce((a, s) => (s.neto < a.neto ? s : a), semanas[0]);

  const pct = (v: number) => (total.venta ? (v / total.venta) * 100 : 0);
  const signo = (v: number) => (v < 0 ? "text-negativo" : "text-positivo");

  // La proyección estira el promedio de lo que va del año sobre las semanas
  // que faltan. Es una regla de tres, no un pronóstico: se dice al pie.
  const restantes = Math.max(0, SEMANAS_DEL_ANIO - n);
  const proyectar = (acumulado: number, medio: number) => acumulado + medio * restantes;
  const avance = Math.min(100, (n / SEMANAS_DEL_ANIO) * 100);

  const mensuales: Periodo[] = (meses ?? []).map((m) => {
    const [a, mm] = m.r_inicio.split("-").map(Number);
    return {
      titulo: `${MESES[mm - 1]} ${a}`,
      meta: `${m.r_dias} ${m.r_dias === 1 ? "día" : "días"}`,
      venta: Number(m.r_venta),
      comision: Number(m.r_comision),
      premios: Number(m.r_premios),
      neto: Number(m.r_utilidad),
    };
  });

  const semanales: Periodo[] = (porDia ?? []).map((d) => ({
    titulo: DIAS[d.r_dow - 1],
    meta: `${d.r_dias} ${d.r_dias === 1 ? "fecha" : "fechas"}`,
    venta: Number(d.r_venta),
    comision: Number(d.r_comision),
    premios: Number(d.r_premios),
    neto: Number(d.r_neto),
  }));

  const rejilla = "grid gap-[14px] [grid-template-columns:repeat(auto-fill,minmax(298px,1fr))]";

  return (
    <div className="flex flex-col gap-7">
      {/* ---- Resumen acumulado ---- */}
      <Seccion
        titulo={`Resumen acumulado · ${n} ${n === 1 ? "semana" : "semanas"}`}
        nota={`Desde ${fechaLargaSinDia(primera.inicio)} hasta ${fechaLargaSinDia(ultima.fin)}. Toda la operación liquidada.`}
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
          <Kpi etiqueta="VENTA TOTAL" valor={fmt(total.venta)} />
          <Kpi
            etiqueta="PREMIOS PAGADOS"
            valor={fmt(total.premios)}
            esquina={{ texto: `${pct(total.premios).toFixed(1)}%` }}
            pie="de la venta"
          />
          <Kpi
            etiqueta="COMISIONES PAGADAS"
            valor={fmt(total.comision)}
            esquina={{ texto: `${pct(total.comision).toFixed(1)}%` }}
            pie="de la venta"
          />
          <Kpi
            etiqueta="NETO TOTAL GENERADO"
            valor={fmt(total.neto)}
            color={signo(total.neto)}
            esquina={{ texto: `${pct(total.neto).toFixed(1)}%`, color: signo(total.neto) }}
            pie="de la venta"
          />
          <Kpi
            etiqueta="PROMEDIO NETO POR SEMANA"
            valor={fmt(promedio.neto)}
            color={signo(promedio.neto)}
            pie={`sobre ${n} ${n === 1 ? "semana" : "semanas"}`}
          />
          <Kpi
            etiqueta="MEJOR SEMANA"
            valor={fmt(mejor.neto)}
            color={signo(mejor.neto)}
            pie={`Semana #${mejor.semana} · ${fechaLargaSinDia(mejor.inicio)}`}
          />
          <Kpi
            etiqueta="PEOR SEMANA"
            valor={fmt(peor.neto)}
            color={signo(peor.neto)}
            pie={`Semana #${peor.semana} · ${fechaLargaSinDia(peor.inicio)}`}
          />
        </div>
      </Seccion>

      {/* ---- Proyección anual ---- */}
      <Seccion
        titulo={`Proyección anual · ${SEMANAS_DEL_ANIO} semanas`}
        nota={
          restantes === 0
            ? `El año ya está completo: ${n} semanas operadas de ${SEMANAS_DEL_ANIO}. Lo de abajo es lo realizado, no una proyección.`
            : `${n} de ${SEMANAS_DEL_ANIO} semanas (${avance.toFixed(0)} %). Las ${restantes} que faltan se estiman con el promedio de las que ya se jugaron.`
        }
      >
        <Tarjeta padding="16px 18px">
          <div className="h-[10px] rounded-pildora bg-chip overflow-hidden">
            <div
              className="h-full rounded-pildora bg-acento"
              style={{ width: `${Math.max(1, avance)}%` }}
            />
          </div>

          <div className="grid gap-3 mt-4 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
            {[
              { etiqueta: "VENTA PROYECTADA", acum: total.venta, medio: promedio.venta, color: undefined },
              { etiqueta: "PREMIOS PROYECTADOS", acum: total.premios, medio: promedio.premios, color: undefined },
              { etiqueta: "COMISIONES PROYECTADAS", acum: total.comision, medio: promedio.comision, color: undefined },
              {
                etiqueta: "NETO PROYECTADO",
                acum: total.neto,
                medio: promedio.neto,
                color: signo(proyectar(total.neto, promedio.neto)),
              },
            ].map((k) => (
              <div key={k.etiqueta}>
                <span className="block text-eyebrow font-semibold tracking-seccion text-secundario">
                  {k.etiqueta}
                </span>
                <span
                  className={cn(
                    "block text-kpi font-semibold tracking-titular mt-[6px]",
                    k.color,
                  )}
                >
                  {fmt(proyectar(k.acum, k.medio))}
                </span>
                <span className="block text-label text-mudo mt-[2px]">
                  llevados {fmtK(k.acum)} · {fmtK(k.medio)} por semana
                </span>
              </div>
            ))}
          </div>
        </Tarjeta>
      </Seccion>

      {/* ---- Los cortes largos ---- */}
      <Seccion
        titulo="Neto por semestre"
        nota="Bloques de 26 semanas contadas desde la primera que se operó, no por calendario."
      >
        <div className={rejilla}>
          {bloques(semanas, 26, "S").map((p, i, todos) => (
            <TarjetaPeriodo key={p.titulo} p={p} anterior={i > 0 ? todos[i - 1].neto : null} />
          ))}
        </div>
      </Seccion>

      <Seccion titulo="Neto por trimestre" nota="Bloques de 13 semanas.">
        <div className={rejilla}>
          {bloques(semanas, 13, "T").map((p, i, todos) => (
            <TarjetaPeriodo key={p.titulo} p={p} anterior={i > 0 ? todos[i - 1].neto : null} />
          ))}
        </div>
      </Seccion>

      <Seccion titulo="Neto por bimestre" nota="Bloques de 8 semanas.">
        <div className={rejilla}>
          {bloques(semanas, 8, "B").map((p, i, todos) => (
            <TarjetaPeriodo key={p.titulo} p={p} anterior={i > 0 ? todos[i - 1].neto : null} />
          ))}
        </div>
      </Seccion>

      <Seccion
        titulo="Neto por mes"
        nota="Por calendario, no por semanas: una semana puede caer a caballo entre dos meses, así que estos totales se piden aparte y no se derivan de la serie semanal."
      >
        {errorMeses ? (
          <TarjetaNota>No se pudo cargar el corte por mes: {errorMeses.message}</TarjetaNota>
        ) : (
          <div className={rejilla}>
            {mensuales.map((p, i) => (
              <TarjetaPeriodo key={p.titulo} p={p} anterior={i > 0 ? mensuales[i - 1].neto : null} />
            ))}
          </div>
        )}
      </Seccion>

      {/* ---- La serie semanal ---- */}
      <Seccion
        titulo="Neto por semana"
        nota="Las pérdidas cuelgan bajo la línea del cero, a la misma escala que las ganancias."
      >
        <Tarjeta padding="18px 18px 12px">
          <BarrasNeto
            barras={semanas.map((s) => ({
              clave: s.inicio,
              etiqueta: String(s.semana),
              titulo: `Semana #${s.semana} · ${fechaLargaSinDia(s.inicio)}`,
              neto: s.neto,
            }))}
          />
        </Tarjeta>
      </Seccion>

      {/* ---- Día de la semana ---- */}
      <Seccion
        titulo="Neto por día de la semana"
        nota="Todos los lunes juntos, todos los martes juntos. La pregunta no es cómo fue un día sino si hay un día que sistemáticamente deja o quita dinero."
      >
        {errorDias ? (
          <TarjetaNota>
            No se pudo cargar el corte por día de la semana: {errorDias.message}
          </TarjetaNota>
        ) : (
          <div className={rejilla}>
            {semanales.map((p) => (
              // Sin pie de comparación: el lunes no viene «después» del domingo,
              // esta serie no tiene orden que comparar.
              <TarjetaPeriodo key={p.titulo} p={p} />
            ))}
          </div>
        )}
      </Seccion>

      {/* ---- El detalle ---- */}
      <Seccion titulo="Detalle por semana" nota={`Las ${n} semanas, de la primera a la última.`}>
        <div className="bg-superficie border border-borde rounded-card shadow-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-tabla min-w-[860px]">
              <thead>
                <tr className="bg-tinte">
                  {["SEMANA", "VENTA", "PREMIOS", "COMISIÓN", "NETO", "% VENTA", "VS ANTERIOR"].map(
                    (t, i) => (
                      <th
                        key={t}
                        className={cn(
                          "py-[11px] border-b border-riel text-th font-semibold tracking-th text-secundario",
                          i === 0 ? "text-left pl-4 pr-3" : "text-right",
                          i === 6 ? "pl-3 pr-4" : i > 0 ? "px-3" : "",
                        )}
                      >
                        {t}
                      </th>
                    ),
                  )}
                </tr>
              </thead>

              <tbody>
                {semanas.map((s, i) => {
                  const dif = i > 0 ? s.neto - semanas[i - 1].neto : null;
                  const margen = s.venta ? (s.neto / s.venta) * 100 : 0;
                  return (
                    <tr key={s.inicio} className="hover:bg-tinte">
                      <td className="pl-4 pr-3 py-[11px] border-b border-fondo">
                        <span className="font-medium">Semana #{s.semana}</span>
                        <span className="text-th text-mudo ml-2">
                          {fechaLargaSinDia(s.inicio)} — {fechaLargaSinDia(s.fin)}
                        </span>
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right">
                        {fmt(s.venta, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {fmt(s.premios, false)}
                      </td>
                      <td className="px-3 py-[11px] border-b border-fondo text-right text-cuerpo">
                        {fmt(s.comision, false)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-[11px] border-b border-fondo text-right font-semibold",
                          s.neto < 0 && "text-negativo",
                        )}
                      >
                        {fmt(s.neto, false)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-[11px] border-b border-fondo text-right",
                          margen < 0 ? "text-negativo" : "text-secundario",
                        )}
                      >
                        {margen.toFixed(1)}%
                      </td>
                      <td
                        className={cn(
                          "pl-3 pr-4 py-[11px] border-b border-fondo text-right",
                          dif === null ? "text-mudo" : dif < 0 ? "text-negativo" : "text-positivo",
                        )}
                      >
                        {dif === null ? "—" : `${dif > 0 ? "+" : ""}${fmtK(dif)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              <tfoot>
                <tr className="bg-tinte">
                  <td className="pl-4 pr-3 py-[11px] text-th font-semibold tracking-subtotal text-secundario">
                    ACUMULADO · {n} {n === 1 ? "semana" : "semanas"}
                  </td>
                  <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                    {fmt(total.venta, false)}
                  </td>
                  <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                    {fmt(total.premios, false)}
                  </td>
                  <td className="px-3 py-[11px] text-right text-h2 font-semibold">
                    {fmt(total.comision, false)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-[11px] text-right text-h2 font-semibold",
                      total.neto < 0 && "text-negativo",
                    )}
                  >
                    {fmt(total.neto, false)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-[11px] text-right text-h2 font-semibold",
                      pct(total.neto) < 0 ? "text-negativo" : "text-secundario",
                    )}
                  >
                    {pct(total.neto).toFixed(1)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </Seccion>

      <TarjetaNota>
        La <strong>proyección</strong> estira el promedio de las semanas jugadas sobre las que
        faltan para llegar a {SEMANAS_DEL_ANIO}. Es una regla de tres sobre el historial, no un
        pronóstico: no sabe de temporadas ni de la racha de números que vaya a salir, y una sola
        semana mala la mueve entera. <strong>Semestres, trimestres y bimestres</strong> se cuentan
        en semanas operadas desde la primera, que es como los venía armando la gerencia; los{" "}
        <strong>meses</strong> sí son de calendario. Y no aparecen «regalías» ni «pasados»: el
        sistema no registra ninguna de las dos, y enseñarlas en cero sería fingir un dato.
      </TarjetaNota>
    </div>
  );
}
