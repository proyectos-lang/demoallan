-- ===========================================================================
-- Índices que el volumen real hizo necesarios.
--
-- Con el histórico completo cargado —166 mil tickets y 746 mil líneas— dos
-- consultas de uso diario se volvieron inaceptables:
--
--     fn_reporte_totales (8 meses)   6403 ms
--     tickets de un día (mapa geo)   2022 ms
--
-- Con los datos de prueba anteriores, de unos pocos miles de filas, ninguna
-- pasaba de unas decenas de milisegundos: el plan malo no se notaba. Es el
-- mismo patrón que ya apareció al sembrar, donde una tabla temporal sin
-- estadísticas acabó agotando el tiempo límite. Un índice que falta no duele
-- hasta que la tabla crece.
-- ===========================================================================

-- --- Tickets por instante --------------------------------------------------
-- El mapa y la actividad por hora filtran por `creado_en` sin vendedor. El
-- único índice que lo incluía era `ticket_vendedor_fecha (vendedor_id,
-- creado_en)`, inservible sin el vendedor por delante: PostgreSQL no puede
-- saltar la primera columna de un índice compuesto.

create index if not exists ticket_creado_en
  on allan.ticket (creado_en desc);

-- --- Líneas, sin ir a la tabla ---------------------------------------------
-- Todo agregado recorre linea -> ticket -> sorteo y sólo necesita el importe y
-- los parámetros congelados. Con INCLUDE, el índice ya los lleva y la consulta
-- se resuelve sin tocar la tabla: 746 mil visitas al montón de datos que
-- desaparecen.
--
-- Cuesta espacio, y es un intercambio deliberado: esta base se lee mucho más
-- de lo que se escribe, y las escrituras van de tres en tres mil por día.

create index if not exists linea_agregados
  on allan.linea (ticket_id)
  include (numero, monto, comision_congelada, factor_congelado, gana, premio);

-- --- Sorteos por fecha ascendente ------------------------------------------
-- `sorteo_fecha` es (fecha DESC, hora), perfecto para "los últimos". Los
-- reportes por rango recorren en ascendente; el índice sirve igual porque
-- PostgreSQL lo puede leer al revés, así que no se añade otro.

analyze allan.linea;
analyze allan.ticket;
analyze allan.sorteo;
analyze allan.cupo_numero;
