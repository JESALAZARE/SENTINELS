/* ── Sentinels · PML Cloudflare Worker ───────────────────────────────
   On-demand proxy to CENACE's public SW-PML web service so the Market
   Prices tab can query ANY NodoP of the catalog. The browser can't call
   SW-PML directly (no CORS headers, port 8082), so this Worker:
   - accepts only GET requests from the site's origins (ALLOWED_ORIGINS);
   - validates the query and caps it at 31 days and 20 NodosP;
   - splits it into the 7-day windows SW-PML allows and fetches them in parallel;
   - caches every window in Cloudflare's cache (published days for a week,
     days that may still change for 30 minutes), so CENACE sees few calls;
   - returns numbers, in the same row shape as /data/pml/<sistema>/<nodo>.json.

     GET /pml?sistema=SIN&proceso=MDA&nodos=06CDU-400&desde=2026-10-01&hasta=2026-10-26
     GET /health              (?cenace=1 also checks that CENACE answers)

   Configure in Cloudflare (Settings → Variables and Secrets):
     ALLOWED_ORIGINS  text — https://sentinels.com.mx
   No secrets or storage are needed: SW-PML is public. Plain fetch() so the
   file can be pasted into the Cloudflare dashboard editor (no build step).
   Setup steps: pml-worker/LEEME.md */

const SWPML = 'https://ws01.cenace.gob.mx:8082/SWPML/SIM';
const MAX_DAYS = 31, MAX_NODES = 20;
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
          const r = await fetchWindow({ sistema: 'SIN', proceso: 'MDA', nodos: ['06CDU-400'] }, y, y, ctx);
          const hours = (r[0] && r[0].Valores || []).length;
          return json({ ok: hours > 0, service: 'sentinels-pml', cenace: hours > 0 ? 'reachable' : 'no data', day: y, hours, ms: Date.now() - t0 });
        } catch (e) {
          return json({ ok: false, service: 'sentinels-pml', cenace: 'unreachable', error: String(e.message || e) }, 502);
        }
      }
      if (!allowed.includes(origin)) return json({ error: 'forbidden', message: 'Origin not allowed.' }, 403);
      if (request.method !== 'GET' || url.pathname !== '/pml') return json({ error: 'not_found' }, 404);

      const q = parse(url.searchParams);
      const windows = [];
      for (let ini = q.desde; ini <= q.hasta; ini = addDays(ini, 7)) windows.push([ini, minDate(addDays(ini, 6), q.hasta)]);
      const parts = await Promise.all(windows.map(([a, b]) => fetchWindow(q, a, b, ctx)));

      const nodos = Object.fromEntries(q.nodos.map(n => [n, []]));
      for (const res of parts) for (const r of res) if (nodos[r.clv_nodo]) nodos[r.clv_nodo].push(...(r.Valores || []).map(row));
      for (const n of q.nodos) nodos[n].sort((a, b) => a.fecha === b.fecha ? a.hora - b.hora : a.fecha < b.fecha ? -1 : 1);
      // Browsers may reuse the answer briefly; Cloudflare's cache holds the CENACE windows
      return json({ sistema: q.sistema, proceso: q.proceso, desde: q.desde, hasta: q.hasta, unidades: '$/MWh', fuente: 'CENACE SW-PML', nodos }, 200, 'public, max-age=300');
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

function parse(p) {
  const sistema = p.get('sistema'), proceso = p.get('proceso');
  if (!['SIN', 'BCA', 'BCS'].includes(sistema)) throw fail(400, 'bad_request', 'sistema must be SIN, BCA or BCS.');
  if (!['MDA', 'MTR'].includes(proceso)) throw fail(400, 'bad_request', 'proceso must be MDA or MTR.');
  const nodos = [...new Set(String(p.get('nodos') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!nodos.length || nodos.length > MAX_NODES || !nodos.every(n => /^[0-9A-Z][0-9A-Z.-]{1,19}$/.test(n))) {
    throw fail(400, 'bad_request', `nodos must list 1 to ${MAX_NODES} NodoP keys.`);
  }
  let desde = p.get('desde'), hasta = p.get('hasta');
  if (!ISO.test(desde || '') || !ISO.test(hasta || '') || desde > hasta) throw fail(400, 'bad_request', 'desde and hasta must be dates (YYYY-MM-DD), desde ≤ hasta.');
  // Published range: MDA up to tomorrow, MTR up to 7 days ago
  const last = proceso === 'MDA' ? addDays(todayMX(), 1) : addDays(todayMX(), -7);
  desde = desde < FIRST[proceso][sistema] ? FIRST[proceso][sistema] : desde;
  hasta = minDate(hasta, last);
  if (desde > hasta) throw fail(422, 'not_published', `${proceso} prices are not published for those dates.`);
  if ((Date.parse(hasta) - Date.parse(desde)) / 864e5 + 1 > MAX_DAYS) throw fail(400, 'too_long', `Query at most ${MAX_DAYS} days at a time.`);
  return { sistema, proceso, nodos: nodos.sort(), desde, hasta };
}

/* ── CENACE windows (cached) ───────────────────── */
async function fetchWindow(q, a, b, ctx) {
  const path = `${q.sistema}/${q.proceso}/${q.nodos.join(',')}/${a.replace(/-/g, '/')}/${b.replace(/-/g, '/')}/JSON`;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://sentinels-pml.cache/' + path);
  if (cache) { const hit = await cache.match(key); if (hit) return hit.json(); }

  const res = await fetch(`${SWPML}/${path}`, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 0 } });
  if (res.status === 204 || res.status === 404) return [];
  if (!res.ok) throw new Error(`SW-PML HTTP ${res.status}`);
  const body = await res.json();
  if (body.status && body.status !== 'OK') return [];
  const out = body.Resultados || [];

  // Windows that end before yesterday are final; recent ones may still be published or revised
  const ttl = b < addDays(todayMX(), -1) ? 7 * 86400 : 1800;
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })));
  return out;
}

const num = v => v === '' || v == null || !isFinite(Number(v)) ? null : Number(v);
const row = v => ({ fecha: v.fecha, hora: Number(v.hora), pml: num(v.pml), pml_ene: num(v.pml_ene), pml_per: num(v.pml_per), pml_cng: num(v.pml_cng) });
