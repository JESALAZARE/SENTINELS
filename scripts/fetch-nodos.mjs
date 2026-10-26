// Descarga la versión más reciente del Catálogo de NodosP del CENACE y la guarda
// en data/nodos/catalogo.json para la pestaña Market Prices del portal. Lo
// ejecuta el workflow .github/workflows/pml.yml; también a mano:
//   node scripts/fetch-nodos.mjs [--forzar]
//
// La página https://www.cenace.gob.mx/Paginas/SIM/NodosP.aspx lista los archivos
// .xlsx del año con su "Fecha de actualización"; se toma el de fecha más reciente.
// Si ya tenemos esa versión no se vuelve a descargar (salvo --forzar).
// Campos (nota técnica "MECP Catálogo de NodosP"): sistema, centro de control
// regional, zona de carga, NodoP (clave, nombre, nivel de tensión), tipo de carga y
// de generación (directa / indirectamente modelada), transmisión, distribución,
// ubicación INEGI y región de transmisión PRODESEN.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const PAGINA = 'https://www.cenace.gob.mx/Paginas/SIM/NodosP.aspx';
const FILE = path.resolve('data/nodos/catalogo.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (Sentinels catalogo NodosP)' };

// Columnas del archivo (A..S), a partir de la fila 3
const COLUMNAS = [
  'sistema', 'ccr', 'zona_carga', 'clave', 'nombre', 'kv',
  'carga_directa', 'carga_indirecta', 'gen_directa', 'gen_indirecta',
  'zona_transmision', 'gerencia_transmision', 'zona_distribucion', 'gerencia_distribucion',
  'clave_entidad', 'entidad', 'clave_municipio', 'municipio', 'region_prodesen',
];

/* ── Lectura mínima de .xlsx (ZIP + SpreadsheetML) ── */
function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('xlsx: no es un ZIP válido');
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const texto = (si) => unxml([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function leerHoja(files) {
  const shared = [...String(files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texto(m[1]));
  // Primera hoja del libro (el catálogo; la segunda es "Control de Cambios")
  const wb = String(files['xl/workbook.xml']), rels = String(files['xl/_rels/workbook.xml.rels']);
  const rid = /<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1];
  const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
  const hoja = String(files['xl/' + (target[1] || target[2]).replace(/^\/?xl\//, '')]);
  const filas = [];
  for (const [, r, cuerpo] of hoja.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const fila = [];
    for (const [, attrs, inner] of cuerpo.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)[1], t = (/t="(\w+)"/.exec(attrs) || [])[1];
      const col = [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = inner && (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      fila[col] = t === 's' ? shared[+v] : t === 'inlineStr' ? texto(inner) : v != null ? unxml(v) : '';
    }
    filas[+r - 1] = fila;
  }
  return filas;
}

async function main() {
  const html = await (await fetch(PAGINA, { headers: UA, signal: AbortSignal.timeout(60000) })).text();
  // Cada fila de la tabla: enlace al .xlsx ... fecha de actualización dd/mm/aaaa
  const versiones = [...html.matchAll(/href="([^"]+\.xlsx)"[\s\S]*?(\d{2})\/(\d{2})\/(\d{4})/g)]
    .map(([, href, d, m, a]) => ({ href, fecha: `${a}-${m}-${d}`, version: (/\(v([\d-]+)\)/.exec(href) || [])[1] || `${a}-${m}-${d}` }))
    .sort((x, y) => (x.fecha < y.fecha ? 1 : -1));
  if (!versiones.length) throw new Error('Catálogo: la página no lista archivos .xlsx (¿cambió la página o aún no hay versión este año?)');
  const ultima = versiones[0];

  let prev = null;
  try { prev = JSON.parse(await readFile(FILE, 'utf8')); } catch {}
  if (prev && prev.version === ultima.version && !process.argv.includes('--forzar')) {
    console.log(`Catálogo: sin cambios (v${ultima.version})`);
    return;
  }

  const url = new URL(ultima.href, PAGINA).href;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Catálogo: HTTP ${res.status} al descargar ${url}`);
  const filas = leerHoja(unzip(Buffer.from(await res.arrayBuffer())));

  // Validar que el formato siga siendo el de la nota técnica
  const enc = (filas[1] || []).map((s) => String(s || '').trim().toUpperCase());
  if (enc[3] !== 'CLAVE' || enc[4] !== 'NOMBRE' || enc[0] !== 'SISTEMA' || enc.length < COLUMNAS.length) {
    throw new Error(`Catálogo: encabezados inesperados (${enc.join(' | ')})`);
  }
  const limpio = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s; };
  const nodos = filas.slice(2)
    .filter((f) => f && limpio(f[3]))
    .map((f) => COLUMNAS.map((_, i) => { const s = limpio(f[i]); return i === 5 && /^\d+(\.\d+)?$/.test(s) ? Number(s) : s; }));

  const out = {
    nombre: (/\/([^/]+)\.xlsx$/.exec(decodeURI(ultima.href)) || [])[1] || 'Catálogo de NodosP',
    version: ultima.version,
    fecha_actualizacion: ultima.fecha,
    fuente: PAGINA,
    archivo: url,
    descargado: new Date().toISOString(),
    columnas: COLUMNAS,
    nodos,
  };
  // Un NodoP por línea: archivo compacto y diffs legibles en git
  const txt = JSON.stringify({ ...out, nodos: '@NODOS' }, null, 1)
    .replace('"@NODOS"', () => '[\n' + nodos.map((n) => '  ' + JSON.stringify(n)).join(',\n') + '\n ]');
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, txt + '\n');
  console.log(`Catálogo: v${out.version} (actualizado ${out.fecha_actualizacion}), ${nodos.length} NodosP`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
