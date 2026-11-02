// Descarga los Contratos de Cobertura Eléctrica que publica el CENACE (tabla "Contratos
// Aceptados" de la página de abajo) y los guarda en data/contratos/contratos.json para la
// pestaña Hedge Contracts del portal. Lo ejecuta el workflow .github/workflows/contratos.yml,
// que trae el archivo anterior del bucket y sube el nuevo solo si este script termina bien.
// También a mano:
//   node scripts/fetch-contratos.mjs [--forzar]
//
// La página llena su tabla con un solo POST a ObtenerContratos, que entrega todos los
// contratos de una vez (sin paginar), así que no hace falta navegador. La respuesta no trae
// un total aparte: el "de N entradas" que muestra la página es la longitud de ese mismo
// arreglo. Por eso la integridad se revisa así, y si algo falla NO se escribe nada:
//   - todas las filas deben estar completas y con fechas reales (no se descarta ninguna);
//   - ningún folio repetido;
//   - no pueden desaparecer muchos folios respecto al archivo anterior (--forzar lo acepta,
//     para cuando la baja sea real) y la primera vez debe haber un mínimo de contratos.
// FOLIO_REAL no se guarda: el CENACE no lo muestra en su página (trae claves de participantes).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PAGINA = 'https://www.cenace.gob.mx/Paginas/SIM/ContratosCoberturaElectrica.aspx';
const FILE = path.resolve('data/contratos/contratos.json');
const COLUMNAS = ['folio', 'emisor', 'adquiriente', 'fecha_firma', 'fecha_inicio', 'fecha_fin', 'estatus'];
const MINIMO_INICIAL = 1000;  // sin archivo anterior con qué comparar (eran 1,323 en nov 2026)
const faltantesPermitidos = (n) => Math.max(10, Math.ceil(n * 0.01));

const limpio = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// dd/mm/aaaa → aaaa-mm-dd; null si no es una fecha real
function fecha(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(limpio(v));
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`, d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

async function descargar() {
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(`${PAGINA}/ObtenerContratos`, {
        method: 'POST', body: JSON.stringify({ tipoConsulta: 1 }),
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Sentinels contratos de cobertura)' },
        signal: AbortSignal.timeout(300000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // El método responde { d: "<texto JSON>" }
      const filas = JSON.parse((await res.json()).d);
      if (!Array.isArray(filas)) throw new Error('la respuesta no es una lista');
      return filas;
    } catch (e) {
      if (intento === 3) throw new Error(`Contratos: el CENACE no entregó la lista (${e.message})`);
      console.log(`Contratos: intento ${intento} falló (${e.message}); se reintenta`);
      await new Promise((r) => setTimeout(r, 30000 * intento));
    }
  }
}

function convertir(crudas) {
  const filas = crudas.map((c, i) => {
    const f = [limpio(c.FOLIO), limpio(c.EMISOR), limpio(c.ADQUIRIENTE), fecha(c.FECHA_FIRMA), fecha(c.FECHA_INICIO), fecha(c.FECHA_FIN), limpio(c.ESTATUS)];
    if (f.some((v) => !v)) throw new Error(`Contratos: la fila ${i + 1} (folio "${f[0]}") viene incompleta o con una fecha inválida; no se escribe nada`);
    return f;
  });
  const folios = new Set(filas.map((f) => f[0]));
  if (folios.size !== filas.length) throw new Error(`Contratos: ${filas.length - folios.size} folios repetidos; no se escribe nada`);
  return filas.sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]));
}

async function main() {
  const forzar = process.argv.includes('--forzar');
  let prev = null;
  try { prev = JSON.parse(await readFile(FILE, 'utf8')); } catch {}

  const filas = convertir(await descargar());
  const folios = new Set(filas.map((f) => f[0]));
  const anteriores = prev ? prev.filas : [];
  const faltan = anteriores.filter((f) => !folios.has(f[0])).length;
  const nuevos = filas.length - (anteriores.length - faltan);

  if (!forzar) {
    if (!prev && filas.length < MINIMO_INICIAL) throw new Error(`Contratos: solo llegaron ${filas.length}, se esperaban al menos ${MINIMO_INICIAL}; no se escribe nada`);
    if (prev && faltan > faltantesPermitidos(anteriores.length)) throw new Error(`Contratos: desaparecieron ${faltan} de ${anteriores.length} folios, baja sospechosa; no se escribe nada (si es real: --forzar)`);
  }

  const ahora = new Date().toISOString();
  const cambio = !prev || JSON.stringify(prev.filas) !== JSON.stringify(filas);
  const out = { fuente: PAGINA, consultado: ahora, actualizado: cambio ? ahora : prev.actualizado, total: filas.length, columnas: COLUMNAS, filas };
  // Un contrato por línea
  const txt = JSON.stringify({ ...out, filas: '@FILAS' }, null, 1)
    .replace('"@FILAS"', () => '[\n' + filas.map((f) => '  ' + JSON.stringify(f)).join(',\n') + '\n ]');
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, txt + '\n');

  const estatus = {};
  filas.forEach((f) => { estatus[f[6]] = (estatus[f[6]] || 0) + 1; });
  console.log(`Contratos: ${filas.length} (${Object.entries(estatus).map(([k, n]) => `${k} ${n}`).join(', ')}); ${nuevos} nuevos, ${faltan} desaparecidos${cambio ? '' : ', sin cambios'}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
