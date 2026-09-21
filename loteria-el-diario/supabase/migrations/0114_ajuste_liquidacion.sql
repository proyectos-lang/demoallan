-- ===========================================================================
-- Las liquidaciones ya hechas son INMUTABLES: la corrección queda como ajuste.
--
-- LA DECISIÓN DEL GERENTE
-- -----------------------
-- «Bajo ningún motivo se pueden anular o quitar las liquidaciones ya hechas,
--  aunque se les cambien los valores. No se pueden volver a abrir. Si se aumenta
--  o baja, que quede como un saldo a favor o en contra pendiente por liquidar.»
--
-- EL PROBLEMA QUE RESUELVE
-- ------------------------
-- Hasta ahora, al corregir un sorteo YA PAGADO, la reconciliación (0104)
-- DESLIGABA el sorteo de su corte —por eso reaparecía «abierto» en la hoja— y
-- dejaba el corte descuadrado consigo mismo. El dinero cuadraba por un abono,
-- pero el corte firmado quedaba tocado y sin explicación.
--
-- EL MODELO NUEVO
-- ---------------
-- La liquidación pagada se queda intacta en su corte, para siempre. Si al
-- corregir un sorteo ya pagado la cifra cambia, la DIFERENCIA se acumula aquí,
-- en `ajuste_liquidacion`, con signo:
--
--   · positivo  → el vendedor debe más (vendió/ganó más de lo pagado);
--   · negativo  → a su favor (se le pagó de más, o bajó la venta).
--
-- Ese ajuste aparece como una línea aparte —«ajuste por corrección»— en la
-- cuenta pendiente del vendedor, y se cierra al liquidar, igual que un abono.
-- Nada reabre el corte ni toca la liquidación original.
--
-- Es signado, cosa que un abono no puede ser (`abono_positivo`), por eso hace
-- falta una tabla propia y no reusar los abonos.
-- ===========================================================================

create table if not exists public.ajuste_liquidacion (
  id          uuid primary key default gen_random_uuid(),
  vendedor_id uuid not null references public.vendedor(id),
  sorteo_id   uuid not null references public.sorteo(id),

  /* La diferencia acumulada de las correcciones de ese sorteo ya pagado.
     Con signo: + el vendedor debe más, − a su favor. */
  monto       numeric(14,2) not null,

  motivo      text,

  /* El corte que cerró este ajuste. Nulo mientras sigue pendiente; una vez
     fijado, ya está contado en ese corte y deja de sumar por su cuenta. Misma
     mecánica que `abono_vendedor.corte_id`. */
  saldado_corte_id uuid references public.corte_vendedor(id) on delete set null,

  creado_en   timestamptz not null default now(),
  usuario_id  uuid,

  /* Un solo ajuste VIVO por sorteo y vendedor: las correcciones sucesivas se
     acumulan sobre la misma fila, no crean varias. Cuando se salda, esa queda
     marcada y una corrección posterior abriría una nueva. */
  unique (sorteo_id, vendedor_id, saldado_corte_id)
);

comment on table public.ajuste_liquidacion is
  'Diferencia signada que deja corregir un sorteo YA PAGADO, sin tocar la liquidación ni el corte. Suma al saldo pendiente del vendedor y se cierra al liquidar, como un abono, pero con signo.';

create index if not exists ajuste_liquidacion_vivo_idx
  on public.ajuste_liquidacion (vendedor_id)
  where saldado_corte_id is null;

alter table public.ajuste_liquidacion enable row level security;
-- Sin políticas: sólo se lee desde el servidor con service_role.

-- --------------------------------------------------------------------------
-- El ajuste pendiente de un vendedor: lo que suman sus ajustes vivos.
-- Un solo lugar, para que las seis funciones de saldo lo sumen con una línea.
-- --------------------------------------------------------------------------
create or replace function public.fn_ajuste_pendiente(p_vendedor_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $ajuste$
  select coalesce(sum(a.monto), 0)
  from public.ajuste_liquidacion a
  where a.vendedor_id = p_vendedor_id
    and a.saldado_corte_id is null;
$ajuste$;

comment on function public.fn_ajuste_pendiente(uuid) is
  'Suma de los ajustes por corrección vivos de un vendedor (con signo). Se añade al pendiente en las pantallas de saldo.';

revoke execute on function public.fn_ajuste_pendiente(uuid) from public, anon;
