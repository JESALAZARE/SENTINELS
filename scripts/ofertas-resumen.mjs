// Resúmenes de la pestaña de ofertas del portal, calculados a partir de los CSV limpios
// que deja scripts/ofertas.mjs en el bucket privado (o en la carpeta local de prueba).
// Lo ejecuta .github/workflows/ofertas.yml después de la descarga; también a mano:
//   node scripts/ofertas-resumen.mjs [--salida dir | --r2] [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD]
//
// Solo procesa días nuevos (cada serie guarda los días que ya incluye) y escribe JSON
// gzip en resumen/ del mismo almacén. Nada va al repositorio ni al log (solo conteos).
//
// 1. Curva de oferta por hora (resumen/curva/<año>/<fecha>_<sistema>.json.gz y la serie anual):
//    orden de mérito, cruce con la demanda y precio marginal estimado contra el componente de
//    energía del PML, en dos versiones:
//    - MDA: ofertas del MDA contra compras + consumo del GI + exportación fija (la exportación
//      con bloques solo si su precio es mayor o igual al de la oferta); importación incluida.
//    - MTR ex post: ofertas del MTR contra la generación real del sistema (demanda real por
//      balance), sin intercambios.
//    - Tomadores de precio (entran primero): no despachables, programa de generación del GI,
//      importación fija, hidro y el mínimo de las térmicas encendidas (OO y las que enciende
//      la lista de prioridad: menor costo promedio a plena carga hasta cubrir la demanda + 5%).
//    - Hidro (solo SIN): la generación hidro real de la hora (reporte de energía generada por
//      tecnología, liquidado); sin ese dato, su capacidad a la mediana de los costos de oportunidad.
//    - Térmicas encendidas: bloques 1..11 a su costo incremental; ND no entra.
//    - Intermitentes: pronóstico × % de cada bloque a su costo. Importación con bloques a su precio.
//    - SIN: el precio es el cruce de la energía más el precio publicado de la reserva rodante de
//      10 minutos (escasez de reserva rodante); cada hora guarda las dos partes en "formacion".
//    resumen/ajuste/<año>.json.gz mide el error contra el PML por sistema, mes y versión.
//    Aproximación: el MDA real también resuelve arranques, rampas, reservas y la red.
// 2. Desvío MDA vs MTR (resumen/desvio/…): intermitentes (pronóstico), no despachables
//    (programa), térmicas e hidro (capacidad máxima disponible y cambios ND ↔ ECO), por empresa.
// 3. Costos térmicos por empresa y planta (resumen/costos/<año>_<sistema>_<mercado>.json.gz):
//    costo unitario de potencia mínima y costo de cada bloque, promedios ponderados por MW.
// 4. Hidro (resumen/hidro/<año>.json.gz): distribución diaria del costo de oportunidad y del
//    precio sombra (los códigos cambian cada día).
// 5. Participación de mercado (resumen/participacion/<año>_<sistema>.json.gz): suministro
//    calificado (C + U) por empresa, mes, zona de carga y hora; generación y reservas asignadas
//    por empresa; HHI / CR3 / CR5. Solo porcentajes.
// 6. Validación horaria de reservas (resumen/reservas/…).
// Los resúmenes del portal no llevan códigos: empresas (catálogo privado catalogos/participantes.xlsx)
// y etiquetas estables de planta y unidad (catalogos/plantas.json).

import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bucketR2, carpetaLocal, celdas, hoyMx, INICIO, ESTADO } from './ofertas.mjs';

const SISTEMAS = ['SIN', 'BCA', 'BCS'];
const TIPOS_OFERTA = ['tomador', 'nodespachable', 'gi', 'importacion', 'intermitente', 'hidro', 'termica_min', 'termica', 'hidro_real'];
const BLQ = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(2, '0'));
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (v === '' || v == null ? 0 : Number(v));

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/* ── Participantes ─────────────────────────────────────────────────────
   Catálogo privado de participantes (catalogos/participantes.xlsx en el almacén, que sube el
   usuario; nunca en el repositorio): hoja CLAVE_PM (SHORT | CLAVE_PM | EMPRESA) y hoja NODOS
   (Codigo | SHORT_CE | SHORT | CLAVE_PM | EMPRESA | NodoP | Nombre_NodoP | Zona de Carga).
   Primera letra de la CLAVE_PM: C suministrador calificado, U usuario calificado, G generador,
   B suministro básico; I = contratos legados (GI). Los resúmenes usan solo nombres de empresa
   y etiquetas de planta: ningún código llega al portal. */
const CATALOGO = 'catalogos/participantes.xlsx', PLANTAS = 'catalogos/plantas.json';
const LEGADO = 'Legacy contracts', OTROS_SUM = 'Otros Suministradores';

function leerXlsx(buf) {
  const files = {};
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('catálogo de participantes: no es un .xlsx');
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0, n = buf.readUInt16LE(e + 10); i < n; i++) {
    const m = buf.readUInt16LE(p + 10), sz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42), nombre = buf.toString('utf8', p + 46, p + 46 + nl), st = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(st, st + sz);
    files[nombre] = (m === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    p += 46 + nl + el + cl;
  }
  const xml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const ss = [...(files['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((x) => xml([...x[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  const rels = Object.fromEntries([...files['xl/_rels/workbook.xml.rels'].matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((x) => [x[1], x[2]]));
  const hojas = {};
  for (const [, nombre, rid] of files['xl/workbook.xml'].matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const doc = files['xl/' + rels[rid].replace(/^\/?xl\//, '')] || '';
    hojas[xml(nombre)] = [...doc.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const fila = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const col = [...c[1]].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        const v = (c[3] || '').match(/<v>([^<]*)<\/v>/)?.[1] ?? (c[3] || '').match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
        fila[col] = /t="s"/.test(c[2]) ? ss[+v] : xml(v);
      }
      return fila.map((x) => (x ?? '').trim());
    });
  }
  return hojas;
}

// Nombre comercial: sin la razón social ("IBERDROLA CLIENTES, S.A. DE C.V." → "Iberdrola Clientes")
const corto = (s) => s.replace(/,?\s*(S\.?\s*A\.?\s*P\.?\s*I\.?|S\.?\s*A\.?|S\.?\s*DE\s*R\.?\s*L\.?|S\.?\s*C\.?|E\.?\s*P\.?\s*S\.?)\s*,?(\s*DE\s*C\.?\s*V\.?)?\.?\s*$/i, '')
  .replace(/,\s*$/, '').toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñ0-9])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(Cfe|Ssb|Gi|Mx|Usa|Fv|Fse|Ric|Epg|Rc|At|E2m|Ii|Iii|Iv|Vi)\b/g, (w) => w.toUpperCase()).replace(/\bDe\b/g, 'de').replace(/\bY\b/g, 'y');

async function cargarParticipantes(a) {
  const b = await a.leer(CATALOGO);
  if (!b) { console.log(`Aviso: falta ${CATALOGO}; los participantes aparecerán sin nombre`); return null; }
  const h = leerXlsx(b);
  const porShort = {}, porClave = {}, zonaDe = {};
  // Una fila puede traer solo la CLAVE_PM (participantes que no tienen ofertas propias)
  for (const [s, clave, empresa] of (h.CLAVE_PM || []).slice(1)) {
    if (!empresa || (!s && !clave)) continue;
    // Suministradores sin nombre identificado (empresa "C") se agrupan como "Otros Suministradores"
    const info = { nombre: empresa === 'C' ? OTROS_SUM : corto(empresa), tipo: (clave || '?')[0].toUpperCase() };
    if (s) porShort[s] = info;
    if (clave && clave.length > 1) porClave[clave] = info;
  }
  for (const f of (h.NODOS || []).slice(1)) if (f[0]) zonaDe[f[0]] = f[7] || f[5];
  const catalogo = Object.fromEntries((h['CATALOGO DE NODOS'] || []).slice(1).filter((f) => f[3]).map((f) => [f[3], f[2]]));
  return { porShort, porClave, zonaDe, catalogo };
}

// Empresa de un código de oferta (Short = 4 primeros caracteres) o de una clave de participante
function empresaDe(P, codigo) {
  if (/^LJXX/.test(codigo)) return { nombre: LEGADO, tipo: 'I' };
  return (P && P.porShort[codigo.slice(0, 4)]) || { nombre: 'Other participants', tipo: '?' };
}
// Claves sin empresa en el catálogo: "Generador" (G) u "Otros Suministradores" (C) hasta tener su nombre
function empresaClave(P, clave) {
  if (/^I/.test(clave)) return { nombre: LEGADO, tipo: 'I' };
  return (P && P.porClave[clave]) || { nombre: { G: 'Generador', C: OTROS_SUM }[clave[0]] || 'Other participants', tipo: clave[0] };
}

// Etiquetas estables de planta y unidad por empresa ("Plant 3", "Plant 3 · Unit 2"), guardadas en el almacén
async function registroPlantas(a) {
  const r = JSON.parse((await a.leer(PLANTAS))?.toString() || '{"plantas":{},"unidades":{},"siguiente":{}}');
  let cambio = false;
  const planta = (P, codigo) => {
    const ce = codigo.slice(0, 6), emp = empresaDe(P, codigo).nombre;
    if (!r.plantas[ce]) { r.siguiente[emp] = (r.siguiente[emp] || 0) + 1; r.plantas[ce] = { empresa: emp, n: r.siguiente[emp] }; cambio = true; }
    return { empresa: emp, planta: `Plant ${r.plantas[ce].n}` };
  };
  const unidad = (P, codigo) => {
    const p = planta(P, codigo), ce = codigo.slice(0, 6);
    if (!r.unidades[codigo]) { const k = 'u:' + ce; r.siguiente[k] = (r.siguiente[k] || 0) + 1; r.unidades[codigo] = r.siguiente[k]; cambio = true; }
    return { ...p, unidad: `${p.planta} · Unit ${r.unidades[codigo]}` };
  };
  return { planta, unidad, guardar: () => (cambio ? a.escribir(PLANTAS, Buffer.from(JSON.stringify(r)), 'application/json') : null) };
}

/* ── Lectura ─────────────────────────────────────────────────────────── */
async function tabla(almacen, clave) {
  const b = await almacen.leer(clave);
  if (!b) return null;
  const lineas = gunzipSync(b).toString('utf8').split('\n').filter(Boolean);
  const enc = celdas(lineas[0]);
  return lineas.slice(1).map((l) => {
    const c = celdas(l), o = {};
    enc.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}
const oferta = (a, mercado, tipo, fecha, sistema) => tabla(a, `ofertas/${mercado}/${tipo}/${fecha.slice(0, 4)}/${fecha}_${sistema}.csv.gz`);

async function leerJson(a, clave, def) {
  const b = await a.leer(clave);
  return b ? JSON.parse(gunzipSync(b).toString('utf8')) : def;
}
const escribirJson = (a, clave, obj) => a.escribir(clave, gzipSync(JSON.stringify(obj)), 'application/gzip');

const porHora = (filas, col, filtro = () => true) => {
  const h = {};
  for (const f of filas || []) if (filtro(f)) h[f.Hora] = (h[f.Hora] || 0) + num(f[col]);
  return h;
};
const mediana = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/* ── 1. Curva de oferta (MDA y MTR ex post) ──────────────────────────── */
const TOMADORES = new Set(['nodespachable', 'gi', 'tomador', 'hidro_real']);

// Bloques de oferta de una hora. hidroReal (MW): si se conoce la generación hidro real,
// entra como cantidad dada (tomador) en lugar de la capacidad de cada unidad al precio hidro.
// encendidas: térmicas que se dan por encendidas (su mínimo entra sin precio); null = todas
// las disponibles compiten, con el mínimo como un bloque más.
function bloquesHora(H, t, { precioHidro, hidroReal, conImportacion, encendidas = null, minimo = 'costo_unitario' }) {
  const blq = [];
  const add = (mw, precio, tipo, codigo, ce) => { if (mw > 0) blq.push({ mw, precio, tipo, codigo, ce }); };
  for (const f of t.nodesp || []) if (f.Hora === H) add(num(f['Potencia media (MW)']), 0, 'nodespachable', f.Codigo, f['Short CE']);
  for (const f of t.giGen || []) if (f.Hora === H) add(num(f['Potencia Media (MW)']), 0, 'gi', f.Codigo, 'LJXX3');
  if (conImportacion) for (const f of t.imp || []) {
    if (f.Hora !== H) continue;
    if (f.Modalidad === 'Fija') add(num(f['Importacion fija (MW)']), 0, 'importacion', f.Codigo);
    else for (const b of ['01', '02', '03']) add(num(f[`Importacion de energia-Bloque ${b} (MW)`]), num(f[`Precio de la energia-Bloque ${b} ($/MWh)`]), 'importacion', f.Codigo);
  }
  for (const f of t.intermit || []) {
    if (f.Hora !== H) continue;
    const pron = num(f['Pronostico en MW']);
    for (const b of ['01', '02', '03']) add(pron * num(f[`(%) Pronostico de Generacion Bloque ${b}`]) / 100, num(f[`Costo de Generacion Bloque ${b} ($/MWh)`]), 'intermitente', f.Codigo, f['Short CE']);
  }
  if (hidroReal != null) add(hidroReal, 0, 'hidro_real', 'hidro');
  else for (const f of t.hidro || []) {
    if (f.Hora !== H || f['Estatus asignacion'] === 'ND') continue;
    add(num(f['Limite de despacho maximo (MW)']), precioHidro ?? 0, 'hidro', f.Codigo, f['Short CE']);
  }
  for (const f of t.termica || []) {
    if (f.Hora !== H || f['Estatus asignacion'] === 'ND' || num(f['Limite de despacho maximo (MW)']) <= 0) continue;
    const min = num(f['Limite de despacho minimo (MW)']), oo = f['Estatus asignacion'] === 'OO';
    if (encendidas && !oo && !encendidas.has(f.Codigo)) continue;
    const fijo = oo || !!encendidas;
    const pMin = minimo === 'bloque1' ? num(f['Costo Incremental de generacion Bloque 01 ($/MWh)']) : num(f['Costo Unitario de Potencia Minima ($/MWh)']);
    add(min, fijo ? 0 : pMin, fijo ? 'tomador' : 'termica_min', f.Codigo, f['Short CE']);
    for (const b of BLQ) add(num(f[`Bloque de Potencia ${b} (MW)`]), num(f[`Costo Incremental de generacion Bloque ${b} ($/MWh)`]), 'termica', f.Codigo, f['Short CE']);
  }
  return blq.sort((x, y) => (TOMADORES.has(y.tipo) - TOMADORES.has(x.tipo)) || x.precio - y.precio);
}

// Parámetros del modelo por sistema, elegidos midiendo el ajuste contra el componente de energía
// del PML (mayo 2026, validado con junio). Al cambiar un valor sube VERSION_CURVA.
// - minimo: 'compromiso' (lista de prioridad; los mínimos de las encendidas entran sin precio),
//   'costo_unitario' (el mínimo como bloque a su costo unitario) o 'bloque1' (a costo del bloque 1).
// - margen: capacidad encendida por encima de lo que hay que cubrir.
// - reserva (requerimientos de servicios conexos "Real"): 'ninguna'; 'rodante' (las encendidas
//   cubren demanda + reserva rodante); 'rodante_retenida' (además se aparta de la energía);
//   'rodante_hidro' (se aparta solo lo que no cubre la holgura hidro); 'rodante_ofertada' (la hidro
//   cubre solo la reserva rodante que ofrece, hasta su holgura).
// - ventana: una unidad encendida para la hora más exigente de ±ventana horas sigue encendida.
// - perdidas: la demanda del MDA suma las pérdidas reales de la hora (balance / retiros − 1).
// Para probar otros valores sin tocar el código: variables de entorno MODO_MINIMO, MARGEN,
// RESERVA_MODO, VENTANA, PERDIDAS (aplican a los tres sistemas) y PRECIO_RESERVA_MDA / _MTR (1 o 0).
// Las reservas solo se aplican al MDA (donde el CENACE las co-optimiza con la energía); la curva
// del MTR ex post ya cruza contra la generación real y apartarlas la desvía (BCA junio: 31% → 12%).
// - precio_reserva: el precio es el cruce de la energía sin apartar reserva más el precio publicado de
//   la reserva rodante de 10 minutos de ese mercado (incluye el de la suplementaria: los precios son
//   acumulativos). El CENACE co-optimiza energía y reservas: cuando la
//   reserva escasea (sobre todo al anochecer, cuando la hidro ya genera y se va la solar) una unidad
//   que deja de dar reserva para generar cobra ese costo, y pasa al componente de energía del PML
//   (SIN mayo–junio 2026, MDA: 65% → 76% de horas dentro de ±10%, H21: 26% → 87%; MTR: error medio
//   92 → 66 MXN/MWh). En BCA y BCS no mejora. Con la rodante de 10 min en vez de la suplementaria
//   (versión 8): MDA may–jun error medio 55.6 → 37.3 MXN/MWh y 28 ago 2026 1,154 → 123; MTR 65.5 → 47.6.
//   El ajuste lineal da coeficiente 1.00 (MDA) y 0.95 (MTR): pasa el precio completo.
const SIN_RESERVA = { minimo: 'compromiso', margen: 0.05, reserva: 'ninguna', ventana: 0 };
const PARAMETROS = {
  SIN: { MDA: { minimo: 'compromiso', margen: 0, reserva: 'rodante_ofertada', ventana: 0, perdidas: true, precio_reserva: true }, MTR: { ...SIN_RESERVA, precio_reserva: true } },
  BCA: { MDA: { minimo: 'compromiso', margen: 0, reserva: 'rodante_hidro', ventana: 0, perdidas: true }, MTR: SIN_RESERVA },
  BCS: { MDA: SIN_RESERVA, MTR: SIN_RESERVA },
};
function parametros(sistema, mercado) {
  const e = process.env, p = PARAMETROS[sistema][mercado];
  return {
    minimo: e.MODO_MINIMO || p.minimo, margen: e.MARGEN != null ? Number(e.MARGEN) : p.margen,
    reserva: e.RESERVA_MODO || p.reserva, ventana: e.VENTANA != null ? Number(e.VENTANA) : p.ventana,
    perdidas: e.PERDIDAS != null ? e.PERDIDAS === '1' : !!p.perdidas,
    precio_reserva: e[`PRECIO_RESERVA_${mercado}`] != null ? e[`PRECIO_RESERVA_${mercado}`] === '1' : !!p.precio_reserva,
  };
}

// Lista de prioridad: enciende las térmicas de menor costo promedio a plena carga hasta que,
// con la oferta no térmica, cubran la demanda (más un margen); sus mínimos entran sin precio.
function encender(termica, H, residual, margen) {
  const disp = (termica || []).filter((f) => f.Hora === H && f['Estatus asignacion'] !== 'ND' && num(f['Limite de despacho maximo (MW)']) > 0);
  let cap = disp.filter((f) => f['Estatus asignacion'] === 'OO').reduce((s, f) => s + num(f['Limite de despacho maximo (MW)']), 0);
  const prom = (f) => {
    const max = num(f['Limite de despacho maximo (MW)']);
    return (num(f['Costo de Operacion a potencia minima ($)']) + BLQ.reduce((s, b) => s + num(f[`Bloque de Potencia ${b} (MW)`]) * num(f[`Costo Incremental de generacion Bloque ${b} ($/MWh)`]), 0)) / max;
  };
  const on = new Set();
  for (const f of disp.filter((x) => x['Estatus asignacion'] !== 'OO').sort((x, y) => prom(x) - prom(y))) {
    if (cap >= residual * (1 + margen)) break;
    on.add(f.Codigo); cap += num(f['Limite de despacho maximo (MW)']);
  }
  return on;
}

// Oferta no térmica de la hora. Para decidir qué se enciende no cuenta la importación
// (sus bloques suelen ser caros, de respaldo).
const noTermica = (H, t, opciones) => bloquesHora(H, { ...t, termica: null }, { ...opciones, conImportacion: false }).reduce((s, b) => s + b.mw, 0);

// Oferta de la hora según el tratamiento del mínimo térmico; residual = MW que deben cubrir las térmicas
function ofertaHora(H, t, opciones, residual, p) {
  if (p.minimo !== 'compromiso') return bloquesHora(H, t, { ...opciones, minimo: p.minimo });
  return bloquesHora(H, t, { ...opciones, encendidas: encender(t.termica, H, residual, p.margen) });
}

// Precio = cruce de la energía + precio de la reserva (pi, si el parámetro precio_reserva lo pide);
// deja las dos partes en formacion para el portal
function formacion(c, pi) {
  const f = { energia: c.precio, reserva: pi == null ? null : r2(pi) };
  if (pi != null && c.precio != null) c.precio = r2(c.precio + pi);
  return f;
}

// Residual de cada hora → el mayor de su ventana de ±v horas
function ventana(residuales, v) {
  return residuales.map((_, i) => Math.max(...residuales.slice(Math.max(0, i - v), i + v + 1).filter((x) => x != null)));
}

// Cruce de la oferta con la demanda; demandaA(p) = demanda a ese precio (no crece con p)
function cruzar(blq, demandaA) {
  let acum = 0, marginal = null, demanda = demandaA(Infinity);
  const mezcla = {};
  for (const b of blq) {
    const d = demandaA(b.precio), antes = acum;
    acum += b.mw;
    if (acum >= d) { marginal = b; demanda = d; mezcla[b.tipo] = (mezcla[b.tipo] || 0) + (d - antes); break; }
    mezcla[b.tipo] = (mezcla[b.tipo] || 0) + b.mw;
  }
  // Curva escalonada compacta: [MW acumulado, precio, tipo]; se unen bloques contiguos iguales
  const curva = [];
  let c = 0;
  for (const b of blq) {
    c += b.mw;
    const ti = TIPOS_OFERTA.indexOf(b.tipo), ult = curva[curva.length - 1];
    if (ult && ult[1] === r2(b.precio) && ult[2] === ti) ult[0] = r1(c); else curva.push([r1(c), r2(b.precio), ti]);
  }
  return {
    precio: marginal ? r2(marginal.precio) : null,
    marginal: marginal ? { tipo: marginal.tipo, empresa: marginal.codigo && marginal.tipo !== 'hidro_real' ? empresaDe(PART, marginal.codigo).nombre : null, en_minimo: marginal.tipo === 'termica_min' } : null,
    demanda,
    oferta_total: r1(blq.reduce((s, b) => s + b.mw, 0)),
    mezcla: Object.fromEntries(Object.entries(mezcla).map(([k, v]) => [k, r1(v)])),
    curva,
  };
}

// Generación real por tecnología del mes (SEN): la liquidación más reciente y su última versión
const cacheGen = new Map();
async function generacionReal(a, estado, fecha) {
  const mes = fecha.slice(0, 7);
  if (!cacheGen.has(mes)) {
    const k = (estado.reportes.generacion_tec || []).filter((x) => x.startsWith(mes + '_L'))
      .sort((x, y) => { const [, lx, vx] = x.match(/_L(\d+)_v(\d+)/), [, ly, vy] = y.match(/_L(\d+)_v(\d+)/); return lx - ly || vx - vy; }).at(-1);
    const filas = k ? await tabla(a, `generacion_tec/${mes.slice(0, 4)}/${k}.csv.gz`) : null;
    const m = new Map();
    for (const f of filas || []) m.set(`${f.Fecha}|${f.Hora}`, Object.fromEntries(Object.entries(f).filter(([c]) => !['Fecha', 'Sistema', 'Hora'].includes(c)).map(([c, v]) => [c, num(v)])));
    cacheGen.set(mes, { liquidacion: k ? k.split('_v')[0].slice(8) : null, horas: m });
  }
  return cacheGen.get(mes);
}

async function curvaDia(a, fecha, sistema, estado) {
  const anio = fecha.slice(0, 4), parMda = parametros(sistema, 'MDA'), parMtr = parametros(sistema, 'MTR');
  const leer = async (mercado) => {
    const [termica, hidro, intermit, nodesp, giGen] = await Promise.all(['termica', 'hidro', 'intermitente', 'nodespachable', 'gi_generacion'].map((t) => oferta(a, mercado, t, fecha, sistema)));
    return { termica, hidro, intermit, nodesp, giGen };
  };
  const mda = { ...(await leer('MDA')), imp: await oferta(a, 'MDA', 'importacion', fecha, sistema) }, mtr = await leer('MTR');
  const [giCons, compra, exp, sombra] = await Promise.all([
    oferta(a, 'MDA', 'gi_consumo', fecha, sistema), oferta(a, 'MDA', 'compra', fecha, sistema),
    oferta(a, 'MDA', 'exportacion', fecha, sistema), oferta(a, 'MDA', 'precios_sombra', fecha, 'SIN')]);
  const pml = async (proc) => tabla(a, `pml_energia/${proc}/${anio}/${fecha}_${sistema}.csv.gz`);
  const [pmlMda, pmlMtr] = await Promise.all([pml('MDA'), pml('MTR')]);
  const [scMda, scMtr] = await Promise.all([oferta(a, 'MDA', 'servicios_conexos', fecha, sistema), oferta(a, 'MTR', 'servicios_conexos', fecha, sistema)]);
  // Reserva rodante (regulación + rodante 10 "Real") que debe estar en unidades encendidas
  const rodante = (sc) => Object.fromEntries((sc || []).map((f) => [f.Hora, num(f['RT Reserva Regulacion (MW)']) + num(f['Reserva Rodante 10 Real'])]));
  const rodMda = rodante(scMda), rodMtr = rodante(scMtr);
  // Precio publicado de la reserva rodante de 10 minutos por hora (parámetro precio_reserva)
  const precioRod = async (mercado) => Object.fromEntries(((await oferta(a, mercado, 'precios_reservas', fecha, sistema)) || [])
    .filter((f) => f['Tipo de reserva'] === 'Reserva rodante de 10 minutos').map((f) => [f.Hora, num(f['Precio de la reserva ($/MW por hora)'])]));
  const [piMda, piMtr] = await Promise.all([precioRod('MDA'), precioRod('MTR')]);

  // Demanda real: la liquidación más reciente del día (balance trae también la generación del sistema)
  const ultimaLiq = (metodo) => (estado.reportes[`demanda_real|${metodo}`] || []).filter((k) => k.startsWith(fecha + '_L')).sort((x, y) => Number(x.split('_L')[1]) - Number(y.split('_L')[1])).at(-1);
  const real = {};
  for (const metodo of ['balance', 'retiros']) {
    const k = ultimaLiq(metodo);
    const filas = k ? await tabla(a, `demanda_real/${metodo}/${anio}/${k}.csv.gz`) : null;
    const del = (f) => f.Sistema === sistema;
    real[metodo] = {
      liquidacion: k ? Number(k.split('_L')[1]) : null,
      demanda: porHora(filas, metodo === 'balance' ? 'Estimacion de Demanda por Balance (MWh)' : 'Estimacion de Demanda por Retiros (MWh)', del),
      ...(metodo === 'balance' ? { generacion: porHora(filas, 'Generacion (MWh)', del) } : {}),
    };
  }
  const gen = await generacionReal(a, estado, fecha);

  const medianaCO = sombra ? mediana(sombra.map((f) => num(f.COSTO_OPORTUNIDAD))) : null;
  const horas = [...new Set([...(mda.termica || []), ...(compra || [])].map((f) => f.Hora))].map(Number).sort((x, y) => x - y);
  const compras = porHora(compra, 'Demanda fija (MW)'), gi = porHora(giCons, 'Potencia Media (MW)');
  const pmlH = (t) => Object.fromEntries((t || []).map((f) => [f.Hora, f]));
  const pMda = pmlH(pmlMda), pMtr = pmlH(pmlMtr);

  // Primera pasada: demanda de cada hora y lo que deben cubrir las térmicas
  const ctx = horas.map((h) => {
    const H = String(h);
    const g = gen.horas.get(`${fecha}|${h}`) || null;
    // La hidro solo existe en el SIN: ahí la hidro del SEN es la del SIN
    const hidroReal = sistema === 'SIN' && g ? g.Hidroelectrica : sistema === 'SIN' ? null : 0;
    // MDA: demanda inelástica + exportación con bloques (cuánto se exporta depende del precio)
    let expFija = 0;
    const expBlq = [];
    for (const f of exp || []) {
      if (f.Hora !== H) continue;
      if (f.Modalidad === 'Fija') expFija += num(f['Exportacion fija (MW)']);
      else for (const b of ['01', '02', '03']) { const mw = num(f[`Exportacion de energia-Bloque ${b} (MW)`]); if (mw > 0) expBlq.push({ mw, precio: num(f[`Precio de la energia-Bloque ${b} ($/MWh)`]) }); }
    }
    const d0 = (compras[H] || 0) + (gi[H] || 0) + expFija;
    const demandaA = (p) => d0 + expBlq.reduce((s, e) => s + (e.precio >= p ? e.mw : 0), 0);
    // MTR ex post: la generación nacional real del sistema (balance), sin intercambios
    // (la generación ya descuenta importación y exportación)
    const genSis = real.balance.generacion[H];
    const opMda = { precioHidro: medianaCO, hidroReal, conImportacion: true }, opMtr = { precioHidro: medianaCO, hidroReal, conImportacion: false };
    // Reservas: la rodante se cubre con unidades encendidas (entra en lo que hay que encender) y,
    // según el modo, una parte se aparta de la energía. La holgura hidro (capacidad disponible
    // menos lo que generó) puede cubrir reserva sin quitarle energía a las térmicas.
    const hidroH = (t) => (t.hidro || []).filter((f) => f.Hora === H && f['Estatus asignacion'] !== 'ND');
    const holgura = (t) => (hidroReal == null ? 0 : Math.max(0, hidroH(t).reduce((s, f) => s + num(f['Limite de despacho maximo (MW)']), 0) - hidroReal));
    // Reserva rodante que la hidro ofrece (rodante 10 min + regulación), sin pasar de su holgura
    const hidroOfrece = (t) => Math.min(holgura(t), hidroH(t).reduce((s, f) => s + num(f['Reserva rodante 10 min (MW)']) + num(f['Reserva regulacion secundaria (MW)']), 0));
    const reserva = (rod, t, p) => {
      const r = rod[H] || 0;
      if (p.reserva === 'ninguna') return { encender: 0, apartar: 0, rodante: r };
      const cubre = { rodante_retenida: 0, rodante_hidro: holgura(t), rodante_ofertada: hidroOfrece(t) }[p.reserva] ?? r;
      return { encender: r, rodante: r, apartar: Math.max(0, r - cubre) };
    };
    const resvMda = reserva(rodMda, mda, parMda), resvMtr = reserva(rodMtr, mtr, parMtr);
    // Pérdidas: las compras del MDA no las incluyen; se suman como la proporción real de la hora
    // (demanda real por balance / por retiros − 1), acotada entre 0 y 8%
    const bal0 = real.balance.demanda[H], ret0 = real.retiros.demanda[H];
    const perdidas = parMda.perdidas && bal0 && ret0 ? ((compras[H] || 0) + (gi[H] || 0)) * Math.min(0.08, Math.max(0, bal0 / ret0 - 1)) : 0;
    return {
      h, H, g, hidroReal, expFija, d0, demandaA, genSis, opMda, opMtr, resvMda, resvMtr, perdidas,
      resMda: demandaA(0) + perdidas + resvMda.encender - noTermica(H, mda, opMda),
      resMed: demandaA(0) + perdidas + resvMda.encender - noTermica(H, mda, { precioHidro: medianaCO, conImportacion: true }),
      resMtr: genSis == null ? null : genSis + resvMtr.encender - noTermica(H, mtr, opMtr),
    };
  });
  const vMda = ventana(ctx.map((c) => c.resMda), parMda.ventana), vMed = ventana(ctx.map((c) => c.resMed), parMda.ventana), vMtr = ventana(ctx.map((c) => c.resMtr), parMtr.ventana);

  const out = [];
  for (const [i, { h, H, g, hidroReal, expFija, d0, demandaA, genSis, opMda, opMtr, resvMda, resvMtr, perdidas }] of ctx.entries()) {
    // La reserva apartada y las pérdidas se suman a la demanda que cruza con la energía
    const conReserva = (precio) => demandaA(precio) + perdidas + resvMda.apartar;
    // Con precio_reserva la reserva no se aparta de la energía: su costo llega con el precio de la reserva
    const cMda = cruzar(ofertaHora(H, mda, opMda, vMda[i], parMda), parMda.precio_reserva ? (p) => demandaA(p) + perdidas : conReserva);
    const fMda = formacion(cMda, parMda.precio_reserva ? piMda[H] : null);
    // Versión anterior (hidro con la mediana del costo de oportunidad), solo para comparar
    const cMed = sistema === 'SIN' ? cruzar(ofertaHora(H, mda, { precioHidro: medianaCO, conImportacion: true }, vMed[i], parMda), conReserva) : cMda;
    const cMtr = genSis == null ? null : cruzar(ofertaHora(H, mtr, opMtr, vMtr[i], parMtr), () => genSis + (parMtr.precio_reserva ? 0 : resvMtr.apartar));
    const fMtr = cMtr && formacion(cMtr, parMtr.precio_reserva ? piMtr[H] : null);

    const bal = real.balance.demanda[H], ret = real.retiros.demanda[H];
    const apartada = parMda.precio_reserva ? 0 : resvMda.apartar;
    const { demanda: dCruce, ...mdaResto } = cMda, demanda = dCruce - apartada - perdidas;
    out.push({
      hora: h,
      demanda: { compras: r1(compras[H] || 0), gi: r1(gi[H] || 0), exportacion_fija: r1(expFija), exportacion_bloques: r1(demanda - d0), total: r1(demanda) },
      real: {
        balance: bal == null ? null : r1(bal), retiros: ret == null ? null : r1(ret), perdidas: bal == null || ret == null ? null : r1(bal - ret),
        generacion: genSis == null ? null : r1(genSis), hidro: hidroReal == null ? null : r1(hidroReal),
        tecnologias_sen: g ? Object.fromEntries(Object.entries(g).map(([k, v]) => [k, r1(v)])) : null,
      },
      pml: { energia_mda: pMda[H] ? num(pMda[H].Energia) : null, energia_mtr: pMtr[H] ? num(pMtr[H].Energia) : null, pml_mda: pMda[H] ? num(pMda[H].PML) : null },
      ...mdaResto,
      formacion: fMda,
      precio_hidro_mediana: cMed.precio,
      reserva: { rodante_mda: r1(resvMda.rodante), apartada_mda: r1(apartada), rodante_mtr: r1(resvMtr.rodante), apartada_mtr: r1(parMtr.precio_reserva ? 0 : resvMtr.apartar) },
      mtr: cMtr && { ...(({ demanda: _d, ...r }) => r)(cMtr), formacion: fMtr },
    });
  }
  return {
    fecha, sistema, tipos: TIPOS_OFERTA, hidro_mediana_co: medianaCO,
    hidro_rango_co: sombra ? [Math.min(...sombra.map((f) => num(f.COSTO_OPORTUNIDAD))), Math.max(...sombra.map((f) => num(f.COSTO_OPORTUNIDAD)))] : null,
    hidro_modo: sistema !== 'SIN' ? 'sin_hidro' : gen.horas.size ? 'generacion_real' : 'mediana_costo_oportunidad',
    parametros: { MDA: parMda, MTR: parMtr },
    liquidaciones: { balance: real.balance.liquidacion, retiros: real.retiros.liquidacion, generacion_tec: gen.liquidacion },
    horas: out,
  };
}

/* ── 2. Desvío MDA vs MTR ─────────────────────────────────────────────── */
const DESVIO = {
  intermitente: { col: 'Pronostico en MW' },
  nodespachable: { col: 'Potencia media (MW)' },
  termica: { col: 'Limite de despacho maximo (MW)', estatus: true },
  hidro: { col: 'Limite de despacho maximo (MW)', estatus: true },
};
async function desvioDia(a, fecha, sistema) {
  const res = { fecha, sistema, tipos: {} };
  for (const [tipo, cfg] of Object.entries(DESVIO)) {
    if (tipo === 'hidro' && sistema !== 'SIN') continue;
    const [mda, mtr] = await Promise.all([oferta(a, 'MDA', tipo, fecha, sistema), oferta(a, 'MTR', tipo, fecha, sistema)]);
    if (!mda || !mtr) continue;
    const ce = {}, cambios = { nd_a_eco: 0, eco_a_nd: 0 };
    const sumar = (filas, lado) => {
      for (const f of filas) {
        if (cfg.estatus && f['Estatus asignacion'] === 'ND') continue;
        const k = empresaDe(PART, f.Codigo).nombre, e = (ce[k] ??= { mda: Array(24).fill(0), mtr: Array(24).fill(0) });
        const i = Math.min(Number(f.Hora), 24) - 1;
        e[lado][i] = r1(e[lado][i] + num(f[cfg.col]));
      }
    };
    sumar(mda, 'mda'); sumar(mtr, 'mtr');
    if (cfg.estatus) {
      const est = new Map(mda.map((f) => [`${f.Codigo}|${f.Hora}`, f['Estatus asignacion']]));
      for (const f of mtr) {
        const antes = est.get(`${f.Codigo}|${f.Hora}`), ahora = f['Estatus asignacion'];
        if (antes === 'ND' && ahora !== 'ND') cambios.nd_a_eco++;
        if (antes && antes !== 'ND' && ahora === 'ND') cambios.eco_a_nd++;
      }
    }
    const tot = (lado) => r1(Object.values(ce).reduce((s, e) => s + e[lado].reduce((x, y) => x + y, 0), 0));
    res.tipos[tipo] = { mwh_mda: tot('mda'), mwh_mtr: tot('mtr'), ...(cfg.estatus ? { cambios_estatus: cambios } : {}), empresas: ce };
  }
  return res;
}

/* ── 3. Costos térmicos por empresa y planta ──────────────────────────── */
async function costosDia(a, fecha, sistema, mercado) {
  const filas = await oferta(a, mercado, 'termica', fecha, sistema);
  if (!filas) return null;
  const ce = {};
  for (const f of filas) {
    if (f['Estatus asignacion'] === 'ND' || num(f['Limite de despacho maximo (MW)']) <= 0) continue;
    const p = REG.planta(PART, f.Codigo), k = `${p.empresa} · ${p.planta}`;
    const e = (ce[k] ??= { empresa: p.empresa, planta: p.planta, u: [0, 0, Infinity, -Infinity], b: BLQ.map(() => [0, 0]) });
    const min = num(f['Limite de despacho minimo (MW)']), cu = num(f['Costo Unitario de Potencia Minima ($/MWh)']);
    if (min > 0) { e.u[0] += cu * min; e.u[1] += min; e.u[2] = Math.min(e.u[2], cu); e.u[3] = Math.max(e.u[3], cu); }
    BLQ.forEach((b, i) => {
      const mw = num(f[`Bloque de Potencia ${b} (MW)`]);
      if (mw > 0) { e.b[i][0] += mw * num(f[`Costo Incremental de generacion Bloque ${b} ($/MWh)`]); e.b[i][1] += mw; }
    });
  }
  // Por día: [costo unitario prom, mín, máx] y el promedio ponderado de cada bloque (null si no hubo MW)
  return Object.fromEntries(Object.entries(ce).map(([k, e]) => [k, {
    empresa: e.empresa, planta: e.planta,
    u: e.u[1] ? [r2(e.u[0] / e.u[1]), r2(e.u[2]), r2(e.u[3])] : null,
    b: e.b.map(([s, mw]) => (mw ? r2(s / mw) : null)),
  }]));
}

/* ── 6. Validación horaria de reservas ───────────────────────────────────
   Por hora: cambios MDA → MTR en las ofertas térmicas e hidro (límite máximo, estatus, holgura
   máx − mín y reserva ofrecida por tipo) contra los requerimientos "Real" del MDA y del MTR y la
   asignación "Real" del MDA. Sirve para ver si salidas o reducciones de unidades coinciden con
   cambios en lo requerido o en lo asignado (p. ej. traslados de suplementaria a 10 minutos). */
const RESERVAS_OFERTA = { rod10: 'rodante 10 min', nr10: 'no rodante 10 min', rsup: 'rodante suplementaria', nrsup: 'no rodante suplementaria', reg: 'regulacion secundaria' };
const RES_REAL = { reg: null, rod10: 'Reserva Rodante 10 Real', nr10: 'Reserva No Rodante 10 Real', sup: 'Reserva Sup Real', total: 'Reserva Total Real' };
const realDe = (f, regCol) => f && Object.fromEntries(Object.entries(RES_REAL).map(([k, c]) => [k, r1(num(f[c ?? regCol]))]));

async function reservasDia(a, fecha, sistema) {
  const tipos = sistema === 'SIN' ? ['termica', 'hidro'] : ['termica'];
  const of = {};
  for (const t of tipos) of[t] = await Promise.all(['MDA', 'MTR'].map((m) => oferta(a, m, t, fecha, sistema)));
  const [reqMda, reqMtr, asig] = await Promise.all([oferta(a, 'MDA', 'servicios_conexos', fecha, sistema), oferta(a, 'MTR', 'servicios_conexos', fecha, sistema), oferta(a, 'MDA', 'servicios_conexos_asignados', fecha, sistema)]);
  const MAX = 'Limite de despacho maximo (MW)', MIN = 'Limite de despacho minimo (MW)', EST = 'Estatus asignacion';
  const porHoraDe = (filas) => Map.groupBy(filas || [], (f) => f.Hora);
  const unidades = {}, horas = [];
  const hs = [...new Set(of.termica[0]?.map((f) => f.Hora) || [])].sort((x, y) => x - y);
  for (const H of hs) {
    const fila = { hora: Number(H) };
    for (const t of tipos) {
      const [mda, mtr] = of[t].map(porHoraDe), A = new Map((mda.get(H) || []).map((f) => [f.Codigo, f]));
      const r = { unidades_bajan: 0, mw_bajan: 0, unidades_suben: 0, mw_suben: 0, nd_a_eco: 0, eco_a_nd: 0, holgura_mda: 0, holgura_mtr: 0, ofrecida: {} };
      const holg = (f) => (f[EST] === 'ND' ? 0 : Math.max(0, num(f[MAX]) - num(f[MIN])));
      for (const f of mda.get(H) || []) r.holgura_mda += holg(f);
      for (const [k, n] of Object.entries(RESERVAS_OFERTA)) r.ofrecida[k] = [r1((mda.get(H) || []).reduce((s, f) => s + num(f[`Reserva ${n} (MW)`]), 0)), r1((mtr.get(H) || []).reduce((s, f) => s + num(f[`Reserva ${n} (MW)`]), 0))];
      for (const y of mtr.get(H) || []) {
        r.holgura_mtr += holg(y);
        const x = A.get(y.Codigo);
        if (!x) continue;
        const d = num(y[MAX]) - num(x[MAX]);
        if (d < 0) { r.unidades_bajan++; r.mw_bajan += d; } else if (d > 0) { r.unidades_suben++; r.mw_suben += d; }
        if (x[EST] === 'ND' && y[EST] !== 'ND') r.nd_a_eco++;
        if (x[EST] !== 'ND' && y[EST] === 'ND') r.eco_a_nd++;
        const cambiaReserva = Object.values(RESERVAS_OFERTA).some((n) => num(x[`Reserva ${n} (MW)`]) !== num(y[`Reserva ${n} (MW)`]));
        if (d !== 0 || x[EST] !== y[EST] || cambiaReserva) {
          // Detalle por unidad: [MDA, MTR] de límite máx / mín, estatus y reserva ofrecida por tipo
          const id = REG.unidad(PART, y.Codigo), k = `${id.empresa} · ${id.unidad}`;
          const u = (unidades[k] ??= { tipo: t, empresa: id.empresa, unidad: id.unidad, horas: {} });
          u.horas[H] = {
            max: [num(x[MAX]), num(y[MAX])], min: [num(x[MIN]), num(y[MIN])], estatus: [x[EST], y[EST]],
            reserva: Object.fromEntries(Object.entries(RESERVAS_OFERTA).map(([k, n]) => [k, [num(x[`Reserva ${n} (MW)`]), num(y[`Reserva ${n} (MW)`])]])),
          };
        }
      }
      for (const k of ['mw_bajan', 'mw_suben', 'holgura_mda', 'holgura_mtr']) r[k] = r1(r[k]);
      fila[t] = r;
    }
    const q = (filas) => (filas || []).find((f) => f.Hora === H);
    const rM = realDe(q(reqMda), 'RT Reserva Regulacion (MW)'), rT = realDe(q(reqMtr), 'RT Reserva Regulacion (MW)'), as = realDe(q(asig), 'Reserva de Regulacion Secundaria (MW)');
    const resta = (x, y) => x && y && Object.fromEntries(Object.keys(x).map((k) => [k, r1(x[k] - y[k])]));
    // Asignado − requerido > 0 en no rodante 10 y < 0 en suplementaria = traslado de suplementaria a 10 minutos
    Object.assign(fila, { requerido_mda: rM, requerido_mtr: rT, asignado_mda: as, asignado_menos_requerido: resta(as, rM), requerido_mtr_menos_mda: resta(rT, rM) });
    horas.push(fila);
  }
  return { fecha, sistema, horas, unidades };
}

/* ── 7. Reserva operativa del SIN (horas críticas) ───────────────────────
   Por hora, con las ofertas del MTR y la operación real: capacidad disponible = límite máximo de
   térmicas e hidro no indisponibles (ND) + pronóstico de intermitentes + no despachables + generación
   GI; reserva operativa (RO) = capacidad disponible − generación real del SIN; RO % sobre la demanda
   real por balance. Estado operativo según el Código de Red (SIN: Normal ≥ 6 %, Alerta 3–6 %,
   Emergencia < 3 %). La parte rodante (RR ≥ 50 % de la RO) se aproxima con la reserva rodante que
   ofrecen las unidades (10 min + suplementaria) frente a la no rodante. El portal ordena las horas y
   toma las 100 de menor RO dentro de la ventana de cálculo del Manual del Balance de Potencia. */
// Ventana de cálculo de las horas críticas de un año (Manual del Balance de Potencia, 3.2.2): primer día =
// día de la primera hora crítica del año anterior − 14 días; último día = día de la última + 14 días,
// llevados al año de producción y acotados al 1 de enero y al 31 de diciembre. Base: horas críticas
// publicadas del año anterior.
// Calibración contra las 100 horas críticas oficiales de 2025 (abr–jun 2025, MTR): la RO con toda la oferta
// no despachable sale ~2,000 MW arriba del valor oficial; contando esa oferta al 43 % el error medio baja a
// ~370 MW (validación cruzada abr–may → jun: 275 MW), 90 de las 100 horas coinciden y la ventana estimada
// (1 abr – 18 jun) queda a un día de la oficial. Al cambiar la fórmula, subir VERSION_RO para recalcular.
const FACTOR_NODESPACHABLE = 0.43, VERSION_RO = 2;
const HORAS_CRITICAS_PUBLICADAS = { 2025: { primera: '2025-04-02', ultima: '2025-06-19' } };
function ventanaCriticas(anio) {
  const base = HORAS_CRITICAS_PUBLICADAS[anio - 1];
  if (!base) return null;
  const mover = (d, dias) => { const x = new Date(`${anio}${d.slice(4)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + dias); return x.toISOString().slice(0, 10); };
  const desde = mover(base.primera, -14), hasta = mover(base.ultima, 14);
  return { desde: desde < `${anio}-01-01` ? `${anio}-01-01` : desde, hasta: hasta > `${anio}-12-31` ? `${anio}-12-31` : hasta, base: { anio: anio - 1, ...base }, dias_margen: 14 };
}

async function reservaOperativaDia(a, fecha, estado) {
  const sistema = 'SIN', anio = fecha.slice(0, 4);
  const [termica, hidro, intermit, nodesp, giGen] = await Promise.all(['termica', 'hidro', 'intermitente', 'nodespachable', 'gi_generacion'].map((t) => oferta(a, 'MTR', t, fecha, sistema)));
  const ultimaLiq = (metodo) => (estado.reportes[`demanda_real|${metodo}`] || []).filter((k) => k.startsWith(fecha + '_L')).sort((x, y) => Number(x.split('_L')[1]) - Number(y.split('_L')[1])).at(-1);
  const kBal = ultimaLiq('balance'), bal = kBal ? await tabla(a, `demanda_real/balance/${anio}/${kBal}.csv.gz`) : null;
  const genH = porHora(bal, 'Generacion (MWh)', (f) => f.Sistema === sistema), demH = porHora(bal, 'Estimacion de Demanda por Balance (MWh)', (f) => f.Sistema === sistema);
  const disp = (f) => f['Estatus asignacion'] !== 'ND';
  const suma = (filas, H, valor, filtro = () => true) => (filas || []).reduce((s, f) => s + (f.Hora === H && filtro(f) ? valor(f) : 0), 0);
  const rod = ['Reserva rodante 10 min (MW)', 'Reserva rodante suplementaria (MW)'], noRod = ['Reserva no rodante 10 min (MW)', 'Reserva no rodante suplementaria (MW)'];
  const horas = [...new Set((termica || []).map((f) => f.Hora))].map(Number).sort((x, y) => x - y);
  return horas.map((h) => {
    const H = String(h), gen = genH[H], dem = demH[H];
    const capTer = suma(termica, H, (f) => num(f['Limite de despacho maximo (MW)']), disp), capHid = suma(hidro, H, (f) => num(f['Limite de despacho maximo (MW)']), disp);
    const capInt = suma(intermit, H, (f) => num(f['Pronostico en MW'])), capND = suma(nodesp, H, (f) => num(f['Potencia media (MW)'])), capGI = suma(giGen, H, (f) => num(f['Potencia Media (MW)']));
    const cap = capTer + capHid + capInt + FACTOR_NODESPACHABLE * capND + capGI;
    const rr = [termica, hidro].reduce((s, t) => s + suma(t, H, (f) => rod.reduce((x, c) => x + num(f[c]), 0), disp), 0);
    const rnr = [termica, hidro].reduce((s, t) => s + suma(t, H, (f) => noRod.reduce((x, c) => x + num(f[c]), 0), disp), 0);
    const ro = gen == null ? null : cap - gen;
    return [h, r1(cap), gen == null ? null : r1(gen), dem == null ? null : r1(dem), ro == null ? null : r1(ro), ro == null || !dem ? null : r2((100 * ro) / dem),
      r1(capTer), r1(capHid), r1(capInt), r1(FACTOR_NODESPACHABLE * capND + capGI), r1(rr), r1(rnr)];
  });
}

/* ── 5. Participación de mercado ──────────────────────────────────────────
   Suministro: solo suministradores calificados (C) y usuarios calificados (U); sin suministro
   básico ni generadores. Se mide con la energía de sus compras del MDA, por mes, zona de carga y
   hora del día. Generación y reservas: energía y reservas asignadas en el MDA por empresa
   (generadores y contratos legados). El portal recibe solo porcentajes; los MWh se acumulan en
   resumen/_acum/ (fuera de las rutas del Worker). */
async function acumularParticipacion(a, ac, fecha, sistema) {
  const mes = fecha.slice(0, 7);
  for (const f of (await oferta(a, 'MDA', 'compra', fecha, sistema)) || []) {
    const emp = empresaDe(PART, f.Codigo);
    if (emp.tipo !== 'C' && emp.tipo !== 'U') continue;
    const mw = num(f['Demanda fija (MW)']), nodo = f['NodoP/Zona de Carga'];
    const zona = (PART && (PART.zonaDe[f.Codigo] || PART.catalogo[nodo])) || nodo, i = Math.min(Number(f.Hora), 24) - 1;
    ac.tipos[emp.nombre] = emp.tipo;
    const m = (ac.sum[mes] ??= {}); m[emp.nombre] = (m[emp.nombre] || 0) + mw;
    (ac.hora[emp.nombre] ??= Array(24).fill(0))[i] += mw;
    const z = ((ac.zonas[zona] ??= {})[mes] ??= {}); z[emp.nombre] = (z[emp.nombre] || 0) + mw;
  }
  for (const f of (await oferta(a, 'MDA', 'asignacion_participantes', fecha, sistema)) || []) {
    const emp = empresaClave(PART, f['Zona de Reserva'] ?? f.Participante ?? f.Codigo);
    if (emp.tipo !== 'G' && emp.tipo !== 'I') continue;
    const e = num(f['Cantidad total de energia asignada (MWh)']);
    const r = ['Reserva de Regulacion (MW)', 'Reserva Rodante de 10 minutos (MW)', 'Reserva No Rodante de 10 minutos (MW)', 'Reserva Rodante Suplementaria (MW)', 'Reserva No Rodante Suplementaria (MW)'].reduce((s, c) => s + num(f[c]), 0);
    const g = (ac.gen[mes] ??= {}); g[emp.nombre] = (g[emp.nombre] || 0) + e;
    const rr = (ac.res[mes] ??= {}); rr[emp.nombre] = (rr[emp.nombre] || 0) + r;
  }
  ac.dias.push(fecha);
}

// Porcentajes por empresa de un conjunto de MWh por mes, con concentración (HHI, CR3, CR5) y activos
function participacion(porMes) {
  const meses = Object.keys(porMes).sort(), ytd = {};
  for (const m of meses) for (const [e, v] of Object.entries(porMes[m])) ytd[e] = (ytd[e] || 0) + v;
  const pct = (o) => { const t = Object.values(o).reduce((s, v) => s + Math.max(0, v), 0); return Object.fromEntries(Object.entries(o).map(([e, v]) => [e, t ? (100 * Math.max(0, v)) / t : 0])); };
  const conc = (p) => { const s = Object.values(p).sort((x, y) => y - x); return { hhi: Math.round(s.reduce((a, v) => a + v * v, 0)), cr3: r1(s.slice(0, 3).reduce((a, v) => a + v, 0)), cr5: r1(s.slice(0, 5).reduce((a, v) => a + v, 0)), activos: s.filter((v) => v > 0).length }; };
  const porM = Object.fromEntries(meses.map((m) => [m, pct(porMes[m])])), anual = pct(ytd);
  // Solo empresas con participación en el periodo (sin volumen no hay participación que mostrar)
  const empresas = Object.keys(anual).filter((e) => anual[e] > 0).sort((x, y) => anual[y] - anual[x])
    .map((e) => ({ nombre: e, ytd: r2(anual[e]), meses: Object.fromEntries(meses.map((m) => [m, r2(porM[m][e] || 0)])) }));
  return { meses, empresas, concentracion: { ytd: conc(anual), meses: Object.fromEntries(meses.map((m) => [m, conc(porM[m])])) } };
}

function salidaParticipacion(ac, sistema, anio) {
  const sum = participacion(ac.sum);
  for (const e of sum.empresas) e.tipo = ac.tipos[e.nombre];
  // Perfil horario: participación de cada empresa en cada hora del día (año a la fecha)
  const totH = Array.from({ length: 24 }, (_, i) => Object.values(ac.hora).reduce((s, v) => s + v[i], 0));
  for (const e of sum.empresas) e.perfil = (ac.hora[e.nombre] || Array(24).fill(0)).map((v, i) => (totH[i] ? r2((100 * v) / totH[i]) : 0));
  // Zonas de carga: peso de la zona en el suministro calificado y participación de cada empresa en ella
  const zt = Object.fromEntries(Object.entries(ac.zonas).map(([z, ms]) => [z, Object.values(ms).reduce((s, o) => s + Object.values(o).reduce((x, y) => x + y, 0), 0)]));
  const total = Object.values(zt).reduce((s, v) => s + v, 0);
  const zonas = Object.entries(ac.zonas).filter(([z]) => zt[z] > 0).sort((x, y) => zt[y[0]] - zt[x[0]]).map(([z, ms]) => {
    const p = participacion(ms);
    return { zona: z, peso: r2((100 * zt[z]) / total), concentracion: p.concentracion.ytd, empresas: p.empresas.map(({ nombre, ytd, meses }) => ({ nombre, ytd, meses })) };
  });
  return {
    sistema, anio, actualizado: new Date().toISOString().slice(0, 10), hasta: ac.dias.slice().sort().at(-1),
    suministro: sum, zonas,
    generacion: participacion(ac.gen), reservas: participacion(ac.res),
  };
}

/* ── Ajuste del modelo: precio estimado contra el componente de energía del PML ─ */
const VERSION_CURVA = 8;  // súbela al cambiar el método de la curva: se recalcula todo

// Qué datos tenía el cálculo de un día; si cambian (liquidación nueva), se recalcula
function firma(estado, fecha, sistema) {
  const r = estado.reportes, ult = (lista = [], pref) => lista.filter((k) => k.startsWith(pref)).sort().at(-1) || '-';
  return [ult(r['demanda_real|balance'], fecha + '_L'), ult(r['demanda_real|retiros'], fecha + '_L'),
    ult(r.generacion_tec, fecha.slice(0, 7) + '_L'), (r[`pml_energia|MTR|${sistema}`] || []).includes(fecha) ? 'mtr' : '-'].join('|');
}

// Error del precio estimado por modo (MDA con hidro real, MDA con la mediana hidro, MTR ex post), por mes y total
const MODOS = { mda: [1, 3, 11], mda_hidro_mediana: [2, 3, null], mtr: [4, 5, 12] };
function metricas(serie) {
  const grupos = {};
  for (const [fecha, horas] of Object.entries(serie.dias)) {
    for (const fila of horas) {
      for (const [modo, [iEst, iPml, iTipo]] of Object.entries(MODOS)) {
        const est = fila[iEst], pml = fila[iPml];
        if (est == null || pml == null) continue;
        for (const g of ['total', fecha.slice(0, 7)]) {
          const m = ((grupos[modo] ??= {})[g] ??= { n: 0, sa: 0, sd: 0, d10: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, marginal: {} });
          m.n++; m.sa += Math.abs(est - pml); m.sd += est - pml; m.d10 += Math.abs(est - pml) <= 0.1 * Math.abs(pml) ? 1 : 0;
          m.sx += est; m.sy += pml; m.sxx += est * est; m.syy += pml * pml; m.sxy += est * pml;
          if (iTipo != null && fila[iTipo]) m.marginal[fila[iTipo]] = (m.marginal[fila[iTipo]] || 0) + 1;
        }
      }
    }
  }
  const fin = (m) => {
    const cov = m.sxy / m.n - (m.sx / m.n) * (m.sy / m.n), vx = m.sxx / m.n - (m.sx / m.n) ** 2, vy = m.syy / m.n - (m.sy / m.n) ** 2;
    return { horas: m.n, precio_estimado_prom: r2(m.sx / m.n), energia_pml_prom: r2(m.sy / m.n), error_abs_prom: r2(m.sa / m.n), sesgo: r2(m.sd / m.n),
      pct_dentro_10: r1((100 * m.d10) / m.n), correlacion: vx > 0 && vy > 0 ? r2(cov / Math.sqrt(vx * vy)) : null, horas_por_tipo_marginal: m.marginal };
  };
  return Object.fromEntries(Object.entries(grupos).map(([modo, gs]) => [modo, Object.fromEntries(Object.entries(gs).map(([g, m]) => [g, fin(m)]))]));
}

/* ── Principal ──────────────────────────────────────────────────────── */
// Versión de los resúmenes por empresa (desvío, reservas, costos, hidro, participación): al cambiarla se recalculan
const VERSION_RESUMEN = 2;
let PART = null, REG = null;  // catálogo de participantes y registro de plantas de la corrida

async function main() {
  const ajuste = {};
  const almacen = process.argv.includes('--r2') ? bucketR2() : carpetaLocal(path.resolve(arg('--salida', 'ofertas_limpias')));
  const desde = arg('--desde', INICIO), hasta = arg('--hasta', hoyMx());
  const estado = JSON.parse((await almacen.leer(ESTADO))?.toString() || '{"reportes":{}}');
  PART = await cargarParticipantes(almacen);
  REG = await registroPlantas(almacen);
  const serieDe = async (k, base) => { const s = await leerJson(almacen, k, null); return s && s.version === VERSION_RESUMEN ? s : { ...base, version: VERSION_RESUMEN }; };
  const tiene = (id) => new Set(estado.reportes[id] || []);
  let errores = 0;
  const t0 = Date.now();

  for (const sistema of SISTEMAS) {
    // Días con lo indispensable para cada resumen
    const base = [...tiene(`MDA|termica|${sistema}`)].filter((d) => d >= desde && d <= hasta && tiene(`MDA|compra|${sistema}`).has(d)).sort();
    const conMtr = base.filter((d) => tiene(`MTR|termica|${sistema}`).has(d) && tiene(`MTR|intermitente|${sistema}`).has(d) && tiene(`MTR|nodespachable|${sistema}`).has(d));
    for (const anio of [...new Set(base.map((d) => d.slice(0, 4)))]) {
      const delAnio = (lista) => lista.filter((d) => d.startsWith(anio));

      // 1. Curva: un archivo por día + serie anual por hora. Un día se recalcula cuando llega
      // una liquidación nueva de la demanda real o de la generación por tecnología.
      const kSerie = `resumen/curva/serie_${anio}_${sistema}.json.gz`;
      const serie = await leerJson(almacen, kSerie, { sistema, anio, version: VERSION_CURVA, dias: {}, firmas: {} });
      if (serie.version !== VERSION_CURVA) Object.assign(serie, { version: VERSION_CURVA, dias: {}, firmas: {} });
      let n = 0;
      for (const fecha of delAnio(base).filter((d) => serie.firmas[d] !== firma(estado, d, sistema))) {
        try {
          const c = await curvaDia(almacen, fecha, sistema, estado);
          await escribirJson(almacen, `resumen/curva/${anio}/${fecha}_${sistema}.json.gz`, c);
          serie.dias[fecha] = c.horas.map((h) => [h.hora, h.precio, h.precio_hidro_mediana, h.pml.energia_mda, h.mtr?.precio ?? null, h.pml.energia_mtr,
            h.demanda.total, h.real.balance, h.real.retiros, h.real.generacion, h.real.hidro, h.marginal?.tipo ?? null, h.mtr?.marginal?.tipo ?? null]);
          serie.firmas[fecha] = firma(estado, fecha, sistema);
          n++;
        } catch (e) { errores++; console.log(`Curva ${sistema} ${fecha}: ERROR ${e.message}`); }
      }
      serie.columnas = ['hora', 'precio_mda', 'precio_mda_hidro_mediana', 'energia_pml_mda', 'precio_mtr', 'energia_pml_mtr',
        'demanda_mda', 'demanda_real_balance', 'demanda_real_retiros', 'generacion_real', 'hidro_real', 'tipo_marginal_mda', 'tipo_marginal_mtr'];
      if (n) await escribirJson(almacen, kSerie, serie);
      console.log(`Curva ${sistema} ${anio}: ${n} días calculados (${Object.keys(serie.dias).length} en total)`);
      ((ajuste[anio] ??= {})[sistema] = metricas(serie));

      // 2. Desvío MDA vs MTR
      const kDes = `resumen/desvio/serie_${anio}_${sistema}.json.gz`;
      const des = await serieDe(kDes, { sistema, anio, dias: {} });
      n = 0;
      for (const fecha of delAnio(conMtr).filter((d) => !des.dias[d])) {
        try {
          const d = await desvioDia(almacen, fecha, sistema);
          await escribirJson(almacen, `resumen/desvio/${anio}/${fecha}_${sistema}.json.gz`, d);
          des.dias[fecha] = Object.fromEntries(Object.entries(d.tipos).map(([t, v]) => [t, { mda: v.mwh_mda, mtr: v.mwh_mtr, ...(v.cambios_estatus ? { cambios: v.cambios_estatus } : {}) }]));
          n++;
        } catch (e) { errores++; console.log(`Desvío ${sistema} ${fecha}: ERROR ${e.message}`); }
      }
      if (n) await escribirJson(almacen, kDes, des);
      console.log(`Desvío ${sistema} ${anio}: ${n} días nuevos`);

      // 6. Validación horaria de reservas (días con MTR): archivo por día + serie anual por hora
      const kRes = `resumen/reservas/serie_${anio}_${sistema}.json.gz`;
      const resv = await serieDe(kRes, { sistema, anio, dias: {} });
      resv.columnas = ['hora', 'termica_mw_bajan', 'termica_mw_suben', 'termica_holgura_mda', 'termica_holgura_mtr', 'reserva_ofrecida_total_mda', 'reserva_ofrecida_total_mtr',
        'requerido_total_mda', 'requerido_total_mtr', 'asignado_menos_requerido_rod10', 'asignado_menos_requerido_nr10', 'asignado_menos_requerido_sup'];
      n = 0;
      for (const fecha of delAnio(conMtr).filter((d) => !resv.dias[d] && tiene(`MDA|servicios_conexos|${sistema}`).has(d))) {
        try {
          const d = await reservasDia(almacen, fecha, sistema);
          await escribirJson(almacen, `resumen/reservas/${anio}/${fecha}_${sistema}.json.gz`, d);
          const ofr = (h, lado) => r1(['termica', 'hidro'].reduce((s, t) => s + (h[t] ? Object.values(h[t].ofrecida).reduce((x, v) => x + v[lado], 0) : 0), 0));
          resv.dias[fecha] = d.horas.map((h) => [h.hora, h.termica.mw_bajan, h.termica.mw_suben, h.termica.holgura_mda, h.termica.holgura_mtr, ofr(h, 0), ofr(h, 1),
            h.requerido_mda?.total ?? null, h.requerido_mtr?.total ?? null, h.asignado_menos_requerido?.rod10 ?? null, h.asignado_menos_requerido?.nr10 ?? null, h.asignado_menos_requerido?.sup ?? null]);
          n++;
        } catch (e) { errores++; console.log(`Reservas ${sistema} ${fecha}: ERROR ${e.message}`); }
      }
      if (n) await escribirJson(almacen, kRes, resv);
      console.log(`Reservas ${sistema} ${anio}: ${n} días nuevos`);

      // 7. Reserva operativa del SIN por hora (horas críticas del Balance de Potencia); un día se
      // recalcula cuando llega una liquidación nueva de la demanda real
      if (sistema === 'SIN') {
        const kRO = `resumen/criticas/serie_${anio}_${sistema}.json.gz`;
        const ro = await serieDe(kRO, { sistema, anio, version: VERSION_RO, dias: {}, firmas: {} });
        if (ro.version !== VERSION_RO) Object.assign(ro, { version: VERSION_RO, dias: {}, firmas: {} });
        ro.columnas = ['hora', 'capacidad_mw', 'generacion_mw', 'demanda_mw', 'reserva_operativa_mw', 'reserva_operativa_pct',
          'cap_termica_mw', 'cap_hidro_mw', 'cap_intermitente_mw', 'cap_nodespachable_gi_mw', 'reserva_rodante_ofrecida_mw', 'reserva_no_rodante_ofrecida_mw'];
        ro.ventana = ventanaCriticas(Number(anio));
        n = 0;
        for (const fecha of delAnio(conMtr).filter((d) => tiene(`MTR|hidro|${sistema}`).has(d) && ro.firmas?.[d] !== firma(estado, d, sistema))) {
          try { ro.dias[fecha] = await reservaOperativaDia(almacen, fecha, estado); (ro.firmas ??= {})[fecha] = firma(estado, fecha, sistema); n++; } catch (e) { errores++; console.log(`Reserva operativa ${fecha}: ERROR ${e.message}`); }
        }
        if (n || !(await almacen.leer(kRO))) await escribirJson(almacen, kRO, ro);
        console.log(`Reserva operativa ${sistema} ${anio}: ${n} días calculados (${Object.keys(ro.dias).length} en total)`);
      }

      // 3. Costos térmicos por empresa y planta, MDA y MTR
      for (const mercado of ['MDA', 'MTR']) {
        const kCos = `resumen/costos/${anio}_${sistema}_${mercado}.json.gz`;
        const cos = await serieDe(kCos, { sistema, anio, mercado, bloques: BLQ, dias: [], plantas: {} });
        const pend = [...tiene(`${mercado}|termica|${sistema}`)].filter((d) => d.startsWith(anio) && d >= desde && d <= hasta && !cos.dias.includes(d)).sort();
        for (const fecha of pend) {
          try {
            const c = await costosDia(almacen, fecha, sistema, mercado);
            if (!c) continue;
            for (const [k, v] of Object.entries(c)) { const e = (cos.plantas[k] ??= { empresa: v.empresa, planta: v.planta, dias: {} }); e.dias[fecha] = { u: v.u, b: v.b }; }
            cos.dias.push(fecha);
          } catch (e) { errores++; console.log(`Costos ${sistema} ${mercado} ${fecha}: ERROR ${e.message}`); }
        }
        cos.dias.sort();
        if (pend.length) await escribirJson(almacen, kCos, cos);
        console.log(`Costos ${sistema} ${mercado} ${anio}: ${pend.length} días nuevos`);
      }

      // 5. Participación de mercado (acumulados privados en resumen/_acum/, salida solo en %)
      const kAc = `resumen/_acum/participacion_${anio}_${sistema}.json.gz`;
      const ac = await serieDe(kAc, { dias: [], sum: {}, hora: {}, zonas: {}, tipos: {}, gen: {}, res: {} });
      const pendP = [...tiene(`MDA|compra|${sistema}`)].filter((d) => d.startsWith(anio) && d >= desde && d <= hasta && !ac.dias.includes(d)).sort();
      for (const fecha of pendP) {
        try { await acumularParticipacion(almacen, ac, fecha, sistema); } catch (e) { errores++; console.log(`Participación ${sistema} ${fecha}: ERROR ${e.message}`); }
      }
      if (pendP.length || !(await almacen.leer(`resumen/participacion/${anio}_${sistema}.json.gz`))) {
        await escribirJson(almacen, kAc, ac);
        await escribirJson(almacen, `resumen/participacion/${anio}_${sistema}.json.gz`, salidaParticipacion(ac, sistema, anio));
      }
      console.log(`Participación ${sistema} ${anio}: ${pendP.length} días nuevos`);
    }
  }

  // 4. Hidro: costo de oportunidad y precio sombra (los códigos cambian cada día: se guarda la distribución diaria)
  const ps = [...tiene('MDA|precios_sombra|SIN')].filter((d) => d >= desde && d <= hasta).sort();
  for (const anio of [...new Set(ps.map((d) => d.slice(0, 4)))]) {
    const kH = `resumen/hidro/${anio}.json.gz`;
    const hid = await serieDe(kH, { anio, columnas: ['costo_oportunidad', 'precio_sombra'], dias: {} });
    const pend = ps.filter((d) => d.startsWith(anio) && !hid.dias[d]);
    for (const fecha of pend) {
      hid.dias[fecha] = ((await oferta(almacen, 'MDA', 'precios_sombra', fecha, 'SIN')) || []).map((f) => [num(f.COSTO_OPORTUNIDAD), num(f.PRECIO_SOMBRA)]).sort((x, y) => x[0] - y[0]);
    }
    if (pend.length) await escribirJson(almacen, kH, hid);
    console.log(`Hidro ${anio}: ${pend.length} días nuevos`);
  }
  await REG.guardar();

  for (const [anio, sistemas] of Object.entries(ajuste)) {
    await escribirJson(almacen, `resumen/ajuste/${anio}.json.gz`, { anio, version_curva: VERSION_CURVA, actualizado: new Date().toISOString(), sistemas });
  }

  console.log(`Resúmenes listos en ${Math.round((Date.now() - t0) / 1000)} s, ${errores} errores`);
  if (errores) process.exitCode = 1;
}

// Importable para pruebas del modelo (scripts que llaman curvaDia con otros parámetros)
export async function prepararCatalogos(a) { PART = await cargarParticipantes(a); REG = await registroPlantas(a); return PART; }
export { curvaDia, tabla, oferta, leerXlsx, reservaOperativaDia, ventanaCriticas };
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
