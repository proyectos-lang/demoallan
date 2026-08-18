import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

// El prototipo carga Geist y Geist Mono, pero Geist Mono no se usa en ninguna
// pantalla — no la importamos. Geist se sirve desde el paquete `geist`
// (self-hosted) en vez de Google Fonts, para no depender de red en el build.

export const metadata: Metadata = {
  title: "Lotería El Diario",
  description: "Sistema de control de ventas de lotería · Cortés, Honduras",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
