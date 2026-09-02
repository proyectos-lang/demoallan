/**
 * Genera los iconos de la aplicación instalable a partir de un solo dibujo.
 *
 * El icono es un ticket: el objeto que el negocio entrega en la mano, y lo que
 * hace reconocible el acceso directo en una pantalla llena de aplicaciones. Va
 * sobre el mismo degradado del logotipo de la barra lateral —#2563eb a #1e40af
 * en 145°— para que el atajo y la aplicación abierta se parezcan.
 *
 * DOS DIBUJOS Y NO UNO. A 32 px el ticket detallado se convierte en una mancha:
 * las cuatro líneas de texto y la perforación caen por debajo de un píxel. La
 * variante de favicon lleva el ticket más grande y una sola barra.
 *
 * EL TICKET CABE EN LA ZONA SEGURA de un icono enmascarable: Android recorta a
 * un círculo de 80 % del lienzo, y la esquina más lejana del ticket queda a 180
 * de los 205 de radio. Por eso los dos tamaños del manifiesto pueden declararse
 * `any maskable` sin recortar nada.
 *
 *     node supabase/pruebas/_iconos.mjs
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const FONDO = `
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563eb"/>
      <stop offset="1" stop-color="#1e40af"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>`;

/** El ticket con su perforación y sus renglones: para 180 px en adelante. */
const DETALLADO = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${FONDO}
  <mask id="m">
    <rect x="106" y="156" width="300" height="200" rx="26" fill="#fff"/>
    <circle cx="106" cy="256" r="26" fill="#000"/>
    <circle cx="406" cy="256" r="26" fill="#000"/>
  </mask>
  <rect x="106" y="156" width="300" height="200" rx="26" fill="#fff" mask="url(#m)"/>
  <line x1="330" y1="184" x2="330" y2="328" stroke="#2563eb" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="0.1 22"/>
  <rect x="142" y="192" width="150" height="20" rx="10" fill="#1e40af"/>
  <rect x="142" y="232" width="112" height="15" rx="7.5" fill="#93b4fd"/>
  <rect x="142" y="268" width="134" height="15" rx="7.5" fill="#93b4fd"/>
  <rect x="142" y="304" width="88"  height="15" rx="7.5" fill="#93b4fd"/>
</svg>`;

/** El mismo ticket, sin detalle, para 32 y 48 px. */
const SIMPLE = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${FONDO}
  <mask id="m">
    <rect x="64" y="150" width="384" height="212" rx="34" fill="#fff"/>
    <circle cx="64"  cy="256" r="38" fill="#000"/>
    <circle cx="448" cy="256" r="38" fill="#000"/>
  </mask>
  <rect x="64" y="150" width="384" height="212" rx="34" fill="#fff" mask="url(#m)"/>
  <rect x="118" y="222" width="196" height="34" rx="17" fill="#1e40af"/>
  <rect x="118" y="278" width="140" height="26" rx="13" fill="#93b4fd"/>
</svg>`;

const png = (svg, lado) =>
  sharp(Buffer.from(svg)).resize(lado, lado).png({ compressionLevel: 9 }).toBuffer();

/**
 * Envuelve un PNG en un contenedor ICO.
 *
 * El formato admite PNG dentro desde Vista, así que basta con la cabecera de
 * 22 bytes: no hace falta rasterizar a BMP ni escribir la máscara AND. `sharp`
 * no sabe escribir ICO, y era eso o meter una dependencia para veintidós bytes.
 */
function ico(pngBuffer, lado) {
  const cabecera = Buffer.alloc(22);
  cabecera.writeUInt16LE(0, 0); // reservado
  cabecera.writeUInt16LE(1, 2); // 1 = icono
  cabecera.writeUInt16LE(1, 4); // una sola imagen
  cabecera.writeUInt8(lado === 256 ? 0 : lado, 6); // ancho, 0 significa 256
  cabecera.writeUInt8(lado === 256 ? 0 : lado, 7); // alto
  cabecera.writeUInt8(0, 8); // colores de paleta
  cabecera.writeUInt8(0, 9); // reservado
  cabecera.writeUInt16LE(1, 10); // planos
  cabecera.writeUInt16LE(32, 12); // bits por píxel
  cabecera.writeUInt32LE(pngBuffer.length, 14);
  cabecera.writeUInt32LE(22, 18); // desplazamiento de los datos
  return Buffer.concat([cabecera, pngBuffer]);
}

const salidas = [
  ["public/icono-192.png", DETALLADO, 192],
  ["public/icono-512.png", DETALLADO, 512],
  ["app/apple-icon.png", DETALLADO, 180],
  ["app/icon.png", SIMPLE, 48],
];

for (const [ruta, svg, lado] of salidas) {
  const b = await png(svg, lado);
  writeFileSync(new URL(`../../${ruta}`, import.meta.url), b);
  console.log(`  ${ruta.padEnd(24)} ${lado}px  ${(b.length / 1024).toFixed(1)} kB`);
}

const favicon = ico(await png(SIMPLE, 32), 32);
writeFileSync(new URL("../../app/favicon.ico", import.meta.url), favicon);
console.log(`  app/favicon.ico          32px  ${(favicon.length / 1024).toFixed(1)} kB`);
