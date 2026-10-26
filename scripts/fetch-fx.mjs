// Descarga el tipo de cambio para solventar obligaciones en dólares (FIX publicado
// en el DOF) de Banxico y lo guarda en data/fx/usd-mxn.json para que la web lo lea
// sin CORS. Lo ejecuta el workflow .github/workflows/pml.yml; también a mano:
//   node scripts/fetch-fx.mjs [--historia N]   (N días hacia atrás; por omisión 15)
//
// Banxico da por día: Fecha | FIX (determinación) | Publicación DOF | Para pagos.
// "Para pagos" es el tipo de cambio que se debe usar ESE día para calcular el
// equivalente en pesos de obligaciones en dólares pagaderas en México: el
// publicado en el DOF el día hábil bancario inmediato anterior. El portal
// convierte cada hora de PML con el valor "para pagos" de su día de operación,
// así que la serie debe cubrir toda la historia de PML.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_BANXICO = 'https://www.banxico.org.mx/tipcamb/tipCamMIAction.do?idioma=sp';
const URL_HIST = 'https://www.banxico.org.mx/tipcamb/tipCamIHAction.do';
const DIAS_HISTORIA = 400;
const FILE = path.resolve('data/fx/usd-mxn.json');

const argHist = process.argv.indexOf('--historia');
const DIAS_CONSULTA = argHist > 0 ? Math.min(Number(process.argv[argHist + 1]) || 15, DIAS_HISTORIA) : 15;

const num = (s) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);  // "N/E" = no existe
const ddmmaaaa = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('/');

async function main() {
  const hoy = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date()) + 'T00:00:00Z');
  const ini = new Date(hoy.getTime() - (DIAS_CONSULTA - 1) * 86400000);
  const res = await fetch(URL_HIST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ idioma: 'sp', fechaInicial: ddmmaaaa(ini), fechaFinal: ddmmaaaa(hoy), salida: 'HTML' }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Banxico: HTTP ${res.status}`);
  const html = (await res.text()).replace(/\s+/g, ' ');

  // La consulta histórica trae una tabla por columna, en este orden y con el
  // mismo número de celdas: fechas, FIX, publicación DOF y para pagos.
  const celdas = [...html.matchAll(/<td class="renglon(?:Par|Non)"[^>]*>\s*([^<]*?)\s*<\/td>/g)].map((m) => m[1]);
  const n = celdas.length / 4;
  const fechas = celdas.slice(0, n);
  if (!n || !Number.isInteger(n) || !fechas.every((f) => /^\d{2}\/\d{2}\/\d{4}$/.test(f))) {
    throw new Error('Banxico: no se reconoció la tabla de tipos de cambio (¿cambió la página?)');
  }
  const nuevas = fechas.map((f, i) => ({
    fecha: f.split('/').reverse().join('-'),
    fix: num(celdas[n + i]), dof: num(celdas[2 * n + i]), para_pagos: num(celdas[3 * n + i]),
  }));

  let prev = {};
  try { prev = JSON.parse(await readFile(FILE, 'utf8')); } catch {}
  const m = new Map((prev.serie || []).map((r) => [r.fecha, r]));
  for (const r of nuevas) m.set(r.fecha, r);
  const desde = new Date(hoy.getTime() - DIAS_HISTORIA * 86400000).toISOString().slice(0, 10);
  const serie = [...m.values()].filter((r) => r.fecha >= desde).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  if (JSON.stringify(serie) === JSON.stringify(prev.serie)) { console.log('FX: sin cambios'); return; }
  const out = {
    descripcion: 'Tipo de cambio para solventar obligaciones denominadas en dólares de los EE.UU.A., pagaderas en la República Mexicana',
    fuente: 'Banco de México',
    url: URL_BANXICO,
    actualizado: new Date().toISOString(),
    serie,
  };
  // Un día por línea: archivo compacto y diffs legibles en git
  const txt = JSON.stringify({ ...out, serie: '@SERIE' }, null, 1)
    .replace('"@SERIE"', () => '[\n' + serie.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n ]');
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, txt + '\n');
  console.log(`FX: ${serie[0].fecha} para pagos ${serie[0].para_pagos} (${serie.length} días, ${serie.at(-1).fecha} a ${serie[0].fecha})`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
