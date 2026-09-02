"use client";

import { useActionState, useState } from "react";
import { AlignLeft, Eye, EyeOff } from "lucide-react";

import { BotonesApp } from "@/components/shell/instalar";
import { Boton } from "@/components/ui/boton";
import { cn } from "@/lib/cn";
import { entrar } from "./acciones";

const CLASE_CAMPO =
  "w-full px-[13px] py-[11px] border border-borde-campo rounded-campo text-base outline-none bg-superficie";

/**
 * El acceso.
 *
 * Era una tarjeta blanca de 380 px flotando sobre el gris de fondo, con el
 * nombre en una línea y dos campos. Funcionaba, pero es la primera pantalla que
 * ve todo el mundo —el gerente en un monitor y el vendedor en un teléfono a
 * pleno sol— y no decía nada de lo que hay detrás.
 *
 * Ahora la marca vive en un bloque marino, el mismo de la barra lateral y de
 * las tarjetas héroe, así que entrar y estar dentro se parecen. Nada de esto
 * inventa color ni tipografía: son los tokens del prototipo, y sigue sin haber
 * una sola transición, como en el resto del sistema.
 */
export default function LoginPage() {
  const [error, accion, pendiente] = useActionState(entrar, null);
  const [verClave, setVerClave] = useState(false);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-5">
      <div className="w-[420px] max-w-full bg-superficie border border-borde rounded-modal shadow-modal overflow-hidden">
        {/* --- La marca, sobre el marino de dentro --- */}
        <div
          className="px-7 pt-7 pb-6 text-nav-titulo"
          style={{ background: "var(--gradiente-dia)" }}
        >
          <span
            className="w-11 h-11 flex-none rounded-banner flex items-center justify-center"
            style={{ background: "var(--gradiente-logo)" }}
          >
            <AlignLeft size={23} color="#fff" strokeWidth={2} absoluteStrokeWidth />
          </span>
          <h1 className="text-h1 font-semibold tracking-titular mt-4 mb-0">
            Sistema de Control de Tickets
          </h1>
          <p className="text-meta text-navy-etiqueta mt-2 mb-0 leading-[1.55]">
            Cortés, Honduras
          </p>
        </div>

        <form action={accion} className="px-7 pt-6 pb-7">
          <label className="block">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Usuario
            </span>
            <input
              name="usuario"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              placeholder="v001"
              className={CLASE_CAMPO}
            />
          </label>

          <label className="block mt-4">
            <span className="block text-label text-secundario font-medium mb-[6px]">
              Contraseña
            </span>
            {/*
              El ojo no es adorno.

              Las contraseñas las genera administración y se entregan en mano:
              diez caracteres del alfabeto sin letras que se confundan al
              dictar. Teclear eso con el pulgar, a ciegas y de pie, es el
              motivo más común de «no me deja entrar».
            */}
            <span className="relative block">
              <input
                name="contrasena"
                type={verClave ? "text" : "password"}
                autoComplete="current-password"
                className={cn(CLASE_CAMPO, "pr-[46px]")}
              />
              <button
                type="button"
                onClick={() => setVerClave((v) => !v)}
                aria-label={verClave ? "Ocultar la contraseña" : "Ver la contraseña"}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-campo"
              >
                {verClave ? (
                  <EyeOff size={17} color="var(--color-secundario)" strokeWidth={2} absoluteStrokeWidth />
                ) : (
                  <Eye size={17} color="var(--color-secundario)" strokeWidth={2} absoluteStrokeWidth />
                )}
              </button>
            </span>
          </label>

          {/* Altura reservada: sin ella el botón salta al aparecer el error. */}
          <p className="text-meta text-negativo min-h-[18px] mt-3 mb-0">{error}</p>

          <Boton type="submit" tamano="lg" disabled={pendiente} className="w-full mt-2">
            {pendiente ? "Entrando…" : "Entrar"}
          </Boton>

          <p className="text-label text-mudo leading-[1.55] mt-5 mb-0 text-center">
            Las cuentas las crea administración. Si olvidó su contraseña, pídale
            que se la restablezca.
          </p>
        </form>

        {/* Instalar se ofrece aquí además de dentro: es la primera pantalla que
            ve un vendedor con un teléfono nuevo, y el momento en que quiere el
            atajo es justo antes de entrar, no después. */}
        <div className="px-7 pb-6 -mt-1">
          <BotonesApp />
        </div>
      </div>
    </div>
  );
}
