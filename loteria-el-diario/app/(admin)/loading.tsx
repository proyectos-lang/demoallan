/**
 * Esqueleto de navegación, común a todas las pantallas administrativas.
 *
 * Next lo muestra en cuanto se pulsa un enlace y lo sustituye cuando el
 * servidor termina. Sin esto, quitar la precarga de la barra lateral dejaba
 * uno o dos segundos en los que no pasaba nada visible y la aplicación parecía
 * trabada.
 *
 * Se prefiere esto a devolver la precarga: precargar nueve pantallas pesadas
 * era lo que agotaba el tiempo de la base al entrar. Aquí sólo se calcula la
 * que se pidió, y mientras tanto se ve a dónde se va.
 *
 * Bloques con la forma aproximada del contenido, no un girador: así el salto
 * al contenido real no reacomoda la página entera.
 */
export default function CargandoModulo() {
  return (
    <div className="px-[26px] py-[22px]" aria-busy="true">
      <div className="h-[26px] w-[240px] rounded-campo bg-riel" />
      <div className="h-[14px] w-[360px] rounded-campo bg-riel mt-[10px] opacity-60" />

      <div className="grid gap-[18px] mt-6 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[96px] rounded-card bg-riel" />
        ))}
      </div>

      <div className="grid gap-[18px] mt-[18px] [grid-template-columns:repeat(auto-fit,minmax(400px,1fr))]">
        {[0, 1].map((i) => (
          <div key={i} className="h-[260px] rounded-card bg-riel" />
        ))}
      </div>
    </div>
  );
}
