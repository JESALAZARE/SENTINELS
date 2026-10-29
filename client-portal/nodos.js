/* ── Sentinels Client Portal · NodoP catalog ─────────────────────────
   The CENACE "Catálogo de NodosP", always the latest version: the GitHub
   Action (scripts/fetch-nodos.mjs) checks https://www.cenace.gob.mx/Paginas/SIM/NodosP.aspx
   every day and stores the newest file as nodos/catalogo.json in the private
   bucket, read through the PML Worker with the client's market pass (Market, market.js).
   Opened from Market Prices as a dialog: free-text search, faceted filters
   (each list shows only the values left by the other filters, with counts),
   sortable columns, a detail row per NodoP and an Excel export of the
   filtered rows. Uses _esc (index.html) and Xlsx (xlsx.js).
     NodosCatalog.open({ priced: Set of 'SIN/06CDU-400', onPick: (sistema, clave) => {} })
     NodosCatalog.open({ all: true, onPick, onPickZone })   // every NodoP and load zone can show prices (PML Worker) */
const NodosCatalog = (() => {
  const esc = s => _esc(s);
  const PAGE = 100;
  let CAT = null, rows = null, opts = {}, state = null;

  // Derived load / generation type, as the technical note describes it
  const kind = (d, i) => d && i ? 'Ambas' : d ? 'Directamente Modelada' : i ? 'Indirectamente Modelada' : 'No Aplica';
  const FILTERS = [
    ['sistema', 'System'], ['ccr', 'Control center'], ['zona_carga', 'Load zone'], ['kv', 'Voltage (kV)'],
    ['carga', 'Load type'], ['gen', 'Generation type'], ['entidad', 'State'], ['municipio', 'Municipality'], ['region_prodesen', 'PRODESEN region']
  ];
  const COLS = [['clave', 'Key'], ['nombre', 'Name'], ['sistema', 'System'], ['ccr', 'Control center'], ['zona_carga', 'Load zone'],
    ['kv', 'kV'], ['carga', 'Load'], ['gen', 'Generation'], ['entidad', 'State'], ['municipio', 'Municipality'], ['region_prodesen', 'PRODESEN region']];
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const fmtDate = f => new Date(f + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  async function load() {
    if (CAT) return;
    const c = await Market.file('nodos/catalogo.json');
    if (!c) throw new Error('catalog 404');
    CAT = c;
    const ix = Object.fromEntries(CAT.columnas.map((c, i) => [c, i]));
    rows = CAT.nodos.map(n => {
      const o = Object.fromEntries(CAT.columnas.map(c => [c, n[ix[c]]]));
      o.carga = kind(o.carga_directa !== 'No Aplica', o.carga_indirecta !== 'No Aplica');
      o.gen = kind(o.gen_directa !== 'No Aplica', o.gen_indirecta !== 'No Aplica');
      o._q = norm([o.clave, o.nombre, o.municipio, o.entidad, o.zona_carga].join(' '));
      return o;
    });
  }

  /* ── Dialog ───────────────────────────────────── */
  async function open(o = {}) {
    opts = o;
    let dlg = document.getElementById('cp-nodos');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'cp-nodos'; dlg.className = 'cp-nd-modal';
      dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'cp-nd-title');
      dlg.innerHTML = '<div class="cp-nd-panel"></div>';
      dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) close(); });
      document.body.appendChild(dlg);
    }
    dlg.hidden = false;
    document.body.classList.add('cp-nd-open');
    const panel = dlg.querySelector('.cp-nd-panel');
    if (!CAT) {
      panel.innerHTML = '<div class="cp-pr-msg">Loading the NodoP catalog…</div>';
      try { await load(); } catch { panel.innerHTML = `${head()}<div class="cp-pr-msg">The NodoP catalog is not available right now. Please try again later.</div>`; wire(panel); return; }
    }
    if (!state) state = { q: '', qRaw: '', f: {}, priced: false, sort: ['clave', 1], shown: PAGE, openKey: null };
    render();
  }
  function close() {
    const dlg = document.getElementById('cp-nodos');
    if (dlg) dlg.hidden = true;
    document.body.classList.remove('cp-nd-open');
  }

  const head = () => `<div class="cp-nd-head">
      <div><h2 class="cp-nd-title" id="cp-nd-title">NodoP catalog</h2>
        ${CAT ? `<div class="cp-nd-meta">CENACE version <b>v${esc(CAT.version)}</b> · updated ${esc(fmtDate(CAT.fecha_actualizacion))} ·
          always the latest file published at <a href="${esc(CAT.fuente)}" target="_blank" rel="noopener noreferrer">cenace.gob.mx/Paginas/SIM/NodosP.aspx</a>, checked daily</div>` : ''}</div>
      <button class="cp-nd-close" aria-label="Close">×</button></div>`;
  function wire(panel) { panel.querySelector('.cp-nd-close').onclick = close; }

  const pricedKey = r => r.sistema + '/' + r.clave;
  // opts.all: Market Prices can query any NodoP (Worker configured); otherwise only those in opts.priced
  const hasPrice = r => !!(opts.all || (opts.priced && opts.priced.has(pricedKey(r))));
  function matches(r, skip) {
    if (state.q && !state.q.split(/\s+/).every(w => r._q.includes(w))) return false;
    if (state.priced && !hasPrice(r)) return false;
    for (const [k] of FILTERS) if (k !== skip && state.f[k] != null && state.f[k] !== '' && String(r[k]) !== state.f[k]) return false;
    return true;
  }

  function render() {
    const panel = document.querySelector('#cp-nodos .cp-nd-panel');
    const list = rows.filter(r => matches(r));
    const [sk, dir] = state.sort;
    list.sort((a, b) => {
      const x = a[sk], y = b[sk];
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es')) * dir || a.clave.localeCompare(b.clave);
    });
    const active = Object.values(state.f).filter(v => v != null && v !== '').length + (state.q ? 1 : 0) + (state.priced ? 1 : 0);
    // Faceted options: each filter lists the values left by the other filters
    const facet = k => {
      const m = new Map();
      rows.forEach(r => { if (matches(r, k)) m.set(String(r[k]), (m.get(String(r[k])) || 0) + 1); });
      if (state.f[k] && !m.has(state.f[k])) m.set(state.f[k], 0);
      return [...m].sort((a, b) => k === 'kv' ? Number(a[0]) - Number(b[0]) : a[0].localeCompare(b[0], 'es'));
    };
    const pricedCount = opts.priced && !opts.all ? rows.filter(hasPrice).length : 0;
    panel.innerHTML = `${head()}
      <div class="cp-nd-filters ${state.fopen ? 'open' : ''}">
        <button class="cp-btn-ghost cp-btn-sm cp-nd-ftoggle" id="nd-ftoggle" aria-expanded="${!!state.fopen}">${state.fopen ? 'Hide filters' : 'Filters'}${active - (state.q ? 1 : 0) > 0 ? ` (${active - (state.q ? 1 : 0)})` : ''}</button>
        <label class="cp-pr-f cp-nd-search"><span>Search</span><input type="search" id="nd-q" placeholder="Key, name, municipality…" value="${esc(state.qRaw)}" autocomplete="off"></label>
        ${FILTERS.map(([k, label]) => `<label class="cp-pr-f"><span>${label}</span><select data-f="${k}"><option value="">All</option>${facet(k).map(([v, n]) =>
          `<option value="${esc(v)}" ${state.f[k] === v ? 'selected' : ''}>${esc(v)} (${n.toLocaleString('en-US')})</option>`).join('')}</select></label>`).join('')}
      </div>
      <div class="cp-nd-bar">
        <div class="cp-nd-count"><b>${list.length.toLocaleString('en-US')}</b> of ${rows.length.toLocaleString('en-US')} NodosP</div>
        ${pricedCount ? `<label class="cp-nd-chk"><input type="checkbox" id="nd-priced" ${state.priced ? 'checked' : ''}> With price data (${pricedCount})</label>` : ''}
        <div class="cp-nd-actions">
          ${zoneBtn(state.f.zona_carga, rows.find(r => r.zona_carga === state.f.zona_carga), 'cp-btn-dark cp-btn-sm')}
          ${active ? '<button class="cp-btn-ghost cp-btn-sm" id="nd-clear">Clear filters</button>' : ''}
          <button class="cp-pr-dl" id="nd-xlsx" ${list.length ? '' : 'disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>Excel</button>
          <a class="cp-nd-src" href="${esc(CAT.archivo)}" target="_blank" rel="noopener noreferrer">Original file (CENACE)</a>
        </div>
      </div>
      <div class="cp-nd-scroll"><table class="cp-mini-table cp-nd-table"><thead><tr>${COLS.map(([k, t]) =>
        `<th><button data-s="${k}" class="${sk === k ? 'on' : ''}" aria-sort="${sk === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${t}${sk === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${list.slice(0, state.shown).map(row).join('') || `<tr><td colspan="${COLS.length}" class="cp-nd-none">No NodoP matches these filters.</td></tr>`}</tbody></table></div>
      ${list.length > state.shown ? `<button class="cp-btn-ghost cp-btn-sm cp-nd-more" id="nd-more">Show ${Math.min(PAGE, list.length - state.shown)} more (${(list.length - state.shown).toLocaleString('en-US')} left)</button>` : ''}`;

    wire(panel);
    const q = panel.querySelector('#nd-q');
    let t = null;
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.qRaw = q.value; state.q = norm(q.value.trim()); state.shown = PAGE; render(); refocus(q.value); }, 200); };
    panel.querySelectorAll('select[data-f]').forEach(s => s.onchange = () => {
      state.f[s.dataset.f] = s.value; if (s.dataset.f === 'entidad') delete state.f.municipio; state.shown = PAGE; render();
    });
    panel.querySelector('#nd-ftoggle').onclick = () => { state.fopen = !state.fopen; render(); };
    const pc = panel.querySelector('#nd-priced'); if (pc) pc.onchange = () => { state.priced = pc.checked; state.shown = PAGE; render(); };
    const clr = panel.querySelector('#nd-clear'); if (clr) clr.onclick = () => { state.q = state.qRaw = ''; state.f = {}; state.priced = false; state.shown = PAGE; render(); };
    const more = panel.querySelector('#nd-more'); if (more) more.onclick = () => { state.shown += PAGE; render(); };
    panel.querySelectorAll('th button[data-s]').forEach(b => b.onclick = () => {
      state.sort = state.sort[0] === b.dataset.s ? [b.dataset.s, -state.sort[1]] : [b.dataset.s, 1]; render();
    });
    panel.querySelectorAll('tr[data-k]').forEach(tr => tr.onclick = e => {
      if (e.target.closest('button')) return;
      state.openKey = state.openKey === tr.dataset.k ? null : tr.dataset.k; render();
    });
    panel.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { const [s, c] = b.dataset.pick.split('/'); close(); opts.onPick && opts.onPick(s, c); });
    panel.querySelectorAll('[data-zone]').forEach(b => b.onclick = () => { const i = b.dataset.zone.indexOf('/'); close(); opts.onPickZone(b.dataset.zone.slice(0, i), b.dataset.zone.slice(i + 1)); });
    panel.querySelector('#nd-xlsx').onclick = () => exportXlsx(list);
  }
  // Keep typing in the search box after a re-render
  function refocus(v) { const q = document.getElementById('nd-q'); if (q) { q.focus(); q.setSelectionRange(v.length, v.length); } }

  function row(r) {
    const k = pricedKey(r), open = state.openKey === k;
    return `<tr data-k="${esc(k)}" class="${open ? 'open' : ''}" tabindex="0">${COLS.map(([c]) => `<td>${esc(r[c])}${c === 'clave' && !opts.all && hasPrice(r) ? ' <span class="cp-nd-tag">prices</span>' : ''}</td>`).join('')}</tr>` +
      (open ? `<tr class="cp-nd-detail"><td colspan="${COLS.length}"><div class="cp-nd-dgrid">
        ${[['Load (directly / indirectly modeled)', `${r.carga_directa} / ${r.carga_indirecta}`], ['Generation (directly / indirectly modeled)', `${r.gen_directa} / ${r.gen_indirecta}`],
          ['Transmission operating zone', r.zona_transmision], ['Regional transmission office', r.gerencia_transmision], ['Distribution zone', r.zona_distribucion],
          ['Divisional distribution office', r.gerencia_distribucion], ['State (INEGI key)', `${r.entidad} (${r.clave_entidad})`], ['Municipality (INEGI key)', `${r.municipio} (${r.clave_municipio})`]]
          .map(([l, v]) => `<div><span>${l}</span><b>${esc(v)}</b></div>`).join('')}</div>
        <div class="cp-nd-btns">${hasPrice(r) ? `<button class="cp-btn-dark cp-btn-sm" data-pick="${esc(k)}">View prices for ${esc(r.clave)}</button>` : '<div class="cp-nd-nop">Market Prices does not have data for this NodoP yet.</div>'}
        ${zoneBtn(r.zona_carga, r, 'cp-btn-ghost cp-btn-sm')}</div></td></tr>` : '');
  }

  // Prices of a load zone (distributed node, SW-PEND); only when Market Prices can query them
  const zoneBtn = (zona, r, cls) => opts.onPickZone && zona && zona !== 'No Aplica' && r
    ? `<button class="${cls}" data-zone="${esc(r.sistema + '/' + zona)}">View load zone ${esc(zona)} prices</button>` : '';

  function exportXlsx(list) {
    const cols = [...COLS, ['zona_transmision', 'Transmission zone'], ['gerencia_transmision', 'Transmission office'], ['zona_distribucion', 'Distribution zone'],
      ['gerencia_distribucion', 'Distribution office'], ['clave_entidad', 'State key (INEGI)'], ['clave_municipio', 'Municipality key (INEGI)']];
    Xlsx.download(`Catalogo_NodosP_v${CAT.version}.xlsx`, [{ name: 'NodosP', columns: cols.map(([k, t]) => ({ title: t, width: k === 'nombre' ? 34 : k === 'kv' ? 7 : 20 })),
      rows: list.map(r => cols.map(([k]) => r[k])) }]);  // general format keeps 34.5 kV and 115 kV as typed
  }

  // Every NodoP of the catalog ({ sistema, clave, nombre, … }), for the Market Prices selector
  async function list() { await load(); return rows; }

  return { open, close, list };
})();
