/* ── Sentinels Client Portal · market data access ───────────────────
   Every market file (stored prices, long-term history, NodoP catalog,
   exchange rate, SEN demand) and every CENACE query goes through the
   sentinels-pml Worker (pml-worker/worker.js), which keeps the files in a
   private R2 bucket and only answers a signed-in client presenting their
   market pass: "<clientId>.<token>", issued by the admin panel into the
   client's encrypted vault (ME.market). Nothing is public on the site.
   Used by prices.js, history.js, nodos.js and board.js. */
const Market = (() => {
  const API = 'https://sentinels-pml.shy-wood-119b.workers.dev';  // sentinels-pml Worker (pml-worker/LEEME.md)

  const pass = () => (typeof ME !== 'undefined' && ME && ME.market && ME.market.token && MY_ID) ? `${MY_ID}.${ME.market.token}` : '';
  const base = () => (ME && ME.market && ME.market.url) || API;

  // An error whose message can be shown to the client as is
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const NO_PASS = 'Market data is not enabled for your account yet. Please contact Sentinels.';

  // GET a Worker route ('/pml?…', '/demanda?…', '/datos/…') with the client's pass
  function get(path, opts = {}) {
    if (!pass()) return Promise.reject(fail(401, NO_PASS));
    return fetch(base() + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + pass() } });
  }

  // Stored file of the bucket as JSON: null when it doesn't exist, an error otherwise
  async function file(path) {
    const r = await get('/datos/' + path);
    if (r.status === 404) return null;
    if (!r.ok) throw await errorOf(r);
    return r.json();
  }

  async function errorOf(r) {
    const b = await r.json().catch(() => ({}));
    return fail(r.status, b.message || (r.status === 401 ? NO_PASS : 'Market data is not available right now. Please try again later.'));
  }

  return { ready: () => !!pass(), get, file, errorOf };
})();
