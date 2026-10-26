// Descarga los Precios Marginales Locales (PML) del SW-PML del CENACE y los
// guarda como JSON estático en data/pml/<sistema>/<nodo>.json para que la web
// (GitHub Pages, sin servidor) los lea sin CORS. Lo ejecuta el workflow
// .github/workflows/pml.yml; también se puede correr a mano: node scripts/fetch-pml.mjs
//
// Manual: "Uso de Servicio Web para descarga de PML (SW-PML)", CENACE 2022-06-24.
// - Máx. 20 NodosP y 7 días de operación por consulta.
// - MDA se publica un día antes del día de operación; MTR 7 días después.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Nodos a publicar. Agrupa por sistema (SIN, BCA o BCS).
const NODOS = [
  { sistema: 'SIN', nodo: '06CDU-400' },
];

const BASE = 'https://ws01.cenace.gob.mx:8082/SWPML/SIM';
const DIAS_HISTORIA = 60;        // días que se conservan en cada archivo
const OUT_DIR = path.resolve('data/pml');

// Fecha "hoy" en hora del centro de México (los días de operación del MEM).
function hoyMX() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  return new Date(s + 'T00:00:00Z');
}
const sumarDias = (d, n) => new Date(d.getTime() + n * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);
const partes = (d) => iso(d).split('-').join('/'); // AAAA/MM/DD

// Ventanas de 7 días hacia atrás: MDA hasta mañana, MTR hasta hoy - 7.
// Por omisión una sola ventana; "--historia N" cubre N días (carga inicial).
const argHist = process.argv.indexOf('--historia');
const DIAS_CONSULTA = argHist > 0 ? Math.min(Number(process.argv[argHist + 1]) || 7, DIAS_HISTORIA) : 7;
function ventanas() {
  const hoy = hoyMX();
  const tramos = (fin) => {
    const out = [];
    for (let d = 0; d < DIAS_CONSULTA; d += 7) out.push([sumarDias(fin, -Math.min(d + 6, DIAS_CONSULTA - 1)), sumarDias(fin, -d)]);
    return out;
  };
  return { MDA: tramos(sumarDias(hoy, 1)), MTR: tramos(sumarDias(hoy, -7)) };
}

async function consultar(sistema, proceso, nodos, ini, fin) {
  const url = `${BASE}/${sistema}/${proceso}/${nodos.join(',')}/${partes(ini)}/${partes(fin)}/JSON`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`${proceso} ${sistema}: HTTP ${res.status} (${url})`);
  const body = await res.json();
  if (body.status && body.status !== 'OK') throw new Error(`${proceso} ${sistema}: status ${body.status}`);
  return body.Resultados || [];
}

// El servicio devuelve los números como texto.
const num = (v) => (v === '' || v == null ? null : Number(v));
const fila = (v) => ({
  fecha: v.fecha,
  hora: Number(v.hora),
  pml: num(v.pml),
  pml_ene: num(v.pml_ene),
  pml_per: num(v.pml_per),
  pml_cng: num(v.pml_cng),
});

// Une filas nuevas con las previas (las nuevas ganan) y recorta la historia.
function fusionar(previas = [], nuevas = [], desde) {
  const m = new Map(previas.map((r) => [`${r.fecha}|${r.hora}`, r]));
  for (const r of nuevas) m.set(`${r.fecha}|${r.hora}`, r);
  return [...m.values()]
    .filter((r) => r.fecha >= desde)
    .sort((a, b) => (a.fecha === b.fecha ? a.hora - b.hora : a.fecha < b.fecha ? -1 : 1));
}

async function leerJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function main() {
  const v = ventanas();
  const desde = iso(sumarDias(hoyMX(), -DIAS_HISTORIA));
  const porSistema = Map.groupBy(NODOS, (n) => n.sistema);
  const indice = [];
  let errores = 0;

  for (const [sistema, lista] of porSistema) {
    const claves = lista.map((n) => n.nodo);
    const nuevos = {};
    for (let i = 0; i < claves.length; i += 20) {
      const lote = claves.slice(i, i + 20);
      for (const proceso of ['MDA', 'MTR']) {
        for (const [ini, fin] of v[proceso]) {
          try {
            for (const r of await consultar(sistema, proceso, lote, ini, fin)) {
              (nuevos[r.clv_nodo] ??= { MDA: [], MTR: [] })[proceso].push(...(r.Valores || []).map(fila));
            }
          } catch (e) {
            errores++;
            console.error(e.message);
          }
        }
      }
    }

    await mkdir(path.join(OUT_DIR, sistema), { recursive: true });
    for (const nodo of claves) {
      const file = path.join(OUT_DIR, sistema, `${nodo}.json`);
      const prev = (await leerJSON(file)) || {};
      const n = nuevos[nodo] || { MDA: [], MTR: [] };
      const out = {
        nodo,
        sistema,
        unidades: '$/MWh',
        fuente: 'CENACE SW-PML',
        actualizado: new Date().toISOString(),
        MDA: fusionar(prev.MDA, n.MDA, desde),
        MTR: fusionar(prev.MTR, n.MTR, desde),
      };
      const rango = (rows) => (rows.length ? { desde: rows[0].fecha, hasta: rows.at(-1).fecha } : null);
      indice.push({ sistema, nodo, MDA: rango(out.MDA), MTR: rango(out.MTR) });
      // No reescribir si solo cambió la marca de tiempo (evita commits vacíos).
      if (prev.MDA && JSON.stringify({ ...prev, actualizado: 0 }) === JSON.stringify({ ...out, actualizado: 0 })) {
        console.log(`${sistema}/${nodo}: sin cambios`);
        continue;
      }
      // Una hora por línea: archivo compacto y diffs legibles en git
      const filas = (rows) => '[\n' + rows.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n ]';
      const txt = JSON.stringify({ ...out, MDA: '@MDA', MTR: '@MTR' }, null, 1)
        .replace('"@MDA"', () => filas(out.MDA)).replace('"@MTR"', () => filas(out.MTR));
      await writeFile(file, txt + '\n');
      console.log(`${sistema}/${nodo}: MDA ${out.MDA.length} h, MTR ${out.MTR.length} h`);
    }
  }

  // Índice de nodos disponibles (lo usa la pestaña Market Prices del portal)
  const fileIdx = path.join(OUT_DIR, 'index.json');
  const idx = JSON.stringify({ nodos: indice }, null, 1) + '\n';
  if ((await readFile(fileIdx, 'utf8').catch(() => '')) !== idx) await writeFile(fileIdx, idx);

  if (errores) process.exitCode = 1;
}

main();
