import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

// El prototipo carga Geist y Geist Mono, pero Geist Mono no se usa en ninguna
// pantalla — no la importamos. Geist se sirve desde el paquete `geist`
// (self-hosted) en vez de Google Fonts, para no depender de red en el build.

export const metadata: Metadata = {
  title: "Sistema de Control de Tickets",
  description: "Sistema de control de ventas de lotería · Cortés, Honduras",
  /*
   * Lo que necesita un iPhone para que el atajo se comporte como aplicación.
   * `app/manifest.ts` no le sirve: Safari no lo lee para esto, y sin estas
   * etiquetas el atajo abre Safari con su barra en vez de abrir la aplicación.
   *
   * El título es corto porque es lo que cabe debajo del icono en la pantalla
   * de inicio; el completo no entra en ninguna.
   */
  appleWebApp: {
    capable: true,
    title: "Tickets",
    // El marino de la cabecera: la barra de estado se funde con ella en vez de
    // quedar como una franja blanca encima.
    statusBarStyle: "black-translucent",
  },
  /*
   * Next emite la etiqueta estándar, `mobile-web-app-capable`, que Safari sólo
   * respeta desde iOS 17.4. Debajo de esa versión —que es mucho teléfono en
   * la calle— hace falta la de Apple, y sin ella el atajo abre dentro de
   * Safari en vez de a pantalla completa. Cuestan dieciocho bytes.
   */
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // El mismo marino del manifiesto: pinta la barra del navegador en Android y
  // el borde de la ventana en el escritorio.
  themeColor: "#0f2547",
  // Con `black-translucent` el contenido pasa por debajo de la barra de
  // estado, así que la página tiene que llegar hasta el borde y respetar los
  // recortes con `env(safe-area-inset-*)`, que es lo que ya hace el pie del
  // punto de venta.
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={GeistSans.className}>
      {/*
        `tabular-nums` se hereda desde la raíz: en el prototipo vive en el shell
        y por eso TODA cifra de la aplicación queda alineada. No moverlo a las
        tablas una por una.
      */}
      <body className="bg-fondo text-tinta text-[14px] [font-variant-numeric:tabular-nums]">
        {children}
      </body>
    </html>
  );
}
