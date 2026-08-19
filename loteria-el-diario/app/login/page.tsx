"use client";

import { useActionState } from "react";
import { AlignLeft } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { entrar } from "./acciones";

export default function LoginPage() {
  const [error, accion, pendiente] = useActionState(entrar, null);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        action={accion}
        className="w-[380px] max-w-full bg-superficie border border-borde rounded-card shadow-card px-7 py-7"
      >
        <div className="flex items-center gap-[11px] mb-6">
          <span
            className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
            style={{ background: "var(--gradiente-logo)" }}
          >
            <AlignLeft size={20} color="#fff" strokeWidth={2} absoluteStrokeWidth />
          </span>
          <span className="block text-h2 font-semibold tracking-sutil">
            Lotería El Diario
          </span>
        </div>

        <label className="block text-label text-secundario font-medium mb-[6px]">
          Correo
        </label>
        <input
          name="correo"
          type="email"
          autoComplete="username"
          autoFocus
          className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none mb-4"
        />

        <label className="block text-label text-secundario font-medium mb-[6px]">
          Contraseña
        </label>
        <input
          name="contrasena"
          type="password"
          autoComplete="current-password"
          className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none"
        />

        <p className="text-meta text-negativo min-h-[18px] mt-3 mb-0">{error}</p>

        <Boton type="submit" disabled={pendiente} className="w-full mt-2">
          {pendiente ? "Entrando…" : "Entrar"}
        </Boton>
      </form>
    </div>
  );
}
