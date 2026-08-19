"use client";

import { useActionState } from "react";
import { KeyRound } from "lucide-react";

import { Boton } from "@/components/ui/boton";
import { cambiarClave } from "./acciones";

export default function ClavePage() {
  const [error, accion, pendiente] = useActionState(cambiarClave, null);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form
        action={accion}
        className="w-[380px] max-w-full bg-superficie border border-borde rounded-card shadow-card px-7 py-7"
      >
        <div className="flex items-center gap-[11px] mb-5">
          <span
            className="w-[38px] h-[38px] flex-none rounded-banner flex items-center justify-center"
            style={{ background: "var(--gradiente-logo)" }}
          >
            <KeyRound size={19} color="#fff" strokeWidth={2} absoluteStrokeWidth />
          </span>
          <span className="block text-h2 font-semibold tracking-sutil">Cambiar contraseña</span>
        </div>

        <p className="text-meta text-secundario leading-[1.55] mb-5 mt-0">
          La contraseña que le entregó administración es de un solo uso. Elija una que sólo usted
          conozca: con ella se registran ventas a su nombre.
        </p>

        {[
          { name: "actual", label: "Contraseña actual", auto: "current-password" },
          { name: "nueva", label: "Contraseña nueva", auto: "new-password" },
          { name: "repetida", label: "Repita la nueva", auto: "new-password" },
        ].map((c) => (
          <div key={c.name} className="mb-4">
            <label className="block text-label text-secundario font-medium mb-[6px]">
              {c.label}
            </label>
            <input
              name={c.name}
              type="password"
              autoComplete={c.auto}
              className="w-full px-3 py-[9px] border border-borde-campo rounded-campo text-base outline-none"
            />
          </div>
        ))}

        <p className="text-meta text-negativo min-h-[18px] mt-1 mb-0">{error}</p>

        <Boton type="submit" disabled={pendiente} className="w-full mt-2">
          {pendiente ? "Guardando…" : "Guardar"}
        </Boton>
      </form>
    </div>
  );
}
