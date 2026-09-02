-- ===========================================================================
-- Arreglo: la restricción de «una sola captura viva» no restringía nada.
--
-- La 0047 la escribió así:
--
--   constraint venta_total_unica unique (sorteo_id, vendedor_id, anulado_en)
--
-- La idea era que sólo pudiera haber una fila viva por vendedor y sorteo, con
-- las anuladas fuera. No funciona: en SQL dos NULL no son iguales entre sí, y
-- `anulado_en` es NULL precisamente en las filas vivas. El índice único trata
-- cada fila viva como distinta de las demás y deja pasar todas.
--
-- Comprobado en la base: se registró una captura, se registró otra del mismo
-- vendedor y el mismo sorteo, y ninguna de las dos se rechazó. Dos capturas
-- del mismo día se suman en silencio en la liquidación y nadie sabría cuál es
-- la buena.
--
-- Lo correcto es un índice único PARCIAL: sobre (sorteo_id, vendedor_id) y
-- sólo sobre las filas vivas. Ahí no hay nulos que comparar y la unicidad se
-- cumple donde tiene que cumplirse, mientras el histórico de anuladas puede
-- crecer sin estorbar.
--
-- Se limpia antes cualquier duplicado que la restricción rota haya dejado
-- pasar: se conserva la más reciente de cada par y se anulan las anteriores,
-- que es lo que habría hecho quien capturó si el sistema le hubiera avisado.
-- ===========================================================================

alter table allan.venta_total
  drop constraint if exists venta_total_unica;

-- Duplicados que pudo dejar pasar la restricción rota: sobrevive la última.
update allan.venta_total vt
set anulado_en = now()
where vt.anulado_en is null
  and exists (
    select 1
    from allan.venta_total otra
    where otra.sorteo_id = vt.sorteo_id
      and otra.vendedor_id = vt.vendedor_id
      and otra.anulado_en is null
      and (otra.creado_en, otra.id) > (vt.creado_en, vt.id)
  );

create unique index if not exists venta_total_una_viva
  on allan.venta_total (sorteo_id, vendedor_id)
  where anulado_en is null;

comment on index allan.venta_total_una_viva is
  'Una sola captura por totales viva por vendedor y sorteo. Parcial: las anuladas no cuentan.';
