/* ── Sentinels Client Portal · Hedge Contracts page ──────────────────
   The Contratos de Cobertura Eléctrica CENACE publishes as "Contratos Aceptados":
   the GitHub Action .github/workflows/contratos.yml (scripts/fetch-contratos.mjs)
   checks them twice a day and stores contratos/contratos.json in the private
   bucket, read through the PML Worker with the client's market pass (Market, market.js).
   Free-text search, faceted filters by issuer, buyer and status (each list shows only
   the values left by the other filters, with counts), an end-date range, sortable
   columns and an Excel export of the filtered rows. Status codes are shown as CENACE
   publishes them. Uses _esc (index.html) and Xlsx (xlsx.js). */
const HedgesPage = (() => {
  const esc = s => _esc(s);
  const PAGE = 100;
  const FILTERS = [['emisor', 'Issuer'], ['adquiriente', 'Buyer'], ['estatus', 'Status']];
  const COLS = [['folio', 'Folio'], ['emisor', 'Issuer'], ['adquiriente', 'Buyer'], ['fecha_firma', 'Signed'], ['fecha_inicio', 'Start'], ['fecha_fin', 'End'], ['estatus', 'Status']];
  const NEW_STATE = () => ({ q: '', f: {}, desde: '', hasta: '', shown: PAGE });
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const stamp = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  let data = null, rows = null, loading = false, list = [];
  let S = NEW_STATE(), sort = ['fecha_firma', -1], fopen = false;

  async function show() {
    const host = document.getElementById('hedges-root');
    if (!host || rows || loading) return;
    loading = true;
    host.innerHTML = '<div class="cp-card cp-pr-msg">Loading hedge contracts…</div>';
    try {
      data = await Market.file('contratos/contratos.json');
      if (!data) throw Object.assign(new Error('Hedge contracts are not available yet. Please try again later.'), { status: 404 });
      rows = data.filas.map(f => {
        const o = Object.fromEntries(data.columnas.map((c, i) => [c, f[i]]));
        o._q = norm(`${o.folio} ${o.emisor} ${o.adquiriente}`);
        return o;
      });
      build(host);
    } catch (e) {
      host.innerHTML = `<div class="cp-card cp-pr-msg">${esc(e.status ? e.message : 'Hedge contracts are not available right now. Please try again later.')}</div>`;
    }
    loading = false;
  }

  function matches(r, skip) {
    if (S.q && !S.q.split(/\s+/).every(w => r._q.includes(w))) return false;
    if (S.desde && r.fecha_fin < S.desde) return false;
    if (S.hasta && r.fecha_fin > S.hasta) return false;
    for (const [k] of FILTERS) if (k !== skip && S.f[k] && r[k] !== S.f[k]) return false;
    return true;
  }
  const activeFilters = () => FILTERS.filter(([k]) => S.f[k]).length + (S.desde ? 1 : 0) + (S.hasta ? 1 : 0);

  // The bar is drawn once so typing and date pickers keep their focus; update() redraws the rest
  function build(host) {
    host.innerHTML = `<div class="cp-card cp-hc">
      <div class="cp-nd-meta cp-hc-meta">Accepted contracts as published by CENACE at <a href="${esc(data.fuente)}" target="_blank" rel="noopener noreferrer">cenace.gob.mx</a> · last checked ${esc(stamp(data.consultado))} · last change ${esc(stamp(data.actualizado))}</div>
      <div class="cp-nd-filters" id="hc-filters">
        <button class="cp-btn-ghost cp-btn-sm cp-nd-ftoggle" id="hc-ftoggle" aria-expanded="false">Filters</button>
        <label class="cp-pr-f cp-nd-search"><span>Search</span><input type="search" id="hc-q" placeholder="Folio, issuer or buyer…" autocomplete="off"></label>
        ${FILTERS.map(([k, label]) => `<label class="cp-pr-f"><span>${label}</span><select data-f="${k}"></select></label>`).join('')}
        <label class="cp-pr-f"><span>End date from</span><input type="date" id="hc-desde"></label>
        <label class="cp-pr-f"><span>End date to</span><input type="date" id="hc-hasta"></label>
      </div>
      <div id="hc-results"></div>
    </div>`;

    let t = null;
    const q = host.querySelector('#hc-q');
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.q = norm(q.value.trim()); S.shown = PAGE; update(); }, 200); };
    host.querySelector('#hc-desde').onchange = e => { S.desde = e.target.value; S.shown = PAGE; update(); };
    host.querySelector('#hc-hasta').onchange = e => { S.hasta = e.target.value; S.shown = PAGE; update(); };
    host.querySelectorAll('select[data-f]').forEach(s => s.onchange = () => { S.f[s.dataset.f] = s.value; S.shown = PAGE; update(); });
    host.querySelector('#hc-ftoggle').onclick = () => { fopen = !fopen; update(); };
    host.querySelector('#hc-results').onclick = e => {
      const th = e.target.closest('button[data-s]');
      if (th) { sort = sort[0] === th.dataset.s ? [th.dataset.s, -sort[1]] : [th.dataset.s, 1]; update(); return; }
      if (e.target.closest('#hc-more')) { S.shown += PAGE; update(); return; }
      if (e.target.closest('#hc-clear')) { S = NEW_STATE(); ['hc-q', 'hc-desde', 'hc-hasta'].forEach(id => { document.getElementById(id).value = ''; }); update(); return; }
      if (e.target.closest('#hc-xlsx')) exportXlsx();
    };
    update();
  }

  function compare(a, b) {
    const [k, dir] = sort;
    const n = k === 'folio' ? Number(a.folio) - Number(b.folio) : String(a[k]).localeCompare(String(b[k]), 'es');
    return n * dir || Number(b.folio) - Number(a.folio);
  }

  function update() {
    list = rows.filter(r => matches(r)).sort(compare);
    // Faceted options: each filter lists the values left by the other filters
    FILTERS.forEach(([k]) => {
      const m = new Map();
      rows.forEach(r => { if (matches(r, k)) m.set(r[k], (m.get(r[k]) || 0) + 1); });
      if (S.f[k] && !m.has(S.f[k])) m.set(S.f[k], 0);
      document.querySelector(`#hc-filters select[data-f="${k}"]`).innerHTML = '<option value="">All</option>' +
        [...m].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([v, n]) =>
          `<option value="${esc(v)}" ${S.f[k] === v ? 'selected' : ''}>${esc(v)} (${n.toLocaleString('en-US')})</option>`).join('');
    });
    const count = activeFilters(), toggle = document.getElementById('hc-ftoggle');
    document.getElementById('hc-filters').classList.toggle('open', fopen);
    toggle.setAttribute('aria-expanded', String(fopen));
    toggle.textContent = (fopen ? 'Hide filters' : 'Filters') + (count ? ` (${count})` : '');

    const [sk, dir] = sort, left = list.length - S.shown;
    document.getElementById('hc-results').innerHTML = `<div class="cp-nd-bar">
        <div class="cp-nd-count"><b>${list.length.toLocaleString('en-US')}</b> of ${rows.length.toLocaleString('en-US')} contracts</div>
        <div class="cp-nd-actions">
          ${count || S.q ? '<button class="cp-btn-ghost cp-btn-sm" id="hc-clear">Clear filters</button>' : ''}
          <button class="cp-pr-dl" id="hc-xlsx" ${list.length ? '' : 'disabled'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>Excel</button>
        </div>
      </div>
      <div class="cp-nd-scroll cp-hc-scroll"><table class="cp-mini-table cp-nd-table"><thead><tr>${COLS.map(([k, t]) =>
        `<th aria-sort="${sk === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button data-s="${k}" class="${sk === k ? 'on' : ''}">${t}${sk === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${list.slice(0, S.shown).map(r => `<tr>${COLS.map(([k]) => `<td${k === 'emisor' || k === 'adquiriente' ? ' class="cp-hc-co"' : ''}>${esc(r[k])}</td>`).join('')}</tr>`).join('') ||
          `<tr><td colspan="${COLS.length}" class="cp-nd-none">No contract matches these filters.</td></tr>`}</tbody></table></div>
      ${left > 0 ? `<div class="cp-hc-more"><button class="cp-btn-ghost cp-btn-sm" id="hc-more">Show ${Math.min(PAGE, left)} more (${left.toLocaleString('en-US')} left)</button></div>` : ''}`;
  }

  function exportXlsx() {
    const width = { folio: 8, emisor: 46, adquiriente: 46, estatus: 8 };
    Xlsx.download(`Contratos_Cobertura_CENACE_${data.consultado.slice(0, 10)}.xlsx`, [{
      name: 'Hedge contracts',
      columns: COLS.map(([k, t]) => ({ title: t, width: width[k] || 12, fmt: k === 'folio' ? '0' : 'text' })),
      rows: list.map(r => COLS.map(([k]) => k === 'folio' && /^\d+$/.test(r.folio) ? Number(r.folio) : r[k]))
    }]);
  }

  return { show };
})();
