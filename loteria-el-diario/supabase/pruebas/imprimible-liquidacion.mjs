/**
 * La hoja de liquidación semanal, en papel.
 *
 * QUÉ SE COMPRUEBA Y POR QUÉ ASÍ
 * ------------------------------
 * La hoja se rehizo para parecerse a la que ya se usa a mano. Lo que hay que
 * demostrar no se ve leyendo el HTML:
 *
 *   · Que NO lleve la columna del factor. Se pidió fuera.
 *   · Que cada día traiga su GRAN TOTAL tras los tres sorteos — es lo que
 *     permite cuadrar día a día con el vendedor sin sumar de cabeza.
 *   · Que la celda del día diga «LUNES 31 / AGOS 26» y abarque los tres
 *     sorteos, como el recuadro de la hoja de papel.
 *   · Que la semana entera QUEPA EN UNA HOJA. Con siete gran totales nuevos
 *     el riesgo es que se derrame a una segunda página para llevar sólo las
 *     firmas, y eso se mide contra el área real de un A4.
 *
 * Se genera con el MISMO código que usa la aplicación: una prueba que
 * reimplementara el imprimible comprobaría su propia reimplementación.
 *
 *     node supabase/pruebas/imprimible-liquidacion.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const ts = (await import("typescript")).default;
const taller = mkdtempSync(join(tmpdir(), "liq-"));
const urlDe = (f) => new URL(`file:///${f.split("\\").join("/")}`).href;
async function cargar(ruta, destino, sust = {}) {
  let fuente = readFileSync(ruta, "utf8");
  for (const [de, a] of Object.entries(sust)) fuente = fuente.replace(de, a);
  const js = ts.transpileModule(fuente, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const archivo = join(taller, destino);
  writeFileSync(archivo, js, "utf8");
  return import(urlDe(archivo));
}
await cargar("lib/format.ts", "formato.mjs");
const { documentoLiquidacion } = await cargar("components/liquidacion/imprimible.ts", "imprimible.mjs", { '"@/lib/format"': '"./formato.mjs"' });

// Una semana como la de la foto: siete días, tres sorteos cada uno.
const dias = ["2026-08-31","2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-05","2026-09-06"];
const lineas = dias.flatMap((fecha, d) =>
  ["11:00","15:00","21:00"].map((hora, i) => ({
    fecha, hora, ganador: (d * 7 + i * 13) % 100,
    venta: 1000 + d * 500 + i * 250,
    premiado: i === 0 ? 20 : 0, factor: 70,
    comision: (1000 + d * 500 + i * 250) * 0.15,
    premios: i === 0 ? 1400 : 0,
    saldo: (1000 + d * 500 + i * 250) * 0.85 - (i === 0 ? 1400 : 0),
    pagado: false,
  })));
const html = documentoLiquidacion({
  vendedor: "PHILLIP", comisionTasa: 0.15, desde: dias[0], hasta: dias[6],
  semana: 36, lineas, abonos: [], arrastre: 0,
});
const archivo = join(taller, "hoja.html");
writeFileSync(archivo, html, "utf8");

const perfil = mkdtempSync(join(tmpdir(), "chr-"));
const chrome = spawn(process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",["--headless=new","--remote-debugging-port=9346",`--user-data-dir=${perfil}`,"--no-first-run","about:blank"],{stdio:"ignore"});
const esperar=(ms)=>new Promise(r=>setTimeout(r,ms));
let url; for(let i=0;i<40;i++){try{const t=(await(await fetch("http://127.0.0.1:9346/json/list")).json()).find(x=>x.type==="page");if(t?.webSocketDebuggerUrl){url=t.webSocketDebuggerUrl;break;}}catch{}await esperar(250);}
const ws=new WebSocket(url); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let n=0; const pend=new Map();
ws.onmessage=(m)=>{const g=JSON.parse(m.data); if(g.id&&pend.has(g.id)){pend.get(g.id)(g);pend.delete(g.id);}};
const cdp=(method,params={})=>new Promise(res=>{const id=++n;pend.set(id,res);ws.send(JSON.stringify({id,method,params}));});
const ev=async(e)=>(await cdp("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true})).result?.result?.value;
await cdp("Page.enable"); await cdp("Runtime.enable");
await cdp("Emulation.setEmulatedMedia",{media:"print"});
await cdp("Emulation.setDeviceMetricsOverride",{width:744,height:1015,deviceScaleFactor:1,mobile:false});
await cdp("Page.navigate",{url:urlDe(archivo)}); await esperar(1500);
let ok = 0;
let fallos = 0;
const check = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ok    ${n}`); }
  else { fallos++; console.log(`  FALLA ${n} ${d}`); }
};

const m = await ev(`
 (() => {
   const cab=[...document.querySelectorAll('table.detalle thead th')].map(t=>t.textContent.trim());
   const gt=[...document.querySelectorAll('tr.grantotal')];
   const f=document.querySelector('td.f');
   const alto=Math.ceil(Math.max.apply(null,Array.from(document.body.children,e=>e.getBoundingClientRect().bottom)));
   return {
     columnas:cab,
     tieneFactor:cab.some(c=>/factor/i.test(c)),
     granTotales:gt.length,
     textoGT:gt[0]?gt[0].textContent.replace(/\s+/g,' ').trim():null,
     celdaDia:f?f.textContent.replace(/\s+/g,' ').trim():null,
     rowspan:f?f.getAttribute('rowspan'):null,
     alto, util:window.innerHeight, paginas:Math.ceil(alto/window.innerHeight),
   };
 })()
`);

check("NO lleva la columna del factor", m.tieneFactor === false, m.columnas.join(", "));
check(
  "las columnas son las pedidas",
  JSON.stringify(m.columnas) === JSON.stringify(
    ["Fecha","Sorteo","Ganador","Venta","Valor premiado","Premios","Comisión","Saldo"]),
  m.columnas.join(" | "),
);
check("cada día trae su gran total", m.granTotales === 7, `${m.granTotales} de 7`);
check("el gran total dice lo que es", /Gran total/i.test(m.textoGT ?? ""), String(m.textoGT));
check(
  "la celda del día lleva el nombre del día",
  /LUNES/.test(m.celdaDia ?? "") && /AGOS/.test(m.celdaDia ?? ""),
  String(m.celdaDia),
);
check("y abarca los tres sorteos", m.rowspan === "3", String(m.rowspan));

console.log(`        ${m.alto}px de alto sobre ${m.util} útiles`);
check("LA SEMANA ENTERA CABE EN UNA HOJA", m.paginas === 1, `${m.paginas} páginas`);

ws.close(); chrome.kill(); try{rmSync(perfil,{recursive:true,force:true});}catch{}

console.log(`
=== ${ok} ok · ${fallos} fallos ===`);
if (fallos) process.exit(1);
