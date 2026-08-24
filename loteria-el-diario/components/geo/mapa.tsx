"use client";

import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { useEffect } from "react";
import "leaflet/dist/leaflet.css";

import { fmt, hora12 } from "@/lib/format";

export type Punto = {
  folio: string;
  lat: number;
  lng: number;
  total: number;
  lineas: number;
  hora: string;
  reloj: string;
  vendedor: string;
  zona: string;
  color: string;
};

/** Centro por defecto: el valle de Sula, que es donde opera la red. */
const CENTRO: [number, number] = [15.56, -87.99];
const ZOOM = 11;

/** Reencuadra cuando cambia el filtro, sin recrear el mapa entero. */
function Reencuadrar({ centro, zoom }: { centro: [number, number]; zoom: number }) {
  const mapa = useMap();
  useEffect(() => {
    mapa.setView(centro, zoom);
  }, [mapa, centro, zoom]);
  return null;
}

export default function Mapa({
  puntos,
  centro = CENTRO,
  zoom = ZOOM,
}: {
  puntos: Punto[];
  centro?: [number, number];
  zoom?: number;
}) {
  return (
    <MapContainer
      center={CENTRO}
      zoom={ZOOM}
      scrollWheelZoom={false}
      style={{ width: "100%", height: 560, borderRadius: 12 }}
    >
      <Reencuadrar centro={centro} zoom={zoom} />
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap"
        maxZoom={18}
      />
      {puntos.map((p) => (
        <CircleMarker
          key={p.folio}
          center={[p.lat, p.lng]}
          // El tamaño refleja el monto, acotado para que un ticket grande no
          // tape el barrio entero ni uno pequeño desaparezca.
          radius={Math.max(4, Math.min(11, 3 + p.total / 140))}
          pathOptions={{
            color: p.color,
            fillColor: p.color,
            weight: 1.6,
            fillOpacity: 0.42,
          }}
        >
          <Popup>
            <strong>{p.vendedor}</strong>
            <br />
            {p.reloj} · sorteo {hora12(p.hora)}
            <br />
            {p.folio} · {p.lineas} {p.lineas === 1 ? "línea" : "líneas"} · {fmt(p.total)}
            <br />
            <span style={{ color: "#64748b" }}>{p.zona}</span>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
