// Sincroniza el histórico horario de precios (data/historico, que llena el Robot
// scripts/fetch-historico.mjs) con la base Azure SQL descrita en azure/schema.sql.
// No vuelve a consultar al CENACE: sube a Azure solo las horas que aún no están ahí.
// Lo ejecuta .github/workflows/azure-sync.yml una vez al día; guía: azure/LEEME.md.
//
// Variables de entorno (GitHub → Settings → Secrets and variables → Actions):
//   AZURE_SQL_SERVER    p. ej. sentinels-mem.database.windows.net
//   AZURE_SQL_DATABASE  p. ej. sentinels-historico
//   AZURE_SQL_USER      usuario del Robot dentro de la base (no el administrador)
//   AZURE_SQL_PASSWORD
// Requiere el paquete npm "mssql" (el workflow lo instala).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('data/historico');
const { AZURE_SQL_SERVER: server, AZURE_SQL_DATABASE: database, AZURE_SQL_USER: user, AZURE_SQL_PASSWORD: password } = process.env;
const LOTE = 20000;  // filas por carga masiva

async function conectar(sql) {
  // La base gratuita se pausa sola; despertarla tarda hasta ~1 minuto (error 40613)
  for (let intento = 1; ; intento++) {
    try {
      return await sql.connect({
        server, database, user, password,
        options: { encrypt: true, trustServerCertificate: false },
        connectionTimeout: 120000, requestTimeout: 600000, pool: { max: 2, min: 0 },
      });
    } catch (e) {
      if (intento >= 5) throw e;
      console.log(`Azure SQL aún no responde (${e.code || e.message}); reintento ${intento} de 4 en 30 s…`);
      await new Promise((r) => setTimeout(r, 30000));
    }
  }
}

async function aplicarEsquema(pool) {
  const txt = await readFile(path.resolve('azure/schema.sql'), 'utf8');
  for (const bloque of txt.split(/^\s*GO\s*$/m).map((b) => b.trim()).filter((b) => b && !/^\/\*[\s\S]*\*\/$/.test(b))) {
    await pool.request().batch(bloque);
  }
}

async function main() {
  if (!server || !database || !user || !password) {
    console.log('Azure SQL no está configurado (faltan los secrets AZURE_SQL_*); no hay nada que sincronizar.');
    return;
  }
  const sql = (await import('mssql')).default;
  const indice = JSON.parse(await readFile(path.join(ROOT, 'index.json'), 'utf8'));
  const pool = await conectar(sql);
  await aplicarEsquema(pool);

  let total = 0;
  const detalle = [];
  for (const e of indice.entidades) {
    // Alta de la entidad (si no existe) y su id
    const r = await pool.request()
      .input('tipo', sql.NVarChar(4), e.tipo).input('sistema', sql.NVarChar(3), e.sistema).input('clave', sql.NVarChar(40), e.clave)
      .query(`DECLARE @t varchar(4) = @tipo, @s char(3) = @sistema, @c varchar(40) = @clave;
              IF NOT EXISTS (SELECT 1 FROM dbo.entidades WHERE tipo = @t AND sistema = @s AND clave = @c)
                INSERT dbo.entidades (tipo, sistema, clave) VALUES (@t, @s, @c);
              SELECT id FROM dbo.entidades WHERE tipo = @t AND sistema = @s AND clave = @c;`);
    const id = r.recordset[0].id;

    for (const p of ['MDA', 'MTR']) {
      const archivos = (e[p] && e[p].archivos) || [];
      if (!archivos.length) continue;
      // Lo que ya tiene Azure: se suben los días anteriores al primero y del último en adelante
      // (el último se vuelve a subir por si quedó incompleto)
      const cob = (await pool.request().input('id', sql.SmallInt, id).input('p', sql.NVarChar(3), p)
        .query(`DECLARE @pp char(3) = @p;
                SELECT CONVERT(char(10), MIN(fecha), 23) AS desde, CONVERT(char(10), MAX(fecha), 23) AS hasta
                FROM dbo.precios_hora WHERE entidad_id = @id AND proceso = @pp`)).recordset[0];
      const filas = [];
      for (const a of archivos) {
        const datos = JSON.parse(await readFile(path.join(ROOT, a), 'utf8'));
        for (const [md, h, precio, ene, per, cng] of datos.filas) {
          const fecha = `${datos.anio}-${String(Math.floor(md / 100)).padStart(2, '0')}-${String(md % 100).padStart(2, '0')}`;
          if (cob.desde && fecha >= cob.desde && fecha < cob.hasta) continue;
          filas.push([fecha, h, precio, ene, per, cng]);
        }
      }
      for (let i = 0; i < filas.length; i += LOTE) await subir(sql, pool, id, p, filas.slice(i, i + LOTE));
      total += filas.length;
      detalle.push(`${e.tipo} ${e.sistema}/${e.clave} ${p}: +${filas.length}`);
      console.log(`${e.tipo} ${e.sistema}/${e.clave} ${p}: ${filas.length} horas enviadas (Azure tenía ${cob.desde || '—'} → ${cob.hasta || '—'})`);
    }
  }

  await pool.request().input('filas', sql.Int, total).input('detalle', sql.NVarChar(4000), detalle.join('; ').slice(0, 4000))
    .query('INSERT dbo.sync_log (filas, detalle) VALUES (@filas, @detalle)');
  const cob = await pool.request().query('SELECT tipo, sistema, clave, proceso, desde, hasta, horas FROM dbo.v_cobertura ORDER BY tipo, sistema, clave, proceso');
  for (const c of cob.recordset) console.log(`Azure · ${c.tipo} ${c.sistema}/${c.clave} ${c.proceso}: ${c.desde.toISOString().slice(0, 10)} → ${c.hasta.toISOString().slice(0, 10)}, ${c.horas} horas`);
  await pool.close();
  console.log(`Listo: ${total} horas sincronizadas.`);
}

// Carga masiva a una tabla temporal y MERGE: inserta lo nuevo y corrige lo que cambió
async function subir(sql, pool, id, proceso, filas) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).batch(`CREATE TABLE #stg (fecha date NOT NULL, hora tinyint NOT NULL, precio decimal(12,2) NOT NULL,
      energia decimal(12,2) NULL, perdidas decimal(12,2) NULL, congestion decimal(12,2) NULL)`);
    const t = new sql.Table('#stg');
    t.create = false;
    t.columns.add('fecha', sql.Date, { nullable: false });
    t.columns.add('hora', sql.TinyInt, { nullable: false });
    for (const c of ['precio', 'energia', 'perdidas', 'congestion']) t.columns.add(c, sql.Decimal(12, 2), { nullable: c !== 'precio' });
    for (const [fecha, h, precio, ene, per, cng] of filas) t.rows.add(new Date(fecha + 'T00:00:00Z'), h, precio, ene, per, cng);
    await new sql.Request(tx).bulk(t);
    // query() (sp_executesql) and not batch(): batch() ignores parameters. #stg was created
    // earlier on this same connection, so it is visible here.
    await new sql.Request(tx).input('id', sql.SmallInt, id).input('proc', sql.NVarChar(3), proceso).query(`
      DECLARE @p char(3) = @proc;
      MERGE dbo.precios_hora WITH (HOLDLOCK) AS d
      USING #stg AS s ON d.entidad_id = @id AND d.proceso = @p AND d.fecha = s.fecha AND d.hora = s.hora
      WHEN MATCHED AND (d.precio <> s.precio OR ISNULL(d.energia, -1e9) <> ISNULL(s.energia, -1e9)
                        OR ISNULL(d.perdidas, -1e9) <> ISNULL(s.perdidas, -1e9) OR ISNULL(d.congestion, -1e9) <> ISNULL(s.congestion, -1e9))
        THEN UPDATE SET precio = s.precio, energia = s.energia, perdidas = s.perdidas, congestion = s.congestion
      WHEN NOT MATCHED BY TARGET
        THEN INSERT (entidad_id, proceso, fecha, hora, precio, energia, perdidas, congestion)
             VALUES (@id, @p, s.fecha, s.hora, s.precio, s.energia, s.perdidas, s.congestion);
      DROP TABLE #stg;`);
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
