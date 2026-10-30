// Ofertas del Mercado Eléctrico Mayorista (MDA y MTR) publicadas en el SIM del
// CENACE: descarga, limpieza y salida en CSV con el diseño de la pestaña de ofertas
// del portal. El SIM no tiene web service para estos reportes; cada página es un
// formulario ASP.NET que se llena con postbacks (reporte → periodicidad → sistema →
// periodo) y entrega un ZIP con un CSV por día. Lo ejecuta .github/workflows/ofertas.yml;
// también a mano:
//   node scripts/ofertas.mjs [--desde 2026-01-01] [--hasta AAAA-MM-DD] [--salida dir | --r2] [--solo termica,compra] [--minutos 300]
//
// Las ofertas son información privada del portal: van al bucket privado de Cloudflare R2
// (--r2, credenciales en los secrets R2_*), nunca a data/ (el repo es público), y en los
// logs solo van conteos. Sin --r2 se escribe en una carpeta local (--salida, por omisión
// ofertas_limpias) con la misma estructura, para probar.
//
// Cada corrida baja solo los días que faltan: el avance por reporte y sistema se guarda en
// ofertas/estado.json (en el bucket o en la carpeta local). Las ofertas se publican con
// ~60 días de rezago; el límite de cada reporte es la fecha máxima que anuncia el SIM.
//
// Formato de salida (un CSV gzip por mercado, tipo, día y sistema:
// ofertas/<MDA|MTR>/<tipo>/<año>/<fecha>_<sistema>.csv.gz):
//   Fecha, Sistema, Mercado, Codigo, [Short], [Short CE], [Modalidad], columnas del CENACE…
// - Fecha sale de la fila "Fecha:" del archivo (no del nombre) y el Sistema de su fila 3.
// - Short = 4 primeros caracteres del código (compra y venta); Short CE = 6 (solo venta).
// - Térmica e hidro: costos antes que MW (bloques 1..11 y servicios conexos); la térmica
//   agrega "Costo Unitario de Potencia Minima" = costo a potencia mínima / límite mínimo (0 si el mínimo es 0).
// - Importación / exportación: cada código oferta fija O bloques; la columna que no usa
//   viene vacía, se guarda 0 y "Modalidad" (Fija / Bloques) conserva la diferencia.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { inflateRawSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SIM = 'https://www.cenace.gob.mx/Paginas/SIM/';
const UA = 'Mozilla/5.0 (Sentinels ofertas)';
const PRE = 'ctl00$ContentPlaceHolder1$';
const TODOS = ['SIN', 'BCA', 'BCS'];
const INICIO = '2026-01-01';  // alcance del histórico
const ESTADO = 'ofertas/estado.json';

// Reportes del SIM. Hidro solo existe en el SIN (si se pide BCA/BCS el SIM regresa el SIN);
// importación / exportación no existen en BCS y el consumo del GI de BCS viene vacío.
const REPORTES = [
  { mercado: 'MDA', tipo: 'compra',        pagina: 'Reportes/OfertasMDA.aspx', reporte: '371',     periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MDA', tipo: 'termica',       pagina: 'Reportes/OfertasMDA.aspx', reporte: '365,366', periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MDA', tipo: 'hidro',         pagina: 'Reportes/OfertasMDA.aspx', reporte: '367,368', periodicidad: 'H', sistemas: ['SIN'] },
  { mercado: 'MDA', tipo: 'intermitente',  pagina: 'Reportes/OfertasMDA.aspx', reporte: '369',     periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MDA', tipo: 'nodespachable', pagina: 'Reportes/OfertasMDA.aspx', reporte: '370',     periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MDA', tipo: 'importacion',   pagina: 'Reportes/OfertasMDA.aspx', reporte: '372',     periodicidad: 'H', sistemas: ['SIN', 'BCA'] },
  { mercado: 'MDA', tipo: 'exportacion',   pagina: 'Reportes/OfertasMDA.aspx', reporte: '373',     periodicidad: 'H', sistemas: ['SIN', 'BCA'] },
  { mercado: 'MDA', tipo: 'gi_generacion', pagina: 'Reportes/OfertasMDA.aspx', reporte: '374',     periodicidad: 'D', sistemas: TODOS },
  { mercado: 'MDA', tipo: 'gi_consumo',    pagina: 'Reportes/OfertasMDA.aspx', reporte: '375',     periodicidad: 'D', sistemas: ['SIN', 'BCA'] },
  { mercado: 'MDA', tipo: 'precios_sombra', pagina: 'PreciosSombra.aspx',      reporte: '385',     periodicidad: null, sistemas: ['SIN'] },
  { mercado: 'MDA', tipo: 'servicios_conexos', pagina: 'Reportes/ReqServConexosMDA.aspx', reporte: '358', periodicidad: null, sistemas: TODOS },
  { mercado: 'MDA', tipo: 'servicios_conexos_asignados', pagina: 'Reportes/ResultadosMDA.aspx', reporte: '349', periodicidad: null, sistemas: TODOS },
  { mercado: 'MDA', tipo: 'asignacion_participantes', pagina: 'Reportes/ResultadosMDA.aspx', reporte: '348', periodicidad: null, sistemas: TODOS },
  { mercado: 'MDA', tipo: 'carga_asignada_zona', pagina: 'Reportes/ResultadosMDA.aspx', reporte: '350', periodicidad: null, sistemas: TODOS },
  { mercado: 'MDA', tipo: 'intercambios_asignados', pagina: 'Reportes/ResultadosMDA.aspx', reporte: '347', periodicidad: null, sistemas: ['SIN', 'BCA'] },
  { mercado: 'MDA', tipo: 'precios_reservas', pagina: 'Reportes/PreEnerServConMDA.aspx', reporte: '361,324', periodicidad: 'D', sistemas: TODOS },
  { mercado: 'MTR', tipo: 'termica',       pagina: 'Reportes/OfertasMTR.aspx', reporte: '376,377', periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MTR', tipo: 'hidro',         pagina: 'Reportes/OfertasMTR.aspx', reporte: '378,379', periodicidad: 'H', sistemas: ['SIN'] },
  { mercado: 'MTR', tipo: 'nodespachable', pagina: 'Reportes/OfertasMTR.aspx', reporte: '380',     periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MTR', tipo: 'intermitente',  pagina: 'Reportes/OfertasMTR.aspx', reporte: '381',     periodicidad: 'H', sistemas: TODOS },
  { mercado: 'MTR', tipo: 'gi_generacion', pagina: 'Reportes/OfertasMTR.aspx', reporte: '382',     periodicidad: 'D', sistemas: TODOS },
  { mercado: 'MTR', tipo: 'servicios_conexos', pagina: 'Reportes/ReqServConexosMTR.aspx', reporte: '357', periodicidad: null, sistemas: TODOS },
  { mercado: 'MTR', tipo: 'precios_reservas', pagina: 'Reportes/PreEnerServConMTR.aspx', reporte: '364,327', periodicidad: 'D', sistemas: TODOS },
];

/* ── Columnas por tipo ──────────────────────────────────────────────── */
const N2 = (i) => String(i).padStart(2, '0');
const BLOQUES = Array.from({ length: 11 }, (_, i) => N2(i + 1));
const SERVICIOS = ['rodante 10 min', 'no rodante 10 min', 'rodante suplementaria', 'no rodante suplementaria', 'regulacion secundaria'];
const COSTOS_RESERVA = SERVICIOS.map((s) => `Costo Reserva ${s} ($/MW)`);
const MW_RESERVA = SERVICIOS.map((s) => `Reserva ${s} (MW)`);
const COSTO_MIN = 'Costo de Operacion a potencia minima ($)';
const COSTO_UNIT = 'Costo Unitario de Potencia Minima ($/MWh)';
const LIM_MAX = 'Limite de despacho maximo (MW)', LIM_MIN = 'Limite de despacho minimo (MW)';
const pares = (n, a, b) => Array.from({ length: n }, (_, i) => [a(N2(i + 1)), b(N2(i + 1))]).flat();
const RT_REG = 'RT Reserva Regulacion (MW)', RT_ROD = 'RT Reserva Rodante 10 (MW)', RT_10 = 'RT Reserva 10 (MW)', RT_SUP = 'RT Reserva Suplementaria (MW)';
const RT = ['Hora', RT_REG, RT_ROD, RT_10, RT_SUP];
const intercambio = (dir, punto) => [
  'Hora', punto, 'Enlace Internacional', `${dir} fija (MW)`,
  ...pares(3, (b) => `${dir} de energia-Bloque ${b} (MW)`, (b) => `Precio de la energia-Bloque ${b} ($/MWh)`),
];

// columnas: orden de salida después de Codigo (deben ser exactamente las del archivo,
// más las calculadas en `calculadas`); texto: columnas que no son números.
const TIPOS = {
  compra:        { short: 4, columnas: ['NodoP/Zona de Carga', 'Hora', 'Demanda fija (MW)'] },
  termica:       { short: 6, columnas: ['Estatus asignacion', 'Hora', LIM_MAX, LIM_MIN, COSTO_MIN, COSTO_UNIT,
                     ...BLOQUES.map((b) => `Costo Incremental de generacion Bloque ${b} ($/MWh)`),
                     ...BLOQUES.map((b) => `Bloque de Potencia ${b} (MW)`), ...COSTOS_RESERVA, ...MW_RESERVA],
                   calculadas: { [COSTO_UNIT]: (f) => { const min = Number(f[LIM_MIN]); return min ? redondea(Number(f[COSTO_MIN]) / min) : 0; } } },
  hidro:         { short: 6, columnas: ['Estatus asignacion', 'Hora', LIM_MAX, LIM_MIN, ...COSTOS_RESERVA, ...MW_RESERVA] },
  intermitente:  { short: 6, columnas: ['Estatus asignacion', 'Hora', 'Pronostico en MW',
                     ...pares(3, (b) => `(%) Pronostico de Generacion Bloque ${b}`, (b) => `Costo de Generacion Bloque ${b} ($/MWh)`)] },
  nodespachable: { short: 6, columnas: ['Hora', 'Potencia media (MW)'] },
  importacion:   { modalidad: 'Importacion fija (MW)', columnas: intercambio('Importacion', 'Punto de Recepcion (NodoP)') },
  exportacion:   { modalidad: 'Exportacion fija (MW)', columnas: intercambio('Exportacion', 'Punto de Entrega (NodoP)') },
  gi_generacion: { columnas: ['Hora', 'Potencia Media (MW)'] },
  gi_consumo:    { columnas: ['Hora', 'Potencia Media (MW)'] },
  precios_sombra: { columnas: ['COSTO_OPORTUNIDAD', 'PRECIO_SOMBRA'] },
  // Requerimientos (MDA y MTR) y cantidades asignadas (MDA) de servicios conexos: el CENACE
  // publica totales acumulados (cada uno incluye al anterior); las columnas "Real" separan cada
  // reserva por diferencia.
  servicios_conexos: reservasReales(RT_REG, RT_ROD, RT_10, RT_SUP),
  servicios_conexos_asignados: reservasReales('Reserva de Regulacion Secundaria (MW)', 'Reserva Rodante de 10 minutos (MW)', 'Reserva de 10 minutos (MW)', 'Reserva Suplementaria (MW)'),
  // Resultados del MDA: energía y reservas asignadas por participante (clave de PM, p. ej. C001),
  // carga asignada por zona de carga e importación / exportación asignadas por enlace
  asignacion_participantes: { clave: 'Participante', columnas: ['Hora', 'Cantidad total de energia asignada (MWh)', 'Reserva de Regulacion (MW)', 'Reserva Rodante de 10 minutos (MW)',
    'Reserva No Rodante de 10 minutos (MW)', 'Reserva Rodante Suplementaria (MW)', 'Reserva No Rodante Suplementaria (MW)'] },
  carga_asignada_zona: { clave: 'Zona de carga', columnas: ['Hora', 'Cantidad total de energia asignada por Carga Directamente Modelada(MWh)',
    'Cantidad total de energia asignada por Carga Indirectamente Modelada(MWh)', 'Cantidad total de energia asignada (MWh)'] },
  intercambios_asignados: { clave: 'Enlace Internacional', columnas: ['Hora', ...['Comercial', 'Asignada por pago de Energia Inadvertida', 'Asignada por Confiabilidad', 'Asignada al programa de los CIL', 'Total'].map((x) => `Importacion ${x}${x === 'Comercial' || x === 'Total' ? ' Asignada' : ''} (MWh)`),
    ...['Comercial', 'Asignada por cobro de Energia Inadvertida', 'Asignada por Confiabilidad', 'Asignada al programa de los CIL', 'Total'].map((x) => `Exportacion ${x}${x === 'Comercial' || x === 'Total' ? ' Asignada' : ''} (MWh)`)] },
  // Precio de cada reserva por hora y zona de reserva (formato largo: una fila por tipo de reserva)
  precios_reservas: { clave: 'Hora', columnas: ['Zona de reserva', 'Tipo de reserva', 'Precio de la reserva ($/MW por hora)'] },
};
function reservasReales(reg, rod, r10, sup) {
  const n = (f, c) => Number(f[c]);
  return {
    clave: 'Zona de Reserva',
    columnas: ['Hora', reg, rod, r10, sup, 'Reserva Total Real', 'Reserva Rodante 10 Real', 'Reserva No Rodante 10 Real', 'Reserva Sup Real'],
    calculadas: {
      'Reserva Total Real': (f) => redondea(n(f, sup) - n(f, reg)),
      'Reserva Rodante 10 Real': (f) => redondea(n(f, rod) - n(f, reg)),
      'Reserva No Rodante 10 Real': (f) => redondea(n(f, r10) - n(f, rod)),
      'Reserva Sup Real': (f) => redondea(n(f, sup) - n(f, r10)),
    },
  };
}
const TEXTO = new Set(['Estatus asignacion', 'NodoP/Zona de Carga', 'Punto de Recepcion (NodoP)', 'Punto de Entrega (NodoP)', 'Enlace Internacional']);

/* ── Utilidades ─────────────────────────────────────────────────────── */
function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const redondea = (x) => Math.round(x * 1e4) / 1e4;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const ddmmyyyy = (iso) => iso.split('-').reverse().join('/');
const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };

function decodifica(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

// Una línea de CSV (los reportes del SIM ponen cada valor entre comillas, con espacios de relleno)
function celdas(linea) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (q) {
      if (ch !== '"') cur += ch;
      else if (linea[i + 1] === '"') { cur += '"'; i++; } else q = false;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function csv(filas) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return filas.map((f) => f.map(esc).join(',')).join('\n') + '\n';
}

function unzip(buf) {
  const files = [];
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ZIP inválido');
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), nombre = buf.toString('latin1', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.push({ nombre, texto: (method === 8 ? inflateRawSync(raw) : raw).toString('latin1') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ── Formulario del SIM ─────────────────────────────────────────────── */
class Sesion {
  constructor(url) { this.url = url; this.cookies = new Map(); }

  async pedir(campos) {
    for (let intento = 1; ; intento++) {
      try {
        const res = await fetch(this.url, {
          method: campos ? 'POST' : 'GET',
          headers: {
            'User-Agent': UA,
            Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
            ...(campos ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          },
          body: campos ? new URLSearchParams(campos) : undefined,
          signal: AbortSignal.timeout(300000),
        });
        for (const c of res.headers.getSetCookie()) {
          const kv = c.split(';')[0], i = kv.indexOf('=');
          this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1));
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        if (intento >= 3) throw e;
        await espera(5000 * intento);
      }
    }
  }
}

function ocultos(html) {
  const h = {};
  for (const m of html.matchAll(/<input type="hidden" name="(__[A-Z]+)" id="[^"]*" value="([^"]*)"/g)) h[m[1]] = decodifica(m[2]);
  return h;
}

const isoDe = (ddmm) => ddmm.split('/').reverse().join('-');

// Último día publicado de un reporte y sistema: el MAX_FECHA_DATOS de su opción en el
// selector de sistema o, si la página no lo anuncia (Precios Sombra), el periodo que el
// SIM propone por omisión, que es el día más reciente.
async function ultimoDia(rep, sistema) {
  const s = new Sesion(SIM + rep.pagina);
  let html = await (await s.pedir()).text();
  html = await (await s.pedir({ ...ocultos(html), __EVENTTARGET: PRE + 'ddlReporte', __EVENTARGUMENT: '', [PRE + 'ddlReporte']: rep.reporte, [PRE + 'ddlSistema']: sistema })).text();
  const opcion = html.match(new RegExp(`<option[^>]*value="${sistema}"[^>]*>`))?.[0] || '';
  const max = opcion.match(/MAX_FECHA_DATOS="(\d\d\/\d\d\/\d{4})"/)?.[1] || html.match(/txtPeriodo" type="text" value="[^"]*-(\d\d\/\d\d\/\d{4})"/)?.[1];
  if (!max) throw new Error('el SIM no indica la fecha más reciente');
  return isoDe(max);
}

// Descarga un reporte de un sistema para un periodo; regresa los CSV del ZIP.
// El orden de los postbacks importa: cambiar el sistema regresa el periodo a la fecha más reciente.
async function descargar(rep, sistema, desde, hasta) {
  const s = new Sesion(SIM + rep.pagina), periodo = `${ddmmyyyy(desde)}-${ddmmyyyy(hasta)}`;
  const valores = {
    [PRE + 'ddlReporte']: rep.reporte, [PRE + 'ddlSistema']: sistema, [PRE + 'txtPeriodo']: periodo,
    ...(rep.periodicidad ? { [PRE + 'ddlPeriodicidad']: rep.periodicidad } : {}),
  };
  let html = await (await s.pedir()).text();
  for (const t of ['ddlReporte', rep.periodicidad && 'ddlPeriodicidad', 'ddlSistema', 'txtPeriodo'].filter(Boolean)) {
    html = await (await s.pedir({ ...ocultos(html), ...valores, __EVENTTARGET: PRE + t, __EVENTARGUMENT: '' })).text();
  }
  const enPagina = html.match(/txtPeriodo" type="text" value="([^"]*)"/)?.[1];
  if (enPagina !== periodo) throw new Error(`el SIM dejó el periodo en ${enPagina}`);
  const res = await s.pedir({ ...ocultos(html), ...valores, __EVENTTARGET: '', __EVENTARGUMENT: '', [PRE + 'btnDescargarZIP']: 'Descargar ZIP' });
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 ? unzip(buf) : [];
}

/* ── Limpieza ───────────────────────────────────────────────────────── */
function sistemaDe(linea) {
  if (/Baja California Sur/i.test(linea)) return 'BCS';
  if (/Baja California/i.test(linea)) return 'BCA';
  if (/Interconectado Nacional/i.test(linea)) return 'SIN';
  return null;
}

// Separa metadatos y tabla, valida fecha y sistema, y arma las filas de salida
function limpiar(rep, texto) {
  const lineas = texto.split(/\r?\n/);
  const meta = lineas.slice(0, 9).map((l) => celdas(l)[0]);
  const f = meta.map((l) => l.match(/^Fecha:\s*(\d{1,2})\/([a-z]{3})\/(\d{4})/i)).find(Boolean);
  if (!f || !MESES[f[2].toLowerCase()]) throw new Error('sin fila "Fecha:"');
  const fecha = `${f[3]}-${N2(MESES[f[2].toLowerCase()])}-${N2(Number(f[1]))}`;
  const sistema = sistemaDe(meta[2] || '');
  const tipo = TIPOS[rep.tipo], calc = tipo.calculadas || {}, clave = tipo.clave || 'Codigo';
  const iEnc = lineas.findIndex((l, i) => i < 12 && celdas(l)[0].toLowerCase() === clave.toLowerCase());
  if (iEnc < 0) throw new Error(`sin encabezado "${clave}"`);
  const enc = celdas(lineas[iEnc]), cod = enc[0];

  const fuente = tipo.columnas.filter((c) => !calc[c]);
  const faltan = fuente.filter((c) => !enc.includes(c)), sobran = enc.slice(1).filter((c) => !fuente.includes(c));
  if (faltan.length || sobran.length) throw new Error(`columnas cambiaron (faltan: ${faltan.join(' | ') || '-'}; nuevas: ${sobran.join(' | ') || '-'})`);

  const cabecera = ['Fecha', 'Sistema', 'Mercado', clave,
    ...(tipo.short ? ['Short'] : []), ...(tipo.short === 6 ? ['Short CE'] : []), ...(tipo.modalidad ? ['Modalidad'] : []), ...tipo.columnas];
  const filas = [];
  let vacios = 0;
  for (const l of lineas.slice(iEnc + 1)) {
    if (!l.trim()) continue;
    const c = celdas(l), fila = Object.fromEntries(enc.map((h, i) => [h, c[i] ?? '']));
    const codigo = fila[cod];
    const valor = (col) => {
      if (calc[col]) return calc[col](fila);
      const v = fila[col];
      if (TEXTO.has(col)) return v;
      if (v === '') { if (!tipo.modalidad) vacios++; return tipo.modalidad ? 0 : ''; }
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    };
    filas.push([fecha, sistema, rep.mercado, codigo,
      ...(tipo.short ? [codigo.slice(0, 4)] : []), ...(tipo.short === 6 ? [codigo.slice(0, 6)] : []),
      ...(tipo.modalidad ? [fila[tipo.modalidad] === '' ? 'Bloques' : 'Fija'] : []),
      ...tipo.columnas.map(valor)]);
  }
  return { fecha, sistema, cabecera, filas, vacios };
}

/* ── Estimación de la Demanda Real (referencia para la curva de oferta) ─
   Dos métodos: por balance (generación + importación − exportación, por sistema y
   área; incluye pérdidas) y por retiros (compras por zona de carga; sin pérdidas).
   Cada día tiene varias liquidaciones (0, 1, 2…); se guarda cada una y los resúmenes
   usan la más reciente. La página usa calendarios Telerik en lugar del formulario de
   las ofertas: se envían fecha inicial / final y el botón "Descargar". */
const DEMANDA_URL = SIM + 'Reportes/EstimacionDemandaReal.aspx';
const METODOS = { balance: 'PorBalance', retiros: 'PorRetiros' };

async function descargarDemanda(metodo, desde, hasta) {
  const s = new Sesion(DEMANDA_URL), m = METODOS[metodo];
  const html = await (await s.pedir()).text();
  const max = html.match(/"maxDate":"(\d{4}-\d\d-\d\d)/)?.[1];
  if (!max) throw new Error('el SIM no indica la fecha más reciente de la demanda real');
  if (hasta > max) hasta = max;
  if (desde > hasta) return { max, csvs: [] };
  const campos = { ...ocultos(html), __EVENTTARGET: '', __EVENTARGUMENT: '', [PRE + 'DescargarArchivosCsv_' + m]: 'Descargar' };
  for (const [k, iso] of [['FI', desde], ['FF', hasta]]) {
    const id = `RadDatePicker${k}Visualizar${m}`, dd = ddmmyyyy(iso);
    campos[PRE + id] = iso;
    campos[PRE + id + '$dateInput'] = dd;
    campos[`ctl00_ContentPlaceHolder1_${id}_dateInput_ClientState`] = JSON.stringify({
      enabled: true, emptyMessage: '', validationText: iso + '-00-00-00', valueAsString: iso + '-00-00-00',
      minDateStr: '2016-01-27-00-00-00', maxDateStr: max + '-00-00-00', lastSetTextBoxValue: dd,
    });
  }
  const buf = Buffer.from(await (await s.pedir(campos)).arrayBuffer());
  return { max, csvs: buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 ? unzip(buf) : [] };
}

function limpiarDemanda(texto) {
  const lineas = texto.split(/\r?\n/);
  const liq = lineas.slice(0, 10).map((l) => celdas(l)[0].match(/^LIQUIDACION (\d+) \(Dia de Operacion: (\d\d\/\d\d\/\d{4})\)/)).find(Boolean);
  if (!liq) throw new Error('demanda real: sin fila "LIQUIDACION"');
  const iEnc = lineas.findIndex((l, i) => i < 12 && celdas(l)[0] === 'Sistema');
  if (iEnc < 0) throw new Error('demanda real: sin encabezado "Sistema"');
  const enc = celdas(lineas[iEnc]), fecha = isoDe(liq[2]), liquidacion = Number(liq[1]);
  const filas = lineas.slice(iEnc + 1).filter((l) => l.trim()).map((l) => {
    const c = celdas(l);
    // "---" = no aplica (p. ej. intercambio entre gerencias fuera del SIN): se guarda 0
    return [fecha, liquidacion, ...c.map((v, i) => (i < 2 ? v : v === '---' || v === '' ? 0 : Number(v)))];
  });
  return { fecha, liquidacion, cabecera: ['Fecha', 'Liquidacion', ...enc], filas };
}

/* ── Energía generada por tipo de tecnología (liquidada) ────────────────
   Generación real por hora en 11 tecnologías, solo como total nacional ("SEN"). Un CSV
   por mes y liquidación (L0, L1, L2…); un mes en curso se vuelve a publicar con versión
   nueva, así que la clave incluye la versión del archivo ("v2026 06 14" → v20260614).
   Sirve para fijar la hidro de la curva (toda está en el SIN) y medir el ajuste. */
const GENERACION_URL = SIM + 'Reportes/EnergiaGeneradaTipoTec.aspx';

async function descargarGeneracion(mes) {
  const s = new Sesion(GENERACION_URL);
  const html = await (await s.pedir()).text();
  const max = html.match(/"maxDate":"(\d{4}-\d\d-\d\d)/)?.[1];
  if (!max) throw new Error('el SIM no indica la fecha más reciente de la generación por tecnología');
  if (`${mes}-01` > max) return { max, csvs: [] };
  const iso = `${mes}-01`, dd = ddmmyyyy(iso);
  const campos = { ...ocultos(html), __EVENTTARGET: '', __EVENTARGUMENT: '', [PRE + 'DescargarReportes']: 'Descargar en archivo .zip' };
  for (const k of ['FechaInicial', 'FechaFinal']) {
    campos[PRE + k] = iso;
    campos[PRE + k + '$dateInput'] = dd;
    campos[`ctl00_ContentPlaceHolder1_${k}_dateInput_ClientState`] = JSON.stringify({
      enabled: true, emptyMessage: '', validationText: iso + '-00-00-00', valueAsString: iso + '-00-00-00',
      minDateStr: '2016-04-30-00-00-00', maxDateStr: max + '-00-00-00', lastSetTextBoxValue: dd,
    });
  }
  const buf = Buffer.from(await (await s.pedir(campos)).arrayBuffer());
  return { max, csvs: buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 ? unzip(buf) : [] };
}

function limpiarGeneracion(nombre, texto) {
  const v = nombre.match(/_L(\d+) .* v(\d{4}) (\d\d) (\d\d)_/);
  if (!v) throw new Error(`generación: nombre inesperado ${nombre}`);
  const lineas = texto.split(/\r?\n/);
  const iEnc = lineas.findIndex((l, i) => i < 12 && celdas(l)[0] === 'Sistema');
  if (iEnc < 0) throw new Error('generación: sin encabezado "Sistema"');
  const enc = celdas(lineas[iEnc]);
  if (enc[1] !== 'Dia' || enc[2] !== 'Hora') throw new Error('generación: columnas cambiaron');
  const filas = lineas.slice(iEnc + 1).filter((l) => l.trim()).map((l) => {
    const c = celdas(l);
    return [isoDe(c[1]), c[0], Number(c[2]), ...c.slice(3).map((x) => (x === '' ? 0 : Number(x)))];
  });
  const mes = filas[0]?.[0].slice(0, 7);
  return { mes, clave: `${mes}_L${v[1]}_v${v[2]}${v[3]}${v[4]}`, cabecera: ['Fecha', 'Sistema', 'Hora', ...enc.slice(3)], filas };
}

/* ── Componente de energía del PML (SW-PML), un NodoP de referencia por sistema ─
   El componente de energía es el mismo en todos los nodos de un sistema; sirve para
   comparar el precio marginal estimado con la curva de oferta. Manual SW-PML: máximo
   7 días por consulta; el MDA se publica un día antes, el MTR ~7 días después. */
const SWPML = 'https://ws01.cenace.gob.mx:8082/SWPML/SIM';
const NODO_REF = { SIN: '06CDU-400', BCA: '07RIN-161', BCS: '07OLA-115' };

async function pmlEnergia(sistema, proceso, desde, hasta) {
  const p = (iso) => iso.replaceAll('-', '/');
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(`${SWPML}/${sistema}/${proceso}/${NODO_REF[sistema]}/${p(desde)}/${p(hasta)}/JSON`, { signal: AbortSignal.timeout(60000) });
      if (res.status === 204) return [];
      if (!res.ok) throw new Error(`SW-PML HTTP ${res.status}`);
      const body = await res.json();
      if (body.status && body.status !== 'OK') throw new Error(`SW-PML status ${body.status}`);
      return (body.Resultados?.[0]?.Valores || []).map((v) => ({
        fecha: v.fecha, hora: Number(v.hora), pml: Number(v.pml), energia: Number(v.pml_ene), perdidas: Number(v.pml_per), congestion: Number(v.pml_cng),
      }));
    } catch (e) {
      if (intento >= 3) throw e;
      await espera(5000 * intento);
    }
  }
}

/* ── Almacén: bucket R2 (API S3, firma SigV4) o carpeta local ─────────── */
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

function bucketR2() {
  const { R2_ACCOUNT_ID: cuenta, R2_ACCESS_KEY_ID: llave, R2_SECRET_ACCESS_KEY: secreto, R2_BUCKET: bucket } = process.env;
  if (!cuenta || !llave || !secreto || !bucket) throw new Error('faltan las variables R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY o R2_BUCKET');
  const host = `${cuenta}.r2.cloudflarestorage.com`;
  async function pedir(metodo, clave, cuerpo = Buffer.alloc(0), tipo) {
    const ruta = `/${bucket}/${clave.split('/').map(encodeURIComponent).join('/')}`;
    const fecha = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), dia = fecha.slice(0, 8);
    const hash = sha256(cuerpo), alcance = `${dia}/auto/s3/aws4_request`, firmados = 'host;x-amz-content-sha256;x-amz-date';
    const canonica = [metodo, ruta, '', `host:${host}\nx-amz-content-sha256:${hash}\nx-amz-date:${fecha}\n`, firmados, hash].join('\n');
    const llaveFirma = hmac(hmac(hmac(hmac('AWS4' + secreto, dia), 'auto'), 's3'), 'aws4_request');
    const firma = createHmac('sha256', llaveFirma).update(['AWS4-HMAC-SHA256', fecha, alcance, sha256(canonica)].join('\n')).digest('hex');
    for (let intento = 1; ; intento++) {
      const res = await fetch(`https://${host}${ruta}`, {
        method: metodo,
        headers: {
          'x-amz-content-sha256': hash, 'x-amz-date': fecha, ...(tipo ? { 'Content-Type': tipo } : {}),
          Authorization: `AWS4-HMAC-SHA256 Credential=${llave}/${alcance}, SignedHeaders=${firmados}, Signature=${firma}`,
        },
        body: metodo === 'PUT' ? cuerpo : undefined,
      });
      if (res.ok || res.status === 404 || res.status === 403 || intento >= 3) return res;
      await espera(3000 * intento);
    }
  }
  return {
    nombre: `bucket R2 ${bucket}`,
    async leer(clave) {
      const res = await pedir('GET', clave);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${res.status} (revisa los secrets R2_*)`);
      return Buffer.from(await res.arrayBuffer());
    },
    async escribir(clave, datos, tipo) {
      const res = await pedir('PUT', clave, datos, tipo);
      if (!res.ok) throw new Error(`R2 PUT ${res.status} (revisa los secrets R2_*)`);
    },
  };
}

function carpetaLocal(dir) {
  return {
    nombre: `carpeta ${dir}`,
    async leer(clave) { try { return await readFile(path.join(dir, clave)); } catch { return null; } },
    async escribir(clave, datos) {
      await mkdir(path.dirname(path.join(dir, clave)), { recursive: true });
      await writeFile(path.join(dir, clave), datos);
    },
  };
}

/* ── Principal ──────────────────────────────────────────────────────── */
const hoyMx = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

function dias(desde, hasta) {
  const out = [];
  for (let d = new Date(desde + 'T00:00:00Z'); d <= new Date(hasta + 'T00:00:00Z'); d = new Date(d.getTime() + 864e5)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// Días faltantes agrupados en tramos continuos de a lo más un mes (una descarga cada uno)
function tramos(faltan) {
  const out = [];
  for (const d of faltan) {
    const t = out[out.length - 1];
    const sigue = t && new Date(new Date(t[1] + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10) === d;
    if (sigue && t[0].slice(0, 7) === d.slice(0, 7)) t[1] = d; else out.push([d, d]);
  }
  return out;
}

async function main() {
  const desde = arg('--desde', INICIO), hasta = arg('--hasta', hoyMx());
  const solo = arg('--solo') ? arg('--solo').split(',') : null;
  const minutos = Number(arg('--minutos', 300)), t0 = Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    console.error('Uso: node scripts/ofertas.mjs [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--salida dir | --r2] [--solo tipo,tipo] [--minutos N]');
    process.exit(2);
  }
  const almacen = process.argv.includes('--r2') ? bucketR2() : carpetaLocal(path.resolve(arg('--salida', 'ofertas_limpias')));
  const estado = JSON.parse((await almacen.leer(ESTADO))?.toString() || '{"reportes":{}}');
  console.log(`Destino: ${almacen.nombre}; periodo ${desde}..${hasta}`);

  let archivos = 0, filasTot = 0, errores = 0, pendientes = 0;
  for (const rep of REPORTES.filter((r) => !solo || solo.includes(r.tipo))) {
    for (const sistema of rep.sistemas) {
      const id = `${rep.mercado}|${rep.tipo}|${sistema}`, etiqueta = `${rep.mercado} ${rep.tipo} ${sistema}`;
      const hechos = new Set(estado.reportes[id] || []);
      try {
        const max = await ultimoDia(rep, sistema);
        const faltan = dias(desde, hasta < max ? hasta : max).filter((d) => !hechos.has(d));
        if (!faltan.length) { console.log(`${etiqueta}: al día (hasta ${max})`); continue; }
        let n = 0, cargados = 0, descartados = 0, vacios = 0;
        for (const [ini, fin] of tramos(faltan)) {
          if (Date.now() - t0 > minutos * 60000) { pendientes++; break; }
          for (const { texto } of await descargar(rep, sistema, ini, fin)) {
            const r = limpiar(rep, texto);
            if (r.sistema !== sistema || r.fecha < ini || r.fecha > fin) { descartados++; continue; }
            await almacen.escribir(`ofertas/${rep.mercado}/${rep.tipo}/${r.fecha.slice(0, 4)}/${r.fecha}_${sistema}.csv.gz`,
              gzipSync(csv([r.cabecera, ...r.filas])), 'application/gzip');
            hechos.add(r.fecha);
            cargados++; n += r.filas.length; vacios += r.vacios;
          }
          estado.reportes[id] = [...hechos].sort();
          estado.actualizado = new Date().toISOString();
          await almacen.escribir(ESTADO, Buffer.from(JSON.stringify(estado)), 'application/json');
          await espera(500);
        }
        archivos += cargados; filasTot += n;
        const sinArchivo = faltan.filter((d) => !hechos.has(d)).length;
        console.log(`${etiqueta}: ${cargados} días nuevos, ${n} filas (hasta ${max})` +
          (sinArchivo ? `, ${sinArchivo} días sin archivo todavía` : '') +
          (descartados ? `, ${descartados} descartados (otra fecha o sistema)` : '') + (vacios ? `, ${vacios} celdas vacías` : ''));
      } catch (e) {
        errores++;
        console.log(`${etiqueta}: ERROR ${e.message}`);
      }
    }
  }

  const guardarEstado = () => {
    estado.actualizado = new Date().toISOString();
    return almacen.escribir(ESTADO, Buffer.from(JSON.stringify(estado)), 'application/json');
  };

  // Demanda real: se vuelve a pedir todo el periodo por meses porque el CENACE agrega
  // reliquidaciones a días pasados; solo se suben las liquidaciones que no teníamos.
  if (!solo || solo.includes('demanda_real')) {
    for (const metodo of Object.keys(METODOS)) {
      const id = `demanda_real|${metodo}`, hechos = new Set(estado.reportes[id] || []);
      try {
        let nuevos = 0, max;
        for (const [ini, fin] of tramos(dias(desde, hasta))) {
          if (Date.now() - t0 > minutos * 60000) { pendientes++; break; }
          const r = await descargarDemanda(metodo, ini, fin);
          max = r.max;
          for (const { texto } of r.csvs) {
            const d = limpiarDemanda(texto), clave = `${d.fecha}_L${d.liquidacion}`;
            if (hechos.has(clave) || d.fecha < ini || d.fecha > fin) continue;
            await almacen.escribir(`demanda_real/${metodo}/${d.fecha.slice(0, 4)}/${clave}.csv.gz`, gzipSync(csv([d.cabecera, ...d.filas])), 'application/gzip');
            hechos.add(clave); nuevos++;
          }
          if (fin >= max) break;
          await espera(500);
        }
        estado.reportes[id] = [...hechos].sort();
        await guardarEstado();
        archivos += nuevos;
        console.log(`Demanda real ${metodo}: ${nuevos} archivos nuevos (día-liquidación), publicada hasta ${max}`);
      } catch (e) {
        errores++;
        console.log(`Demanda real ${metodo}: ERROR ${e.message}`);
      }
    }
  }

  // Generación por tecnología: cada mes del periodo, para captar liquidaciones y versiones nuevas
  if (!solo || solo.includes('generacion_tec')) {
    const id = 'generacion_tec', hechos = new Set(estado.reportes[id] || []);
    try {
      let nuevos = 0, max;
      for (const mes of [...new Set(dias(desde, hasta).map((d) => d.slice(0, 7)))]) {
        if (Date.now() - t0 > minutos * 60000) { pendientes++; break; }
        const r = await descargarGeneracion(mes);
        max = r.max;
        for (const { nombre, texto } of r.csvs) {
          const g = limpiarGeneracion(nombre, texto);
          if (g.mes !== mes || hechos.has(g.clave)) continue;
          await almacen.escribir(`generacion_tec/${mes.slice(0, 4)}/${g.clave}.csv.gz`, gzipSync(csv([g.cabecera, ...g.filas])), 'application/gzip');
          hechos.add(g.clave); nuevos++;
        }
        if (`${mes}-01` > max) break;
        await espera(500);
      }
      estado.reportes[id] = [...hechos].sort();
      await guardarEstado();
      archivos += nuevos;
      console.log(`Generación por tecnología: ${nuevos} archivos nuevos (mes-liquidación-versión), publicada hasta ${max}`);
    } catch (e) {
      errores++;
      console.log(`Generación por tecnología: ERROR ${e.message}`);
    }
  }

  // Componente de energía del PML: días que faltan, en consultas de 7 días
  if (!solo || solo.includes('pml_energia')) {
    for (const proceso of ['MDA', 'MTR']) {
      const limite = new Date(new Date(hoyMx() + 'T00:00:00Z').getTime() + (proceso === 'MDA' ? 1 : -7) * 864e5).toISOString().slice(0, 10);
      for (const sistema of TODOS) {
        const id = `pml_energia|${proceso}|${sistema}`, hechos = new Set(estado.reportes[id] || []);
        try {
          const faltan = dias(desde, hasta < limite ? hasta : limite).filter((d) => !hechos.has(d));
          let nuevos = 0;
          for (let i = 0; i < faltan.length; i += 7) {
            const semana = faltan.slice(i, i + 7), porDia = Map.groupBy(await pmlEnergia(sistema, proceso, semana[0], semana.at(-1)), (v) => v.fecha);
            for (const [fecha, horas] of porDia) {
              if (!semana.includes(fecha) || horas.length < 23) continue;  // día incompleto: se reintenta después
              const filas = horas.sort((a, b) => a.hora - b.hora).map((v) => [fecha, sistema, proceso, NODO_REF[sistema], v.hora, v.pml, v.energia, v.perdidas, v.congestion]);
              await almacen.escribir(`pml_energia/${proceso}/${fecha.slice(0, 4)}/${fecha}_${sistema}.csv.gz`,
                gzipSync(csv([['Fecha', 'Sistema', 'Mercado', 'NodoP', 'Hora', 'PML', 'Energia', 'Perdidas', 'Congestion'], ...filas])), 'application/gzip');
              hechos.add(fecha); nuevos++;
            }
          }
          estado.reportes[id] = [...hechos].sort();
          await guardarEstado();
          archivos += nuevos;
          console.log(`PML energía ${proceso} ${sistema}: ${nuevos} días nuevos`);
        } catch (e) {
          errores++;
          console.log(`PML energía ${proceso} ${sistema}: ERROR ${e.message}`);
        }
      }
    }
  }

  console.log(`Total: ${archivos} archivos, ${filasTot} filas de ofertas, ${errores} errores` + (pendientes ? `; se acabó el tiempo, faltan ${pendientes} reportes para la siguiente corrida` : ''));
  if (errores) process.exitCode = 1;
}

export { bucketR2, carpetaLocal, celdas, descargar, dias, hoyMx, INICIO, ESTADO };
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
