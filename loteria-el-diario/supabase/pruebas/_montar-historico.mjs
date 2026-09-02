import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const env=Object.fromEntries(readFileSync(new URL("../../.env.local", import.meta.url),"utf8").split("\n").filter(l=>l.includes("=")).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{db:{schema:"public"},auth:{persistSession:false}});
const F=["2095-01-15","2095-02-15","2095-03-15"];
const limpiar=async()=>{for(const f of F){const {data:ss}=await sb.from("sorteo").select("id").eq("fecha",f);
 for(const s of ss??[]){await sb.from("liquidacion").delete().eq("sorteo_id",s.id);
  const {data:ts}=await sb.from("ticket").select("id").eq("sorteo_id",s.id);
  for(const t of ts??[]) await sb.from("linea").delete().eq("ticket_id",t.id);
  await sb.from("ticket").delete().eq("sorteo_id",s.id);
  await sb.from("cupo_numero").delete().eq("sorteo_id",s.id);
  await sb.from("sorteo").delete().eq("id",s.id);}}};
// La bitácora NO se toca. Es append-only por diseño (§10) y un script de datos
// de prueba no tiene por qué vaciarla: aquí había un `delete().gt("id",0)` que
// borraba la tabla entera, no sólo lo que este script había escrito.
if (process.argv[2]==="limpiar"){await limpiar();console.log("retirado (la bitácora se conserva)");process.exit(0);}
await limpiar();
const {data:vs}=await sb.from("vendedor").select("id,codigo").order("codigo");
for(const [i,f] of F.entries()){
  await sb.rpc("fn_programar_dia",{p_fecha:f});
  const {data:ss}=await sb.from("sorteo").select("id,hora").eq("fecha",f);
  const id=ss.find(s=>s.hora==="20:00").id;
  let e=(await sb.rpc("fn_abrir_sorteo",{p_sorteo_id:id,p_limite_por_numero:90000})).error; if(e)throw new Error(e.message);
  const m=100*(i+1);
  e=(await sb.rpc("fn_registrar_ticket",{p_sorteo_id:id,p_vendedor_id:vs[0].id,p_lineas:[{numero:42,monto:m},{numero:7,monto:m}]})).error; if(e)throw new Error(e.message);
  e=(await sb.rpc("fn_registrar_ticket",{p_sorteo_id:id,p_vendedor_id:vs[1].id,p_lineas:[{numero:42,monto:m/2}]})).error; if(e)throw new Error(e.message);
  if(i<2){await sb.rpc("fn_cerrar_sorteo",{p_sorteo_id:id});
    e=(await sb.rpc("fn_liquidar_sorteo",{p_sorteo_id:id,p_numero_ganador:42})).error; if(e)throw new Error(e.message);}
}
console.log("montado: ene y feb liquidados, mar sin liquidar");
