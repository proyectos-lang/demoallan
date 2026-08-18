# Lotería El Diario

Sistema de control de ventas de lotería · Cortés, Honduras.

```
loteria-el-diario/   la aplicación (Next.js 16 + Supabase)
prototipo/           la maqueta aprobada — fuente de verdad del apartado visual
```

La documentación de verdad está en
[`loteria-el-diario/README.md`](loteria-el-diario/README.md): puesta en marcha,
migraciones, convenciones de datos y cómo correr las pruebas.

El prototipo se abre en el navegador (`prototipo/Loteria El Diario.dc.html`) y
sirve para comparar pantalla contra pantalla. No es documentación histórica: es
la referencia contra la que se contrasta la interfaz.

## Lo que no está en el repositorio

- **`.env.local`** — lleva la llave de servicio de Supabase, que ignora RLS, y
  la de Google. Se parte de `loteria-el-diario/.env.local.example`.
- **`loteria-el-diario/muestras/`** — hojas de apuestas manuscritas usadas para
  probar la digitalización. Llevan apuestas de personas reales, así que sólo se
  versiona el `LEEME.md` que explica dónde ponerlas.
