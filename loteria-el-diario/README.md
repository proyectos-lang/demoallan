# Lotería El Diario

Sistema de control de ventas de lotería · Cortés, Honduras.

La maqueta de referencia vive en [`../prototipo/`](../prototipo/) — se puede abrir
`Loteria El Diario.dc.html` en el navegador y comparar pantalla contra pantalla.
Es la fuente de verdad del apartado visual.

## Puesta en marcha

```bash
npm install
cp .env.local.example .env.local   # y rellenar las llaves
npm run dev
```

## Supabase

La base vive en el esquema **`allan`**, no en `public`. Eso obliga a dos pasos
que es fácil olvidar:

1. **Aplicar las migraciones** de [`supabase/migrations/`](supabase/migrations/)
   en orden. Desde el SQL Editor del dashboard, o:

   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```

2. **Exponer el esquema a la API**: Dashboard → Project Settings → API →
   *Exposed schemas* → añadir `allan`. Sin esto PostgREST no ve ninguna tabla y
   toda consulta responde 404, aunque los permisos estén bien.

Después, regenerar los tipos (reemplaza el marcador de `lib/supabase/tipos.ts`):

```bash
npx supabase gen types typescript --project-id <ref> --schema allan > lib/supabase/tipos.ts
```

### Cómo se escribe en esta base

Ninguna escritura se hace con `INSERT` desde el cliente. Todo pasa por funciones
`SECURITY DEFINER` (ver [`0002_funciones.sql`](supabase/migrations/0002_funciones.sql)):

| Función | Uso |
|---|---|
| `fn_abrir_sorteo(sorteo, limite_por_numero)` | Siembra las 100 filas de cupo y abre la venta |
| `fn_registrar_ticket(sorteo, vendedor, lineas, …)` | Venta. Valida cupo con la fila bloqueada, dentro de la transacción |
| `fn_cerrar_sorteo(sorteo)` | Corta la venta |
| `fn_liquidar_sorteo(sorteo, numero_ganador)` | Marca ganadoras, calcula premios y bloquea el sorteo |
| `fn_anular_ticket(ticket, motivo)` | Anula y devuelve el cupo. Los tickets no se editan |
| `fn_guardar_parametros(vendedor, comision, factor, tope)` | Versiona; no reescribe historia |
| `fn_cupo_disponible(sorteo, vendedor, numero)` | Sólo consulta. **No es autoritativa** |
| `fn_reparar_cupo(sorteo)` | Repone las filas de cupo que falten, reconstruyendo `vendido` desde las líneas |

El ciclo (`fn_ciclo_sorteos`, cada cinco minutos vía pg_cron) programa, abre,
repara y cierra. La reparación existe porque un sorteo `abierto` sin filas de
cupo rechaza **toda** venta, y `fn_abrir_sorteo` no lo arregla: sólo actúa sobre
sorteos `programado`.

Las tablas sólo tienen políticas RLS de **lectura**. La ausencia de políticas de
escritura es intencional: es lo que impide saltarse la validación de cupo.

### Scripts de operación

```bash
node supabase/sembrar.mjs                                    # los 5 vendedores del prototipo (idempotente)
node supabase/crear-usuario.mjs <correo> <clave> <rol> [V-00N]  # alta de acceso
```

Roles: `administrador`, `auditor`, `digitador`, `vendedor` (este último exige el
código del vendedor al que se enlaza). Las cuentas las crea administración: no
hay registro público ni correo de verificación.

### Pruebas contra la base

Se ejecutan contra el proyecto real y limpian lo que crean.

```bash
node supabase/pruebas/nucleo.mjs         # ciclo de sorteo, congelamiento, cupo, liquidación
node supabase/pruebas/concurrencia.mjs   # 25 ventas simultáneas: ¿se puede sobrevender?
node supabase/pruebas/liquidacion.mjs    # ¿coincide la vista previa con lo que se liquida?
PW=<clave-admin> node supabase/pruebas/autorizacion.mjs   # escalada de privilegios por rol
PW=<clave-admin> node supabase/pruebas/agregados.mjs      # tablero: ¿se cuela lo pendiente en la utilidad?
PW=<clave-admin> node supabase/pruebas/reportes.mjs       # ¿los subtotales son del filtro o de la página?
PW=<clave-admin> node supabase/pruebas/simulador.mjs      # ¿el escenario neutro no mueve nada?

# Digitalización, con una hoja real de muestras/ (ver muestras/LEEME.md).
# La condición react-server hace falta por la guarda `server-only` del módulo.
node --conditions=react-server supabase/pruebas/ocr.mjs muestras/<archivo>

# Histórico de mentira para mirar el tablero con datos (2095, tres meses):
node supabase/pruebas/_montar-historico.mjs
node supabase/pruebas/_montar-historico.mjs limpiar

# Renderizado real, con sesión. Requiere el servidor levantado.
BASE=http://localhost:3000 PW=<clave-admin> node supabase/pruebas/render.mjs
```

Conviene volver a correrlas después de cualquier migración que toque funciones
o permisos: los dos huecos de seguridad que aparecieron hasta ahora los
encontraron ellas, no la lectura del código.

### Convenciones de datos

- **Comisión: fracción, no porcentaje.** 12.5 % se guarda `0.12500`, para que la
  fórmula sea `monto * comision_congelada` sin dividir entre 100.
- **Factor de pago: multiplicador** tal cual (`70.00`).
- **Número: `smallint` 0–99.** El `"07"` es presentación (`pad2`), no dato.
- **Dinero: `numeric(14,2)`.** Nunca coma flotante.

## Notas del apartado visual

Los tokens del prototipo están en [`app/globals.css`](app/globals.css) dentro de
`@theme`. Tres cosas que parecen errata y no lo son:

- La escala tipográfica tiene medias unidades (`13.5px`, `11.5px`, `10.5px`).
- El signo negativo de las cifras es `−` (U+2212), no el guion ASCII, y los miles
  se agrupan con locale `en-US` aunque el texto esté en español. Ver
  [`lib/format.ts`](lib/format.ts).
- **El prototipo no tiene ni una transición CSS.** Los estados cambian de golpe.
  Añadir `transition` es desviarse de la maqueta aprobada.

`tabular-nums` se hereda desde `<body>`: no hace falta ponerlo tabla por tabla.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
Supabase · Leaflet 1.9.4 + OpenStreetMap · Dexie (cola offline) · Serwist (PWA).

Ojo con Next 16: las request APIs son asíncronas (`await cookies()`, `await params`)
y el antiguo `middleware.ts` ahora es [`proxy.ts`](proxy.ts).
