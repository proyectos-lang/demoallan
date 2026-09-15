-- ===========================================================================
-- Reversar una liquidación: dejarla como si nunca se hubiera hecho.
--
-- QUÉ HUECO LLENA
-- ---------------
-- Un corte se cierra y no se podía deshacer. Si se liquidó la semana
-- equivocada, se marcó un sorteo de más, o se cerró antes de que llegara una
-- corrección, la única salida era vivir con ello: los sorteos quedaban
-- «pagados» para siempre y no volvían a aparecer en la hoja del vendedor.
--
-- QUÉ SIGNIFICA «COMO SI NUNCA SE HUBIERA HECHO»
-- ----------------------------------------------
-- Tres cosas, y las tres importan:
--
--   1. Los sorteos VUELVEN A ESTAR PENDIENTES. Es lo visible: reaparecen en la
--      hoja para poder liquidarlos otra vez, bien.
--
--   2. Los ABONOS que ese corte absorbió vuelven a estar vivos. Es lo que se
--      olvida y lo que descuadraría la caja: si el vendedor había entregado
--      400 a cuenta, ese dinero estaba contado DENTRO del corte. Al revertir,
--      si los abonos no se liberan, esos 400 desaparecen de la cuenta y se le
--      vuelven a cobrar.
--
--   3. El corte se BORRA. No se marca como anulado: un corte anulado seguiría
--      apareciendo en el historial de pagos del vendedor como si le hubieran
--      entregado algo, que es justo lo contrario de lo que se quiere decir.
--
-- LA HUELLA NO SE PIERDE. La auditoría guarda que existió, de cuánto era, qué
-- período cubría y quién lo revirtió. Eso es lo que permite responder «¿por
-- qué esta semana se liquidó dos veces?» tres meses después.
--
-- QUIÉN PUEDE: sólo administración, y lo decide la Server Action — la base
-- habla como `service_role` desde la 0024.
-- ===========================================================================

create or replace function public.fn_reversar_corte(
  p_corte_id   uuid,
  p_motivo     text default null,
  p_usuario_id uuid default null
)
returns table (
  r_sorteos  integer,   -- cuántos vuelven a estar pendientes
  r_abonos   integer,   -- cuántos abonos se liberan
  r_saldo    numeric,   -- lo que decía el corte
  r_desde    date,
  r_hasta    date
)
language plpgsql
security definer
set search_path = public
as $reversar$
declare
  v_corte   public.corte_vendedor%rowtype;
  v_sorteos integer;
  v_abonos  integer;
begin
  select * into v_corte
  from public.corte_vendedor where id = p_corte_id
  for update;

  if not found then
    raise exception 'Ese corte no existe o ya se revirtió.'
      using errcode = 'no_data_found';
  end if;

  select count(*)::integer into v_sorteos
  from public.corte_detalle where corte_id = p_corte_id;

  /*
   * Los abonos que este corte absorbió vuelven a estar vivos.
   *
   * Va ANTES de borrar el corte: la referencia es `on delete set null`, así
   * que al borrarlo se quedarían en nulo solos. Pero contarlos después sería
   * imposible —ya no habría con qué distinguirlos de los demás abonos vivos—
   * y hace falta el número para decirlo en pantalla.
   */
  select count(*)::integer into v_abonos
  from public.abono_vendedor where corte_id = p_corte_id;

  update public.abono_vendedor
  set corte_id = null
  where corte_id = p_corte_id;

  /*
   * La huella, antes de borrar nada.
   *
   * Se guarda lo que el corte decía —período, sorteos y saldo— porque una vez
   * borrado no hay forma de reconstruirlo, y la pregunta que se hace tres
   * meses después es exactamente ésa: qué se revirtió y por cuánto.
   */
  perform public.fn_auditar(
    'corte_vendedor', p_corte_id, 'reversar', 'saldo',
    v_corte.saldo::text,
    'revertido · ' || v_corte.desde::text || ' a ' || v_corte.hasta::text ||
    ' · ' || v_sorteos::text || ' sorteos',
    p_usuario_id
  );

  if nullif(btrim(coalesce(p_motivo, '')), '') is not null then
    perform public.fn_auditar(
      'corte_vendedor', p_corte_id, 'reversar', 'motivo',
      null, btrim(p_motivo), p_usuario_id
    );
  end if;

  /*
   * Y se borra. El detalle se va con él por la cascada del `references`, que
   * es lo que devuelve los sorteos a pendientes: la hoja los busca por «no
   * existe en corte_detalle».
   *
   * No se marca como anulado a propósito: un corte anulado seguiría figurando
   * en el historial de pagos del vendedor, y ahí diría que se le entregó algo
   * que no se le entregó.
   */
  delete from public.corte_vendedor where id = p_corte_id;

  return query select v_sorteos, v_abonos, v_corte.saldo, v_corte.desde, v_corte.hasta;
end;
$reversar$;

comment on function public.fn_reversar_corte(uuid, text, uuid) is
  'Deshace una liquidación: los sorteos vuelven a pendientes, los abonos absorbidos se liberan y el corte se borra. Queda en auditoría.';

revoke execute on function public.fn_reversar_corte(uuid, text, uuid)
  from public, anon;


-- ---------------------------------------------------------------------------
-- Qué se desharía, antes de tocar nada.
--
-- Revertir es irreversible en el sentido que importa: el corte se borra y no
-- se puede rehacer tal cual. Así que hay que poder ver qué contenía —qué días,
-- cuántos sorteos, cuánto dinero y cuántos abonos quedarían sueltos— antes de
-- confirmar.
-- ---------------------------------------------------------------------------
create or replace function public.fn_detalle_corte(p_corte_id uuid)
returns table (
  r_fecha      date,
  r_hora       public.hora_sorteo,
  r_ganador    smallint,
  r_venta      numeric,
  r_comision   numeric,
  r_premios    numeric,
  r_saldo      numeric
)
language sql
stable
security definer
set search_path = public
as $detalle$
  select s.fecha,
         s.hora,
         s.numero_ganador,
         lq.venta,
         lq.comision,
         lq.premios,
         lq.venta - lq.comision - lq.premios
  from public.corte_detalle d
  join public.liquidacion lq on lq.id = d.liquidacion_id
  join public.sorteo s on s.id = lq.sorteo_id
  where d.corte_id = p_corte_id
  order by s.fecha, s.hora;
$detalle$;

comment on function public.fn_detalle_corte(uuid) is
  'Los sorteos que entraron en un corte, para poder ver qué se desharía antes de revertirlo.';

revoke execute on function public.fn_detalle_corte(uuid) from public, anon;
