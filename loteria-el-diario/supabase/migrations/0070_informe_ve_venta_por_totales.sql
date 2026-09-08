-- ===========================================================================
-- El informe de gerencia también ve la venta capturada POR TOTALES.
--
-- EL SÍNTOMA
-- ----------
-- El 8 de septiembre de 2026, el vendedor V-006 aparecía en el informe con
-- «premiado 0» y a la vez «pago premios 3,850». Las dos cosas a la vez son
-- imposibles: si no acertó nada, no hay premio que pagar.
--
-- LA CAUSA
-- --------
-- V-006 no vende número a número: se le captura POR TOTALES —su venta y sus
-- premios del sorteo, en bloque— desde que existe `venta_total` (0047). La
-- liquidación ya suma las dos formas desde la 0048, y por eso la venta, la
-- comisión y el pago de premios le salían bien: llegan a través de
-- `liquidacion`.
--
-- Pero el informe calcula DOS columnas leyendo directamente de `linea`, sin
-- pasar por la liquidación, y ésas se quedaron atrás:
--
--   · PREMIADO —lo apostado al número que salió— salía de `l.gana`. Un
--     vendedor sin líneas no tiene ninguna marcada, así que daba cero. Y con
--     el premiado en cero, el FACTOR —que se calcula dividiendo por él—
--     también daba cero.
--
--   · LA VENTA PENDIENTE, la de sorteos aún sin liquidar, salía de `linea`.
--     La venta capturada por totales de un sorteo abierto no aparecía en
--     NINGUNA columna: existía en la base y era invisible en el informe hasta
--     que el sorteo se liquidara. A V-006 se le ocultaban 7,255 lempiras del
--     sorteo de las 21:00 mientras estuvo abierto.
--
-- Se comprobó vendedor a vendedor: los otros nueve cuadraban al céntimo entre
-- `liquidacion` y sus líneas. El defecto sólo se ve en quien se captura por
-- totales, que hasta ahora era uno solo — y por eso pasó inadvertido.
--
-- CÓMO SE DEDUCE EL PREMIADO DE UNA CAPTURA
-- -----------------------------------------
-- Ese dato NO se captura: `venta_total` guarda la venta y los premios pagados,
-- no cuánto se jugó al número ganador. Se obtiene invirtiendo el cálculo del
-- premio, que es la única relación que liga las dos cifras:
--
--     premio = apostado × factor   ->   apostado = premio / factor
--
-- Con los datos reales de V-006 da números limpios —2,100/70 = 30 y
-- 1,750/70 = 25—, que es lo que cabe esperar de apuestas en múltiplos de cinco.
--
-- LA DEBILIDAD, DICHA EN VOZ ALTA
-- -------------------------------
-- El factor sale de `parametro_vendedor`, porque la captura no lo guarda:
-- congela la comisión pero no el factor. Si a un vendedor le cambian el factor
-- después de capturar, el premiado deducido de las capturas viejas se
-- recalcula con el nuevo y deja de cuadrar con lo que se pagó.
--
-- Arreglarlo de raíz pide una columna `factor_congelado` en `venta_total`, que
-- es un cambio de captura y no de informe. Mientras no esté, se usa el factor
-- vigente: es el correcto salvo que haya habido un cambio de por medio, y es
-- mejor que seguir mostrando un cero que se lee como «no acertó nada».
--
-- SÓLO DE SORTEOS LIQUIDADOS
-- --------------------------
-- El premiado deducido se cuenta únicamente donde ya se sabe el número
-- ganador. Antes de eso, unos premios en cero significan «todavía no se sabe»,
-- no «no acertó nada», y deducir cero de ahí sería afirmar lo segundo.
-- ===========================================================================

drop function if exists public.fn_informe_gerencia(date, date, public.hora_sorteo);

create function public.fn_informe_gerencia(
  p_desde date,
  p_hasta date,
  p_hora  public.hora_sorteo default null
) returns table (
  r_vendedor_id     uuid,
  r_codigo          text,
  r_nombre          text,
  r_venta           numeric,   -- liquidada + pendiente
  r_venta_pendiente numeric,   -- la parte de sorteos sin liquidar
  r_premiado        numeric,
  r_factor          numeric,
  r_pago            numeric,   -- NULL si no hay nada liquidado
  r_porcentaje      numeric,
  r_comision        numeric,
  r_bruto           numeric,
  r_neto            numeric,   -- NULL si no hay nada liquidado
  r_tiene_pendiente boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with liquidado as (
    select lq.vendedor_id,
           sum(lq.venta)    as venta,
           sum(lq.comision) as comision,
           sum(lq.premios)  as premios
    from public.liquidacion lq
    join public.sorteo s on s.id = lq.sorteo_id
    where s.fecha between p_desde and p_hasta
      and (p_hora is null or s.hora = p_hora)
    group by lq.vendedor_id
  ),
  -- La venta de los sorteos que TODAVÍA no se liquidaron. Sale de las líneas
  -- porque esos sorteos no tienen fila en `liquidacion` —no la pueden tener,
  -- su premio aún no existe—. Son los del día, unos miles de filas.
  pendiente as (
    /*
     * LAS DOS FORMAS DE VENDER, igual que en `fn_liquidar_sorteo`.
     *
     * Antes esto sólo miraba `linea`, así que la venta capturada POR TOTALES
     * de un sorteo aún sin liquidar no aparecía en ninguna columna: existía en
     * la base y era invisible en el informe hasta que el sorteo se liquidaba.
     * A un vendedor que se captura así se le veía la mitad del día.
     */
    select vendedor_id, sum(venta) as venta, sum(comision) as comision
    from (
      select t.vendedor_id,
             sum(l.monto)                        as venta,
             sum(l.monto * l.comision_congelada) as comision
      from public.linea l
      join public.ticket t on t.id = l.ticket_id
      join public.sorteo s on s.id = t.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and s.estado <> 'liquidado'
        and t.anulado_en is null
      group by t.vendedor_id

      union all

      select vt.vendedor_id,
             sum(vt.venta),
             sum(vt.venta * vt.comision_congelada)
      from public.venta_total vt
      join public.sorteo s on s.id = vt.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and s.estado <> 'liquidado'
        and vt.anulado_en is null
      group by vt.vendedor_id
    ) u
    group by vendedor_id
  ),
  -- Lo apostado al número que salió. Sólo existe en sorteos ya liquidados: es
  -- `l.gana`, que se marca al liquidar.
  acertado as (
    /*
     * LO APOSTADO AL NÚMERO QUE SALIÓ, por las dos vías.
     *
     * De las líneas sale directo: `l.gana` lo marca al liquidar.
     *
     * De una captura POR TOTALES no, porque ese dato no se captura — se
     * registran la venta y los premios pagados, no cuánto se jugó al número
     * ganador. Se DEDUCE dividiendo los premios entre el factor de pago, que
     * es exactamente la operación inversa de cómo se calculó el premio:
     *
     *     premio = apostado × factor   ->   apostado = premio / factor
     *
     * El factor sale de `parametro_vendedor` porque la captura no lo guarda
     * —sólo congela la comisión—. Es su punto débil: si a un vendedor le
     * cambian el factor después de capturar, el premiado deducido de las
     * capturas viejas se recalcula con el nuevo y deja de cuadrar. Guardar el
     * factor en `venta_total` lo arreglaría de raíz; mientras no esté, se usa
     * el vigente, que es el que aplicó en la práctica salvo que haya habido un
     * cambio de por medio.
     *
     * Con factor cero o sin parámetros no se divide: se deja nulo antes que
     * inventar una cifra o reventar la consulta entera.
     */
    select vendedor_id, sum(premiado) as premiado
    from (
      select t.vendedor_id, sum(l.monto) as premiado
      from public.linea l
      join public.ticket t on t.id = l.ticket_id
      join public.sorteo s on s.id = t.sorteo_id
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and t.anulado_en is null
        and l.gana
      group by t.vendedor_id

      union all

      select vt.vendedor_id,
             sum(
               case when coalesce(pv.factor_pago, 0) > 0
                    then round(vt.premios / pv.factor_pago, 2)
               end
             )
      from public.venta_total vt
      join public.sorteo s on s.id = vt.sorteo_id
      left join public.parametro_vendedor pv
             on pv.vendedor_id = vt.vendedor_id
            and pv.vigente_hasta is null
      where s.fecha between p_desde and p_hasta
        and (p_hora is null or s.hora = p_hora)
        and vt.anulado_en is null
        -- Sólo de sorteos ya liquidados: antes de saber el número ganador, un
        -- premio de cero significa «todavía no se sabe», no «no acertó nada».
        and s.estado = 'liquidado'
      group by vt.vendedor_id
    ) u
    group by vendedor_id
  )
  -- Se parte del PADRÓN y no de las liquidaciones: un vendedor que no vendió
  -- nada es justo lo que el gerente quiere ver, y con un `join` desde
  -- liquidacion desaparecía sin dejar rastro.
  select v.id,
         v.codigo,
         public.fn_rotulo(v.alias, v.nombre),
         coalesce(q.venta, 0) + coalesce(p.venta, 0),
         coalesce(p.venta, 0),
         coalesce(a.premiado, 0),
         -- Sin nada acertado no hay factor que enseñar: un cero se lee mejor
         -- que una división por cero disfrazada.
         case when coalesce(a.premiado, 0) > 0
              then round(coalesce(q.premios, 0) / a.premiado, 2) else 0 end,
         -- NULL, no cero: de un sorteo sin liquidar no se sabe qué se pagó, y
         -- decir «0» sería afirmar que no se pagó nada.
         case when q.vendedor_id is not null then coalesce(q.premios, 0) end,
         case when coalesce(q.venta, 0) + coalesce(p.venta, 0) > 0
              then round((coalesce(q.comision, 0) + coalesce(p.comision, 0))
                         / (coalesce(q.venta, 0) + coalesce(p.venta, 0)), 4)
              else 0 end,
         -- La comisión SÍ se conoce siempre: va congelada en cada línea desde
         -- que se vendió.
         coalesce(q.comision, 0) + coalesce(p.comision, 0),
         coalesce(q.venta, 0) + coalesce(p.venta, 0)
           - coalesce(q.comision, 0) - coalesce(p.comision, 0),
         -- El neto sólo existe donde hay premio calculado. Se resta de lo que
         -- se enseña, no se lee de `utilidad`: las cuatro columnas se redondean
         -- por separado al liquidar. Ver la cabecera de la 0036.
         case when q.vendedor_id is not null
              then coalesce(q.venta, 0) - coalesce(q.comision, 0) - coalesce(q.premios, 0)
         end,
         p.vendedor_id is not null
  from public.vendedor v
  left join liquidado q on q.vendedor_id = v.id
  left join pendiente p on p.vendedor_id = v.id
  left join acertado  a on a.vendedor_id = v.id
  where v.activo or q.venta is not null or p.venta is not null
  order by coalesce(q.venta, 0) + coalesce(p.venta, 0) desc, v.codigo;
$$;

revoke execute on function public.fn_informe_gerencia(date, date, public.hora_sorteo)
  from public, anon;

comment on function public.fn_informe_gerencia(date, date, public.hora_sorteo) is
  'Informe de gerencia por vendedor. Suma las dos formas de vender: linea a linea y captura por totales. El premiado de las capturas se deduce dividiendo los premios entre el factor.';
