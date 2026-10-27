// Robot masivo del histórico de precios (Market Prices · "Long-term history").
// Carga el histórico horario desde 2020 de TODOS los NodosP (SW-PML) y Zonas de Carga
// (SW-PEND) del catálogo (data/nodos/catalogo.json) en Azure SQL (azure/schema.sql), y
// publica para el portal un resumen por NodoP / zona en data/resumen. Lo ejecuta
// .github/workflows/historico-masivo.yml una vez al día; guía: azure/LEEME.md.
//
//   node scripts/historico-masivo.mjs [--minutos-cenace 240] [--llamadas 20000]
//
// La base gratuita gasta cómputo todo el tiempo que está despierta, así que el Robot:
//   1. CENACE → disco: baja hasta 20 NodosP / 10 zonas por llamada y por semana, sin tocar
//      Azure. Primero los días nuevos de todos; después el histórico, de lo reciente hacia 2020.
//   2. Una sola sesión en Azure: carga masiva (solo horas que no estén), recalcula los
//      resúmenes (agg_mensual, agg_hora_mes) de los meses tocados y lee lo que se exporta.
//   3. data/resumen/<nodo|zona>/<sistema>/<clave>.json: meses cerrados (que ya tienen MTR,
//      7 días después de terminar) con promedio, componentes, máximo y mínimo con su fecha y
//      hora, y el perfil horario por año. Se reescriben solo al cerrar un mes o al cargar
//      historia nueva, para que el repositorio no crezca de más.
// El avance vive en data/resumen/estado.json y solo se guarda si la carga en Azure terminó;
// si algo falla, la siguiente corrida repite esas semanas (la carga ignora horas repetidas).

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const OUT = path.resolve('data/resumen');
const ESTADO = path.join(OUT, 'estado.json');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) || d : d; };
const MIN_CENACE = arg('--minutos-cenace', 240), MAX_LLAMADAS = arg('--llamadas', 20000);
const PARALELO = 3, LOTE = 100000, VACIOS_FIN = 8;
const DESDE = '2020-01-01';  // alcance del histórico

const SERVICIO = {
  nodo: { url: 'https://ws01.cenace.gob.mx:8082/SWPML/SIM', max: 20, clave: 'clv_nodo', campos: ['pml', 'pml_ene', 'pml_per', 'pml_cng'] },
  zona: { url: 'https://ws01.cenace.gob.mx:8082/SWPEND/SIM', max: 10, clave: 'zona_carga', campos: ['pz', 'pz_ene', 'pz_per', 'pz_cng'] },
};
const PROC = ['MDA', 'MTR'];

const hoyMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const sumar = (f, n) => new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const menor = (a, b) => (a < b ? a : b), mayor = (a, b) => (a > b ? a : b);
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
const slug = (s) => s.replace(/ /g, '-');
const ultimoDe = (p) => (p === 'MDA' ? sumar(hoyMX(), 1) : sumar(hoyMX(), -7));
// Último mes cerrado: su último día ya tiene MDA y MTR publicados (MTR llega 7 días después)
function ultimoMesCerrado() {
  const corte = sumar(hoyMX(), -8), d = new Date(sumar(corte, 1) + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/* ── Entidades y avance ───────────────────────── */
async function entidades() {
  const c = JSON.parse(await readFile(path.resolve('data/nodos/catalogo.json'), 'utf8'));
  const ix = Object.fromEntries(c.columnas.map((k, i) => [k, i]));
  const out = new Map();
  for (const r of c.nodos) {
    out.set(`nodo|${r[ix.sistema]}|${r[ix.clave]}`, { tipo: 'nodo', sistema: r[ix.sistema], clave: r[ix.clave] });
    const z = r[ix.zona_carga];
    if (z && z !== 'No Aplica') out.set(`zona|${r[ix.sistema]}|${z}`, { tipo: 'zona', sistema: r[ix.sistema], clave: z });
  }
  return out;
}
// estado.entidades[key][proceso] = [desde, hasta, completo(0/1), vacíos]
async function leerEstado() {
  try { return JSON.parse(await readFile(ESTADO, 'utf8')); } catch { return { desde: DESDE, ultimo_mes_exportado: null, entidades: {} }; }
}

// Siguiente semana de una entidad-proceso: primero lo nuevo, luego hacia atrás hasta 2020
function siguiente(st, p) {
  const ultimo = ultimoDe(p);
  if (st.hasta && st.hasta < ultimo && !st.sinNuevos) { const ini = sumar(st.hasta, 1); return { dir: 'adelante', ini, fin: menor(sumar(ini, 6), ultimo) }; }
  if (st.completo) return null;
  const fin = st.desde ? sumar(st.desde, -1) : ultimo;
  if (fin < DESDE) { st.completo = true; return null; }
  return { dir: 'atras', ini: mayor(sumar(fin, -6), DESDE), fin };
}
function aplicar(st, p, v, fechas) {
  if (v.dir === 'adelante') {
    if (fechas.length) st.hasta = mayor(st.hasta, fechas.at(-1));
    else if (v.fin < sumar(ultimoDe(p), -2)) st.hasta = v.fin;  // hueco del CENACE: no atorarse
    else st.sinNuevos = true;                                    // aún no se publica
    return;
  }
  st.desde = v.ini;
  if (!st.hasta && fechas.length) st.hasta = fechas.at(-1);
  if (fechas.length) st.vacios = 0;
  else if (st.hasta && ++st.vacios >= VACIOS_FIN) st.completo = true;  // no existía antes
  if (v.ini <= DESDE) st.completo = true;
}

/* ── Fase 1: CENACE → disco ───────────────────── */
async function consultar(tipo, sistema, p, claves, ini, fin) {
  const s = SERVICIO[tipo];
  const url = `${s.url}/${sistema}/${p}/${claves.map((c) => encodeURIComponent(slug(c))).join(',')}/${ini.replace(/-/g, '/')}/${fin.replace(/-/g, '/')}/JSON`;
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (res.status === 204 || res.status === 404) return new Map();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const [cp, ce, cl, cc] = s.campos, out = new Map();
      for (const r of body.Resultados || []) {
        const k0 = String(r[s.clave] || '').toUpperCase(), k = tipo === 'zona' ? k0.replace(/-/g, ' ') : k0;  // zonas: "LOS-CABOS" = "LOS CABOS"
        out.set(k, (r.Valores || []).map((v) => [v.fecha, Number(v.hora), num(v[cp]), num(v[ce]), num(v[cl]), num(v[cc])]).filter((x) => x[2] != null));
      }
      return out;
    } catch (err) {
      if (intento >= 3) throw new Error(`${tipo} ${sistema} ${p} ${ini}…${fin} (${claves.length}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 10000 * intento));
    }
  }
}

async function descargar(ents, estado, archivo) {
  const t0 = Date.now(), salida = createWriteStream(archivo);
  const st = new Map();  // `${key}|${p}` → estado vivo
  for (const [key] of ents) for (const p of PROC) {
    const [desde, hasta, completo, vacios] = (estado.entidades[key] || {})[p] || [];
    st.set(`${key}|${p}`, { key, p, desde: desde || null, hasta: hasta || null, completo: !!completo, vacios: vacios || 0 });
  }
  let llamadas = 0, filas = 0, errores = 0;
  while (llamadas < MAX_LLAMADAS && Date.now() - t0 < MIN_CENACE * 60000) {
    // Agrupa las entidades que necesitan la misma semana del mismo servicio, sistema y mercado
    const grupos = new Map();
    for (const s of st.values()) {
      if (s.pausa) continue;
      const v = siguiente(s, s.p);
      if (!v) continue;
      const e = ents.get(s.key), g = `${e.tipo}|${e.sistema}|${s.p}|${v.dir}|${v.ini}|${v.fin}`;
      if (!grupos.has(g)) grupos.set(g, { e, p: s.p, v, miembros: [] });
      grupos.get(g).miembros.push(s);
    }
    if (!grupos.size) break;
    // Lo nuevo primero; luego lo más reciente del histórico
    const tareas = [];
    for (const g of [...grupos.values()].sort((a, b) => (a.v.dir !== b.v.dir ? (a.v.dir === 'adelante' ? -1 : 1) : a.v.fin < b.v.fin ? 1 : -1))) {
      for (let i = 0; i < g.miembros.length; i += SERVICIO[g.e.tipo].max) tareas.push({ ...g, miembros: g.miembros.slice(i, i + SERVICIO[g.e.tipo].max) });
    }
    // Una ronda = una semana por entidad; luego se reagrupa
    for (let i = 0; i < tareas.length && llamadas < MAX_LLAMADAS && Date.now() - t0 < MIN_CENACE * 60000; i += PARALELO) {
      const lote = tareas.slice(i, i + PARALELO);
      llamadas += lote.length;
      await Promise.all(lote.map(async (t) => {
        const claves = t.miembros.map((m) => ents.get(m.key).clave);
        try {
          const res = await consultar(t.e.tipo, t.e.sistema, t.p, claves, t.v.ini, t.v.fin);
          for (const m of t.miembros) {
            const vals = res.get(ents.get(m.key).clave.toUpperCase()) || [];
            for (const v of vals) salida.write(`${m.key}\t${PROC.indexOf(t.p) + 1}\t${v.join('\t')}\n`);
            filas += vals.length;
            aplicar(m, t.p, t.v, vals.map((v) => v[0]).sort());
          }
        } catch (err) {
          errores++; console.error(err.message);
          for (const m of t.miembros) m.pausa = true;  // se reintenta en la siguiente corrida
        }
      }));
      if (llamadas % 300 < PARALELO) console.log(`… ${llamadas} llamadas, ${filas.toLocaleString('en-US')} horas, ${Math.round((Date.now() - t0) / 60000)} min`);
    }
  }
  await new Promise((r) => salida.end(r));
  console.log(`CENACE: ${llamadas} llamadas, ${filas.toLocaleString('en-US')} horas en ${Math.round((Date.now() - t0) / 60000)} min${errores ? `, ${errores} con error` : ''}`);
  return { st, filas, llamadas, errores };
}

/* ── Fase 2: una sesión en Azure ───────────────── */
async function conectar(sql) {
  const config = {
    server: process.env.AZURE_SQL_SERVER, database: process.env.AZURE_SQL_DATABASE,
    user: process.env.AZURE_SQL_USER, password: process.env.AZURE_SQL_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 120000, requestTimeout: 3600000,
    pool: { max: 1, min: 0 },  // una sola conexión: las tablas #temporales viven en ella
  };
  for (let intento = 1; ; intento++) {
    try { return await new sql.ConnectionPool(config).connect(); }
    catch (e) {
      if (intento >= 6) throw e;
      console.log(`Azure SQL aún no responde (${e.code || e.message}); reintento ${intento} de 5 en 30 s…`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

async function cargarAzure(sql, pool, ents, archivo) {
  const txt = await readFile(path.resolve('azure/schema.sql'), 'utf8');
  for (const b of txt.split(/^\s*GO\s*$/m).map((x) => x.trim()).filter((x) => x && !/^\/\*[\s\S]*\*\/$/.test(x))) await pool.request().batch(b);

  // Alta de entidades nuevas (textos como JSON nvarchar: sin problemas de intercalación)
  const lista = [...ents.values()].map((e) => [e.tipo, e.sistema, e.clave]);
  const r = await pool.request().input('json', sql.NVarChar(sql.MAX), JSON.stringify(lista)).query(`
    DECLARE @j nvarchar(max) = @json;
    MERGE dbo.entidades AS d
    USING (SELECT tipo, sistema, clave FROM OPENJSON(@j) WITH (tipo varchar(4) '$[0]', sistema char(3) '$[1]', clave varchar(40) '$[2]')) AS s
      ON d.tipo = s.tipo AND d.sistema = s.sistema AND d.clave = s.clave
    WHEN NOT MATCHED THEN INSERT (tipo, sistema, clave) VALUES (s.tipo, s.sistema, s.clave);
    SELECT id, tipo, sistema, clave FROM dbo.entidades;`);
  const ids = new Map(r.recordset.map((x) => [`${x.tipo}|${x.sistema.trim()}|${x.clave}`, x.id]));

  await pool.request().batch(`
    IF OBJECT_ID('tempdb..#stg') IS NOT NULL DROP TABLE #stg;
    IF OBJECT_ID('tempdb..#tocados') IS NOT NULL DROP TABLE #tocados;
    CREATE TABLE #stg (entidad_id smallint NOT NULL, mercado tinyint NOT NULL, fecha date NOT NULL, hora tinyint NOT NULL,
      precio decimal(12,2) NOT NULL, energia decimal(12,2) NULL, perdidas decimal(12,2) NULL, congestion decimal(12,2) NULL);
    CREATE TABLE #tocados (entidad_id smallint NOT NULL, proceso char(3) NOT NULL, mes date NOT NULL, PRIMARY KEY (entidad_id, proceso, mes));`);

  let insertadas = 0, leidas = 0;
  const subir = async (filas) => {
    const t = new sql.Table('#stg');
    t.create = false;
    t.columns.add('entidad_id', sql.SmallInt, { nullable: false });
    t.columns.add('mercado', sql.TinyInt, { nullable: false });
    t.columns.add('fecha', sql.Date, { nullable: false });
    t.columns.add('hora', sql.TinyInt, { nullable: false });
    for (const c of ['precio', 'energia', 'perdidas', 'congestion']) t.columns.add(c, sql.Decimal(12, 2), { nullable: c !== 'precio' });
    for (const f of filas) t.rows.add(...f);
    await pool.request().bulk(t);
    const q = await pool.request().query(`
      INSERT dbo.precios_hora (entidad_id, proceso, fecha, hora, precio, energia, perdidas, congestion)
      SELECT s.entidad_id, CASE s.mercado WHEN 1 THEN 'MDA' ELSE 'MTR' END, s.fecha, s.hora, s.precio, s.energia, s.perdidas, s.congestion
      FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY entidad_id, mercado, fecha, hora ORDER BY (SELECT 0)) AS rn FROM #stg) s
      WHERE s.rn = 1 AND NOT EXISTS (SELECT 1 FROM dbo.precios_hora p WHERE p.entidad_id = s.entidad_id
        AND p.proceso = CASE s.mercado WHEN 1 THEN 'MDA' ELSE 'MTR' END AND p.fecha = s.fecha AND p.hora = s.hora);
      SELECT @@ROWCOUNT AS n;
      INSERT #tocados (entidad_id, proceso, mes)
      SELECT DISTINCT s.entidad_id, CASE s.mercado WHEN 1 THEN 'MDA' ELSE 'MTR' END, DATEFROMPARTS(YEAR(s.fecha), MONTH(s.fecha), 1)
      FROM #stg s WHERE NOT EXISTS (SELECT 1 FROM #tocados t WHERE t.entidad_id = s.entidad_id
        AND t.proceso = CASE s.mercado WHEN 1 THEN 'MDA' ELSE 'MTR' END AND t.mes = DATEFROMPARTS(YEAR(s.fecha), MONTH(s.fecha), 1));
      TRUNCATE TABLE #stg;`);
    insertadas += q.recordset[0].n;
  };

  let buf = [];
  for await (const linea of createInterface({ input: createReadStream(archivo) })) {
    if (!linea) continue;
    const [key, proc, fecha, hora, p, e, l, c] = linea.split('\t');
    const id = ids.get(key);
    if (!id) continue;
    const n = (x) => (x === '' ? null : Number(x));
    buf.push([id, Number(proc), new Date(fecha + 'T00:00:00Z'), Number(hora), Number(p), n(e), n(l), n(c)]);
    leidas++;
    if (buf.length >= LOTE) { await subir(buf); buf = []; }
  }
  if (buf.length) await subir(buf);
  console.log(`Azure: ${leidas.toLocaleString('en-US')} horas leídas, ${insertadas.toLocaleString('en-US')} nuevas`);

  // Resúmenes: se recalculan solo los meses tocados (lo materializado de las Views)
  await pool.request().batch(`
    DELETE a FROM dbo.agg_mensual a JOIN #tocados t ON a.entidad_id = t.entidad_id AND a.proceso = t.proceso AND a.mes = t.mes;
    WITH base AS (
      SELECT p.entidad_id, p.proceso, t.mes, p.fecha, p.hora, p.precio, p.energia, p.perdidas, p.congestion
      FROM #tocados t JOIN dbo.precios_hora p
        ON p.entidad_id = t.entidad_id AND p.proceso = t.proceso AND p.fecha >= t.mes AND p.fecha < DATEADD(month, 1, t.mes)
    ), r AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY entidad_id, proceso, mes ORDER BY precio DESC, fecha, hora) AS rmax,
                ROW_NUMBER() OVER (PARTITION BY entidad_id, proceso, mes ORDER BY precio ASC, fecha, hora) AS rmin
      FROM base
    )
    INSERT dbo.agg_mensual (entidad_id, proceso, mes, horas, suma_precio, suma_energia, suma_perdidas, suma_congestion,
                            max_precio, max_fecha, max_hora, min_precio, min_fecha, min_hora)
    SELECT entidad_id, proceso, mes, COUNT(*), SUM(precio), SUM(energia), SUM(perdidas), SUM(congestion),
           MAX(CASE WHEN rmax = 1 THEN precio END), MAX(CASE WHEN rmax = 1 THEN fecha END), MAX(CASE WHEN rmax = 1 THEN hora END),
           MAX(CASE WHEN rmin = 1 THEN precio END), MAX(CASE WHEN rmin = 1 THEN fecha END), MAX(CASE WHEN rmin = 1 THEN hora END)
    FROM r GROUP BY entidad_id, proceso, mes;

    DELETE a FROM dbo.agg_hora_mes a JOIN #tocados t ON a.entidad_id = t.entidad_id AND a.proceso = t.proceso AND a.mes = t.mes;
    INSERT dbo.agg_hora_mes (entidad_id, proceso, mes, hora, dias, suma_precio)
    SELECT p.entidad_id, p.proceso, t.mes, p.hora, COUNT(*), SUM(p.precio)
    FROM #tocados t JOIN dbo.precios_hora p
      ON p.entidad_id = t.entidad_id AND p.proceso = t.proceso AND p.fecha >= t.mes AND p.fecha < DATEADD(month, 1, t.mes)
    GROUP BY p.entidad_id, p.proceso, t.mes, p.hora;`);
  const tocados = (await pool.request().query('SELECT entidad_id, CONVERT(char(7), mes, 120) AS mes FROM #tocados')).recordset;
  console.log(`Azure: resúmenes recalculados para ${tocados.length.toLocaleString('en-US')} meses`);
  return { ids, tocados, insertadas };
}

/* ── Fase 3: resúmenes para el portal ─────────── */
async function exportar(sql, pool, ents, ids, idsExportar, hastaMes) {
  const porId = new Map([...ids].map(([k, id]) => [id, k]));
  const lista = [...idsExportar];
  let escritos = 0;
  for (let i = 0; i < lista.length; i += 300) {
    const parte = JSON.stringify(lista.slice(i, i + 300));
    const req = () => pool.request().input('json', sql.NVarChar(sql.MAX), parte).input('d', sql.Date, new Date(DESDE + 'T00:00:00Z')).input('h', sql.Date, new Date(hastaMes + '-01T00:00:00Z'));
    const meses = (await req().query(`
      DECLARE @ids nvarchar(max) = @json;
      SELECT a.entidad_id, a.proceso, CONVERT(char(7), a.mes, 120) AS mes, a.horas,
             CAST(a.suma_precio / a.horas AS decimal(12,2)) AS p, CAST(a.suma_energia / a.horas AS decimal(12,2)) AS e,
             CAST(a.suma_perdidas / a.horas AS decimal(12,2)) AS l, CAST(a.suma_congestion / a.horas AS decimal(12,2)) AS c,
             a.max_precio, CONVERT(char(10), a.max_fecha, 23) AS max_fecha, a.max_hora,
             a.min_precio, CONVERT(char(10), a.min_fecha, 23) AS min_fecha, a.min_hora
      FROM dbo.agg_mensual a JOIN OPENJSON(@ids) j ON a.entidad_id = CAST(j.value AS smallint)
      WHERE a.mes >= @d AND a.mes <= @h ORDER BY a.entidad_id, a.proceso, a.mes`)).recordset;
    const perfil = (await req().query(`
      DECLARE @ids nvarchar(max) = @json;
      SELECT a.entidad_id, a.proceso, YEAR(a.mes) AS anio, a.hora, CAST(SUM(a.suma_precio) / SUM(a.dias) AS decimal(12,2)) AS p
      FROM dbo.agg_hora_mes a JOIN OPENJSON(@ids) j ON a.entidad_id = CAST(j.value AS smallint)
      WHERE a.mes >= @d AND a.mes <= @h GROUP BY a.entidad_id, a.proceso, YEAR(a.mes), a.hora`)).recordset;

    const docs = new Map();
    const doc = (id) => {
      if (!docs.has(id)) { const e = ents.get(porId.get(id)); docs.set(id, { tipo: e.tipo, sistema: e.sistema, clave: e.clave, desde: DESDE.slice(0, 7), hasta_mes: hastaMes, MDA: { meses: [], perfil: {} }, MTR: { meses: [], perfil: {} } }); }
      return docs.get(id);
    };
    const N = (v) => (v == null ? null : Number(v));
    for (const m of meses) {
      if (!porId.has(m.entidad_id) || !ents.has(porId.get(m.entidad_id))) continue;
      doc(m.entidad_id)[m.proceso].meses.push([m.mes, m.horas, N(m.p), N(m.e), N(m.l), N(m.c), N(m.max_precio), m.max_fecha, m.max_hora, N(m.min_precio), m.min_fecha, m.min_hora]);
    }
    for (const x of perfil) {
      if (!porId.has(x.entidad_id) || !ents.has(porId.get(x.entidad_id))) continue;
      const pf = doc(x.entidad_id)[x.proceso].perfil;
      (pf[x.anio] ??= Array(24).fill(null))[x.hora - 1] = N(x.p);
    }
    for (const d of docs.values()) {
      const f = path.join(OUT, d.tipo, d.sistema, slug(d.clave) + '.json');
      const txt = JSON.stringify(d) + '\n';
      if ((await readFile(f, 'utf8').catch(() => '')) === txt) continue;
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, txt);
      escritos++;
    }
  }
  console.log(`Portal: ${escritos} resúmenes actualizados (meses hasta ${hastaMes})`);
}

/* ── Principal ──────────────────────────────────── */
async function main() {
  const az = ['AZURE_SQL_SERVER', 'AZURE_SQL_DATABASE', 'AZURE_SQL_USER', 'AZURE_SQL_PASSWORD'];
  if (az.some((k) => !process.env[k])) { console.log('Azure SQL no está configurado (faltan los secrets AZURE_SQL_*): no se descarga nada.'); return; }
  const ents = await entidades(), estado = await leerEstado();
  const archivo = path.join(os.tmpdir(), `historico-${Date.now()}.tsv`);
  const { st, filas, errores, llamadas } = await descargar(ents, estado, archivo);
  const hastaMes = ultimoMesCerrado();
  const exportarTodo = estado.ultimo_mes_exportado !== hastaMes;  // cerró un mes: todos cambian
  if (!filas && !exportarTodo) { console.log('Nada nuevo que cargar.'); await rm(archivo, { force: true }); return; }

  const sql = (await import('mssql')).default;
  const pool = await conectar(sql);
  try {
    const { ids, tocados } = await cargarAzure(sql, pool, ents, archivo);
    // Se exporta: todo cuando cierra un mes; si no, solo quien recibió historia de meses cerrados
    const idsExportar = new Set(exportarTodo ? [...ents.keys()].map((k) => ids.get(k)).filter(Boolean)
      : tocados.filter((t) => t.mes <= hastaMes).map((t) => t.entidad_id));
    await exportar(sql, pool, ents, ids, idsExportar, hastaMes);
  } finally {
    await pool.close();
    await rm(archivo, { force: true });
  }

  // Guardar el avance (solo si Azure terminó bien) e índice para el portal
  const ent = {};
  for (const s of st.values()) (ent[s.key] ??= {})[s.p] = [s.desde, s.hasta, s.completo ? 1 : 0, s.vacios];
  const cargadas = [...st.values()].filter((s) => s.completo || (s.desde && s.desde <= DESDE)).length;
  await mkdir(OUT, { recursive: true });
  await writeFile(ESTADO, JSON.stringify({ desde: DESDE, ultimo_mes_exportado: hastaMes, actualizado: new Date().toISOString(), entidades: ent }) + '\n');
  // Fecha desde la que TODAS las entidades (salvo las que no existían) ya tienen histórico
  const comun = (p) => [...st.values()].filter((s) => s.p === p && s.desde && !s.completo).reduce((m, s) => mayor(m, s.desde), DESDE);
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({
    actualizado: new Date().toISOString(), desde: DESDE, hasta_mes: hastaMes, entidades: ents.size,
    avance: Math.floor(cargadas / st.size * 100), cargado_desde: { MDA: comun('MDA'), MTR: comun('MTR') },
  }, null, 1) + '\n');
  console.log(`Avance: ${cargadas} de ${st.size} entidad-mercado completas desde ${DESDE} (${Math.floor(cargadas / st.size * 100)}%); ${llamadas} llamadas${errores ? `, ${errores} con error` : ''}`);
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
