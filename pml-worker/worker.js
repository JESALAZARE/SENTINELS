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

const num = v => v === '' || v == null || !isFinite(Number(v)) ? null : Number(v);
// One row shape for both services: pml = price; pml_ene / pml_per / pml_cng = energy / losses / congestion
const rowOf = svc => { const [p, e, l, c] = svc.fields; return v => ({ fecha: v.fecha, hora: Number(v.hora), pml: num(v[p]), pml_ene: num(v[e]), pml_per: num(v[l]), pml_cng: num(v[c]) }); };
