// Robot del histórico de precios (Market Prices · "Long-term history").
// Carga el histórico horario completo (desde 2016) de los NodosP (SW-PML) y Zonas de
// Carga (SW-PEND) de scripts/historico-lista.json, poco a poco para no saturar al CENACE,
// y cada día agrega los días nuevos. Lo ejecuta .github/workflows/historico.yml cada hora;
// también a mano:
//   node scripts/fetch-historico.mjs [--llamadas 80] [--minutos 25]
//
// Datos (públicos, en GitHub Pages), por entidad y proceso (MDA / MTR):
//   data/historico/<nodo|zona>/<sistema>/<clave>/<proceso>/<AAAA>.json     años cerrados
//   data/historico/<nodo|zona>/<sistema>/<clave>/<proceso>/<AAAA-MM>.json  año en curso, por mes
//     { "anio", "mes"?, "filas": [[MMDD, hora, precio, energía, pérdidas, congestión], …] }
//   data/historico/index.json: avance de cada entidad y la lista de archivos.
// El año en curso va por mes para que la actualización diaria reescriba un archivo chico
// (el historial de git crece poco); al cerrar el año se consolida en <AAAA>.json.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('data/historico');
const LISTA = path.resolve('scripts/historico-lista.json');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) || d : d; };
const MAX_LLAMADAS = arg('--llamadas', 80), MAX_MS = arg('--minutos', 25) * 60000, PARALELO = 3;
const VACIOS_FIN = 8;  // ventanas vacías seguidas hacia atrás = la entidad no existía antes

// Primer día de operación publicado (manuales SW-PML / SW-PEND)
const PRIMERO = { MDA: { SIN: '2016-01-29', BCA: '2016-01-27', BCS: '2016-03-23' }, MTR: { SIN: '2017-01-27', BCA: '2017-01-27', BCS: '2017-01-27' } };
const SERVICIO = {
  nodo: { url: 'https://ws01.cenace.gob.mx:8082/SWPML/SIM', campos: ['pml', 'pml_ene', 'pml_per', 'pml_cng'], clave: 'clv_nodo' },
  zona: { url: 'https://ws01.cenace.gob.mx:8082/SWPEND/SIM', campos: ['pz', 'pz_ene', 'pz_per', 'pz_cng'], clave: 'zona_carga' },
};

const hoyMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const sumar = (f, n) => new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const menor = (a, b) => (a < b ? a : b), mayor = (a, b) => (a > b ? a : b);
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
const slug = (s) => s.replace(/ /g, '-');

/* ── Archivos por año / mes ───────────────────── */
const dirDe = (e, p) => path.join(ROOT, e.tipo, e.sistema, slug(e.clave), p);
const cacheAnios = new Map();  // `${dir}|${año}` → { filas: Map(clave → fila), sucio }
async function leerJSON(f) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } }

async function anio(dir, a) {
  const k = `${dir}|${a}`;
  if (cacheAnios.has(k)) return cacheAnios.get(k);
  const filas = new Map();
  const nombres = await readdir(dir).catch(() => []);
  for (const n of nombres.filter((n) => n === `${a}.json` || n.startsWith(`${a}-`))) {
    for (const f of ((await leerJSON(path.join(dir, n))) || {}).filas || []) filas.set(f[0] * 100 + f[1], f);
  }
  const v = { filas, sucio: false };
  cacheAnios.set(k, v);
  return v;
}

const filasTxt = (o, filas) => JSON.stringify({ ...o, filas: '@F' }).replace('"@F"', () => '[\n' + filas.map((f) => JSON.stringify(f)).join(',\n') + '\n]') + '\n';
async function escribirAnios() {
  const anioActual = Number(hoyMX().slice(0, 4));
  for (const [k, v] of cacheAnios) {
    if (!v.sucio) continue;
    const [dir, aTxt] = k.split('|'), a = Number(aTxt);
    await mkdir(dir, { recursive: true });
    const filas = [...v.filas.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const existentes = (await readdir(dir).catch(() => [])).filter((n) => n === `${a}.json` || n.startsWith(`${a}-`));
    const nuevos = new Map();
    if (a < anioActual) nuevos.set(`${a}.json`, filasTxt({ anio: a }, filas));
    else for (let m = 1; m <= 12; m++) {
      const fm = filas.filter((f) => Math.floor(f[0] / 100) === m);
      if (fm.length) nuevos.set(`${a}-${String(m).padStart(2, '0')}.json`, filasTxt({ anio: a, mes: m }, fm));
    }
    for (const [n, txt] of nuevos) if ((await readFile(path.join(dir, n), 'utf8').catch(() => '')) !== txt) await writeFile(path.join(dir, n), txt);
    for (const n of existentes) if (!nuevos.has(n)) await unlink(path.join(dir, n));  // p. ej. meses ya consolidados en el año
  }
}

/* ── CENACE ─────────────────────────────────────── */
async function consultar(e, p, ini, fin) {
  const s = SERVICIO[e.tipo];
  const url = `${s.url}/${e.sistema}/${p}/${encodeURIComponent(slug(e.clave))}/${ini.replace(/-/g, '/')}/${fin.replace(/-/g, '/')}/JSON`;
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (res.status === 204 || res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const r = (body.Resultados || []).find((x) => String(x[s.clave] || '').toUpperCase() === e.clave.toUpperCase()) || (body.Resultados || [])[0];
      const [cp, ce, cl, cc] = s.campos;
      return ((r && r.Valores) || []).map((v) => ({ fecha: v.fecha, hora: Number(v.hora), p: num(v[cp]), e: num(v[ce]), l: num(v[cl]), c: num(v[cc]) }));
    } catch (err) {
      if (intento >= 2) throw new Error(`${e.tipo} ${e.clave} ${p} ${ini}…${fin}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function guardar(e, p, valores) {
  const dir = dirDe(e, p);
  for (const v of valores) {
    if (v.p == null) continue;
    const a = await anio(dir, Number(v.fecha.slice(0, 4)));
    const md = Number(v.fecha.slice(5, 7)) * 100 + Number(v.fecha.slice(8, 10));
    a.filas.set(md * 100 + v.hora, [md, v.hora, v.p, v.e, v.l, v.c]);
    a.sucio = true;
  }
}

/* ── Plan de trabajo ───────────────────────────── */
// Siguiente ventana de 7 días de una entidad-proceso: primero los días nuevos (adelante),
// después el histórico pendiente (atrás, hasta el primer día publicado).
function siguiente(st, e, p) {
  const ultimo = p === 'MDA' ? sumar(hoyMX(), 1) : sumar(hoyMX(), -7), primero = PRIMERO[p][e.sistema];
  if (st.hasta && st.hasta < ultimo && !st.sinNuevos) {
    const ini = sumar(st.hasta, 1);
    return { dir: 'adelante', ini, fin: menor(sumar(ini, 6), ultimo) };
  }
  if (!st.completo) {
    const fin = st.desde ? sumar(st.desde, -1) : ultimo;
    if (fin < primero) { st.completo = true; return null; }
    return { dir: 'atras', ini: mayor(sumar(fin, -6), primero), fin };
  }
  return null;
}

function aplicar(st, e, p, v, valores) {
  const fechas = valores.filter((x) => x.p != null).map((x) => x.fecha).sort();
  const ultimo = p === 'MDA' ? sumar(hoyMX(), 1) : sumar(hoyMX(), -7);
  if (v.dir === 'adelante') {
    if (fechas.length) st.hasta = mayor(st.hasta, fechas.at(-1));
    else if (v.fin < sumar(ultimo, -2)) st.hasta = v.fin;  // hueco en el CENACE: no atorarse
    else st.sinNuevos = true;                               // aún no publica esos días
    return;
  }
  st.desde = v.ini;
  if (!st.hasta && fechas.length) st.hasta = fechas.at(-1);
  if (fechas.length) st.vacios = 0;
  else if (st.hasta && ++st.vacios >= VACIOS_FIN) st.completo = true;  // la entidad no existía antes
  if (v.ini <= PRIMERO[p][e.sistema]) st.completo = true;
}

async function main() {
  const t0 = Date.now();
  const lista = JSON.parse(await readFile(LISTA, 'utf8'));
  const entidades = [
    ...(lista.nodos || []).map((n) => ({ tipo: 'nodo', sistema: n.sistema, clave: String(n.clave).trim().toUpperCase() })),
    ...(lista.zonas || []).map((z) => ({ tipo: 'zona', sistema: z.sistema, clave: String(z.zona).trim().toUpperCase().replace(/-/g, ' ') })),
  ];
  const prev = (await leerJSON(path.join(ROOT, 'index.json'))) || { entidades: [] };
  const estado = new Map();
  for (const e of entidades) for (const p of ['MDA', 'MTR']) {
    const ant = (prev.entidades.find((x) => x.tipo === e.tipo && x.sistema === e.sistema && x.clave === e.clave) || {})[p] || {};
    estado.set(`${e.tipo}|${e.sistema}|${e.clave}|${p}`, { e, p, st: { desde: ant.desde || null, hasta: ant.hasta || null, completo: !!ant.completo, vacios: ant.vacios || 0 } });
  }

  // Ronda tras ronda, una ventana por entidad-proceso (todas avanzan parejo), en lotes paralelos
  let llamadas = 0, errores = 0;
  const activos = new Set(estado.keys());
  while (activos.size && llamadas < MAX_LLAMADAS && Date.now() - t0 < MAX_MS) {
    const tareas = [];
    for (const k of activos) {
      const { e, p, st } = estado.get(k), v = siguiente(st, e, p);
      if (!v) { activos.delete(k); continue; }
      tareas.push({ k, e, p, st, v });
    }
    for (let i = 0; i < tareas.length && llamadas < MAX_LLAMADAS; i += PARALELO) {
      const lote = tareas.slice(i, i + PARALELO).slice(0, MAX_LLAMADAS - llamadas);
      llamadas += lote.length;
      await Promise.all(lote.map(async (t) => {
        try { const vals = await consultar(t.e, t.p, t.v.ini, t.v.fin); await guardar(t.e, t.p, vals); aplicar(t.st, t.e, t.p, t.v, vals); }
        catch (err) { errores++; console.error(err.message); activos.delete(t.k); }  // se reintenta en la siguiente corrida
      }));
    }
  }
  await escribirAnios();

  // Índice con el avance y los archivos de cada entidad (lo lee el portal)
  const salida = { actualizado: new Date().toISOString(), entidades: [] };
  for (const e of entidades) {
    const o = { tipo: e.tipo, sistema: e.sistema, clave: e.clave };
    for (const p of ['MDA', 'MTR']) {
      const { st } = estado.get(`${e.tipo}|${e.sistema}|${e.clave}|${p}`), dir = dirDe(e, p);
      const archivos = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()
        .map((n) => path.relative(ROOT, path.join(dir, n)).split(path.sep).join('/'));
      const primero = PRIMERO[p][e.sistema], total = (Date.parse(st.hasta || primero) - Date.parse(primero)) / 864e5 + 1;
      const hecho = st.desde && st.hasta ? (Date.parse(st.hasta) - Date.parse(st.desde)) / 864e5 + 1 : 0;
      o[p] = { desde: st.desde, hasta: st.hasta, completo: st.completo, vacios: st.vacios, avance: st.completo ? 100 : Math.min(99, Math.floor(hecho / total * 100)), archivos };
    }
    salida.entidades.push(o);
  }
  const txt = JSON.stringify(salida, null, 1) + '\n';
  const anterior = await readFile(path.join(ROOT, 'index.json'), 'utf8').catch(() => '');
  if (anterior.replace(/"actualizado": "[^"]*"/, '') !== txt.replace(/"actualizado": "[^"]*"/, '')) {
    await mkdir(ROOT, { recursive: true });
    await writeFile(path.join(ROOT, 'index.json'), txt);
  }
  for (const o of salida.entidades) console.log(`${o.tipo} ${o.sistema}/${o.clave}: MDA ${o.MDA.desde}→${o.MDA.hasta} (${o.MDA.avance}%) · MTR ${o.MTR.desde}→${o.MTR.hasta} (${o.MTR.avance}%)`);
  console.log(`${llamadas} llamadas al CENACE en ${Math.round((Date.now() - t0) / 1000)} s${errores ? `, ${errores} con error` : ''}`);
  if (errores && llamadas === errores) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
