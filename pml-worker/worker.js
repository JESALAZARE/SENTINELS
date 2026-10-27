/* ── Sentinels · PML Cloudflare Worker ───────────────────────────────
   On-demand proxy to CENACE's public price web services so the Market
   Prices tab can query ANY NodoP (SW-PML) or load zone / distributed node
   (SW-PEND) of the catalog. The browser can't call them directly (no CORS
   headers, port 8082), so this Worker:
   - accepts only GET requests from the site's origins (ALLOWED_ORIGINS);
   - validates the query and caps it at 31 days and 20 NodosP / 10 load zones;
   - splits it into the 7-day windows CENACE allows and fetches them in parallel;
   - caches every window in Cloudflare's cache (published days for a week,
     days that may still change for 30 minutes), so CENACE sees few calls;
   - returns numbers, always in the row shape of /data/pml/<sistema>/<nodo>.json
     ({ fecha, hora, pml, pml_ene, pml_per, pml_cng }; for load zones the PEND
     "pz" fields are mapped to the same names).

     GET /pml?sistema=SIN&proceso=MDA&nodos=06CDU-400&desde=2026-10-01&hasta=2026-10-26
     GET /pend?sistema=BCS&proceso=MDA&zonas=LOS CABOS,LA PAZ&desde=2026-10-01&hasta=2026-10-26
     GET /demanda?gerencia=10 (today's hourly demand, generation and forecast of a system or
                               region, from CENACE's "Operación del SEN" page; cached 5 minutes;
                               previa = hour 24 of the previous day when CENACE sends it)
     GET /health              (?cenace=1 also checks that CENACE answers)

   Configure in Cloudflare (Settings → Variables and Secrets):
     ALLOWED_ORIGINS  text — https://sentinels.com.mx
   No secrets or storage are needed: SW-PML and SW-PEND are public. Plain fetch() so the
   file can be pasted into the Cloudflare dashboard editor (no build step).
   Setup steps: pml-worker/LEEME.md */

const MAX_DAYS = 31;
// SW-PML: NodosP by key (06CDU-400). SW-PEND: load zones by name; spaces go as "-" in the URL.
const SERVICES = {
  pml: { url: 'https://ws01.cenace.gob.mx:8082/SWPML/SIM', label: 'SW-PML', param: 'nodos', max: 20, key: 'clv_nodo', what: 'NodoP keys',
    fields: ['pml', 'pml_ene', 'pml_per', 'pml_cng'],
    clean: s => s.trim().toUpperCase(), valid: s => /^[0-9A-Z][0-9A-Z.-]{1,19}$/.test(s), toPath: s => s },
  pend: { url: 'https://ws01.cenace.gob.mx:8082/SWPEND/SIM', label: 'SW-PEND', param: 'zonas', max: 10, key: 'zona_carga', what: 'load zone names',
    fields: ['pz', 'pz_ene', 'pz_per', 'pz_cng'],
    clean: s => s.trim().toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' '), valid: s => /^[0-9A-Z][0-9A-Z. ]{1,39}$/.test(s), toPath: s => s.replace(/ /g, '-') }
};
// First operating day with published prices (SW-PML technical manual)
const FIRST = { MDA: { SIN: '2016-01-29', BCA: '2016-01-27', BCS: '2016-03-23' }, MTR: { SIN: '2017-01-27', BCA: '2017-01-27', BCS: '2017-01-27' } };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://sentinels.com.mx').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const json = (obj, status = 200, cache = 'no-store') =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache } });

    try {
      if (url.pathname === '/health') {
        if (!url.searchParams.has('cenace')) return json({ ok: true, service: 'sentinels-pml' });
        // Setup check: can this Worker reach SW-PML (port 8082)? One cached day of one NodoP.
        const y = addDays(todayMX(), -1), t0 = Date.now();
        try {
          const r = await fetchWindow(SERVICES.pml, { sistema: 'SIN', proceso: 'MDA', items: ['06CDU-400'] }, y, y, ctx);
          const hours = (r[0] && r[0].Valores || []).length;
          return json({ ok: hours > 0, service: 'sentinels-pml', cenace: hours > 0 ? 'reachable' : 'no data', day: y, hours, ms: Date.now() - t0 });
        } catch (e) {
          return json({ ok: false, service: 'sentinels-pml', cenace: 'unreachable', error: String(e.message || e) }, 502);
        }
      }
      if (!allowed.includes(origin)) return json({ error: 'forbidden', message: 'Origin not allowed.' }, 403);
      if (url.pathname === '/demanda' && request.method === 'GET') return json(await demanda(url.searchParams, ctx), 200, 'public, max-age=120');
      const svc = Object.hasOwn(SERVICES, url.pathname.slice(1)) ? SERVICES[url.pathname.slice(1)] : null;
      if (request.method !== 'GET' || !svc) return json({ error: 'not_found' }, 404);

      const q = parse(url.searchParams, svc);
      const windows = [];
      for (let ini = q.desde; ini <= q.hasta; ini = addDays(ini, 7)) windows.push([ini, minDate(addDays(ini, 6), q.hasta)]);
      const parts = await Promise.all(windows.map(([a, b]) => fetchWindow(svc, q, a, b, ctx)));

      const out = Object.fromEntries(q.items.map(n => [n, []])), row = rowOf(svc);
      for (const res of parts) for (const r of res) {
        const k = svc.clean(String(r[svc.key] || ''));
        if (out[k]) out[k].push(...(r.Valores || []).map(row));
      }
      for (const n of q.items) out[n].sort((a, b) => a.fecha === b.fecha ? a.hora - b.hora : a.fecha < b.fecha ? -1 : 1);
      // Browsers may reuse the answer briefly; Cloudflare's cache holds the CENACE windows
      return json({ sistema: q.sistema, proceso: q.proceso, desde: q.desde, hasta: q.hasta, unidades: '$/MWh', fuente: 'CENACE ' + svc.label, [svc.param]: out }, 200, 'public, max-age=300');
    } catch (e) {
      if (e.status) return json({ error: e.code || 'error', message: e.message }, e.status);
      console.error(e);
      return json({ error: 'upstream', message: 'CENACE did not answer. Please try again later.' }, 502);
    }
  }
};

/* ── Query ─────────────────────────────────────── */
function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (f, n) => new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const minDate = (a, b) => a < b ? a : b;
const todayMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

function parse(p, svc) {
  const sistema = p.get('sistema'), proceso = p.get('proceso');
  if (!['SIN', 'BCA', 'BCS'].includes(sistema)) throw fail(400, 'bad_request', 'sistema must be SIN, BCA or BCS.');
  if (!['MDA', 'MTR'].includes(proceso)) throw fail(400, 'bad_request', 'proceso must be MDA or MTR.');
  const items = [...new Set(String(p.get(svc.param) || '').split(',').map(svc.clean).filter(Boolean))];
  if (!items.length || items.length > svc.max || !items.every(svc.valid)) {
    throw fail(400, 'bad_request', `${svc.param} must list 1 to ${svc.max} ${svc.what}.`);
  }
  let desde = p.get('desde'), hasta = p.get('hasta');
  if (!ISO.test(desde || '') || !ISO.test(hasta || '') || desde > hasta) throw fail(400, 'bad_request', 'desde and hasta must be dates (YYYY-MM-DD), desde ≤ hasta.');
  // Published range: MDA up to tomorrow, MTR up to 7 days ago
  const last = proceso === 'MDA' ? addDays(todayMX(), 1) : addDays(todayMX(), -7);
  desde = desde < FIRST[proceso][sistema] ? FIRST[proceso][sistema] : desde;
  hasta = minDate(hasta, last);
  if (desde > hasta) throw fail(422, 'not_published', `${proceso} prices are not published for those dates.`);
  if ((Date.parse(hasta) - Date.parse(desde)) / 864e5 + 1 > MAX_DAYS) throw fail(400, 'too_long', `Query at most ${MAX_DAYS} days at a time.`);
  return { sistema, proceso, items: items.sort(), desde, hasta };
}

/* ── CENACE windows (cached) ───────────────────── */
async function fetchWindow(svc, q, a, b, ctx) {
  const path = `${q.sistema}/${q.proceso}/${q.items.map(svc.toPath).join(',')}/${a.replace(/-/g, '/')}/${b.replace(/-/g, '/')}/JSON`;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://sentinels-pml.cache/${svc.param}/${path}`);
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }

  const res = await fetch(`${svc.url}/${path}`, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (res.status === 204 || res.status === 404) return [];
  if (!res.ok) throw new Error(`${svc.label} HTTP ${res.status}`);
  const body = await res.json();
  if (body.status && body.status !== 'OK') return [];
  const out = body.Resultados || [];

  // Windows that end before yesterday are final; recent ones may still be published or revised
  const ttl = b < addDays(todayMX(), -1) ? 7 * 86400 : 1800;
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })));
  return out;
}

/* ── SEN demand (Operación del SEN) ────────────── */
// gerencia: 10 = SIN, 1 = Baja California, 2 = Baja California Sur, 3–9 = SIN regions
const GERENCIAS = { 10: 'Sistema Interconectado Nacional', 1: 'Baja California', 2: 'Baja California Sur', 3: 'Central',
  4: 'Noreste', 5: 'Noroeste', 6: 'Norte', 7: 'Occidental', 8: 'Oriental', 9: 'Peninsular' };
const DEMANDA_URL = 'https://www.cenace.gob.mx/Paginas/SIM/OperacionSEN.aspx/obtieneValoresTotal';
const DEMANDA_TTL = 300;  // CENACE publishes one point per hour; 5 minutes keeps the widget current
const DEMANDA_SETTLE = 15 * 60 * 1000;  // how long a rewrite of published hours must last to be accepted

async function demanda(p, ctx) {
  const g = String(p.get('gerencia') || '10');
  if (!Object.hasOwn(GERENCIAS, g)) throw fail(400, 'bad_request', 'gerencia must be 1 to 10.');
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`https://sentinels-pml.cache/demanda/${g}`);
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }

  const res = await fetch(DEMANDA_URL, {
    method: 'POST', body: JSON.stringify({ gerencia: g }),
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`OperacionSEN HTTP ${res.status}`);
  // The page method answers { d: "<JSON text>" }; d is "" while CENACE has no data yet
  const d = (await res.json()).d;
  const rows = d ? JSON.parse(d) : [];
  const all = rows.map(r => ({ hora: Number(r.hora), demanda: num(r.valorDemanda), generacion: num(r.valorGeneracion), pronostico: num(r.valorPronostico) }))
    .filter(r => r.hora >= 1 && r.hora <= 25);
  // Rows come in time order; some regions start with hour 24 of the previous day, which
  // goes apart (previa) so it doesn't take the place of today's hour 24
  const first = all.findIndex(r => r.hora === 1);
  const previa = first > 0 ? all[first - 1] : null;
  const horas = all.slice(Math.max(0, first));
  const out = { gerencia: Number(g), nombre: GERENCIAS[g], fecha: todayMX(), unidades: 'MW', fuente: 'CENACE · Operación del SEN', consultado: new Date(Date.now()).toISOString(), previa, horas };

  // While CENACE publishes a new hour it can briefly answer different values for hours it had
  // already published. The last good answer is kept a day; an answer that rewrites published
  // hours is held back (the good one is served and CENACE asked again in a minute) unless the
  // change is still there after DEMANDA_SETTLE, which makes it a real revision.
  const goodKey = new Request(`https://sentinels-pml.cache/demanda-good/${g}`);
  const good = cache ? await cache.match(goodKey).then(r => r ? r.json() : null) : null;
  const put = (k, obj, ttl) => cache && ctx.waitUntil(cache.put(k, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })));
  if (good && good.fecha === out.fecha && rewrites(good.horas, horas)) {
    const since = good.cambio || out.consultado;
    if (Date.now() - Date.parse(since) < DEMANDA_SETTLE) {
      put(goodKey, { ...good, cambio: since }, 86400);
      const { cambio, ...held } = good;
      put(key, held, 60);
      return held;
    }
  }
  if (horas.length) put(goodKey, out, 86400);
  // An empty answer is retried sooner
  put(key, out, horas.length ? DEMANDA_TTL : 30);
  return out;
}

// True when the new answer drops or changes (by more than 0.5%) an hour the good answer had published
function rewrites(before, now) {
  const at = new Map(now.map(h => [h.hora, h]));
  const off = (a, b) => a != null && (b == null || Math.abs(b - a) > Math.abs(a) * 0.005);
  return before.some(h => h.demanda != null && (!at.has(h.hora) || off(h.demanda, at.get(h.hora).demanda) || off(h.generacion, at.get(h.hora).generacion)));
}

const num = v => v == null || String(v).trim() === '' || !isFinite(Number(v)) ? null : Number(v);
// One row shape for both services: pml = price; pml_ene / pml_per / pml_cng = energy / losses / congestion
const rowOf = svc => { const [p, e, l, c] = svc.fields; return v => ({ fecha: v.fecha, hora: Number(v.hora), pml: num(v[p]), pml_ene: num(v[e]), pml_per: num(v[l]), pml_cng: num(v[c]) }); };
