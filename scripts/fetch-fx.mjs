// Descarga el tipo de cambio para solventar obligaciones en dólares (FIX publicado
// en el DOF) de Banxico y lo guarda en data/fx/usd-mxn.json para que la web lo lea
// sin CORS. Lo ejecuta el workflow .github/workflows/pml.yml.
//
// La tabla de Banxico trae por día: Fecha | FIX | Publicación DOF | Para pagos.
// "Para pagos" es el tipo de cambio que se debe usar ESE día para calcular el
// equivalente en pesos de obligaciones en dólares pagaderas en México: el
// publicado en el DOF el día hábil bancario inmediato anterior.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_BANXICO = 'https://www.banxico.org.mx/tipcamb/tipCamMIAction.do?idioma=sp';
const DIAS_HISTORIA = 400;
const FILE = path.resolve('data/fx/usd-mxn.json');

const num = (s) => { const v = Number(String(s).trim()); return /^\d/.test(String(s).trim()) && isFinite(v) ? v : null; };

async function main() {
  const res = await fetch(URL_BANXICO, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Banxico: HTTP ${res.status}`);
  const html = await res.text();

  // Filas: <td>dd/mm/aaaa</td><td>FIX</td><td>DOF</td><td>Para pagos</td> ("N/E" = no existe)
  const re = /<td[^>]*>\s*(\d{2})\/(\d{2})\/(\d{4})\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/g;
  const nuevas = [...html.matchAll(re)].map(([, d, m, a, fix, dof, pagos]) => ({
    fecha: `${a}-${m}-${d}`, fix: num(fix), dof: num(dof), para_pagos: num(pagos),
  }));
  if (!nuevas.length) throw new Error('Banxico: no se encontró la tabla de tipos de cambio (¿cambió la página?)');

  let prev = {};
  try { prev = JSON.parse(await readFile(FILE, 'utf8')); } catch {}
  const m = new Map((prev.serie || []).map((r) => [r.fecha, r]));
  for (const r of nuevas) m.set(r.fecha, r);
  const desde = new Date(Date.now() - DIAS_HISTORIA * 86400000).toISOString().slice(0, 10);
  const serie = [...m.values()].filter((r) => r.fecha >= desde).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  if (JSON.stringify(serie) === JSON.stringify(prev.serie)) { console.log('FX: sin cambios'); return; }
  const out = {
    descripcion: 'Tipo de cambio para solventar obligaciones denominadas en dólares de los EE.UU.A., pagaderas en la República Mexicana',
    fuente: 'Banco de México',
    url: URL_BANXICO,
    actualizado: new Date().toISOString(),
    serie,
  };
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(out, null, 1) + '\n');
  console.log(`FX: ${serie[0].fecha} para pagos ${serie[0].para_pagos} (${serie.length} días)`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
