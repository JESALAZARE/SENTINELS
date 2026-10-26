/* ── Sentinels Client Portal · Market Prices page ────────────────────
   Local marginal prices (PML) published by CENACE for the day-ahead (MDA)
   and real-time (MTR) markets. Two sources:
   - /data/pml: the GitHub Action .github/workflows/pml.yml downloads a 60-day
     history of the NodosP in index.json every day (fast, no Worker needed);
   - PML_API: the sentinels-pml Cloudflare Worker (pml-worker/worker.js) queries
     CENACE on demand, so any NodoP of the catalog (/data/nodos) can be shown,
     up to 31 days at a time. Leave PML_API empty to use only /data/pml.
     With the Worker the "Distributed nodes" checkbox switches to load zones:
     their PEND (SW-PEND, the zone's weighted average of its NodosP PML) is
     shown in the same widgets.
   /data/fx/usd-mxn.json holds the Banxico FIX for payments for the USD switch.
   The client picks a NodoP and a date range; every widget is computed from
   the hourly rows in that range.
   Uses Board.charts (board.js), NodosCatalog (nodos.js), Xlsx (xlsx.js) and _esc. */
const PricesPage = (() => {
  const PML_API = 'https://sentinels-pml.shy-wood-119b.workers.dev';  // sentinels-pml Worker (pml-worker/LEEME.md); '' = stored NodosP only
  const DATA = '../data/';
  const MAX_DAYS = 31;
  // First operating day with MDA prices per system (SW-PML technical manual)
  const FIRST = { SIN: '2016-01-29', BCA: '2016-01-27', BCS: '2016-03-23' };
  const PROCS = { MDA: 'Day-ahead market (MDA)', MTR: 'Real-time market (MTR)' };
  const PARTS = [['pml', 'PML', '#0B0D0F'], ['pml_ene', 'Energy', '#C89D2A'], ['pml_cng', 'Congestion', '#8C3A36'], ['pml_per', 'Losses', '#5B7FA6']];
  const esc = s => _esc(s);
  const fx = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const day = f => new Date(f + 'T00:00:00');
  const short = f => day(f).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const long = f => day(f).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (f, n) => iso(new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5));
  const todayMX = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const live = () => !!PML_API;

  // catalog: NodosP of the CENACE catalog (only loaded when the Worker is configured)
  const S = { index: null, catalog: null, fx: null, node: null, from: null, to: null, cache: {}, proc: { max: 'MDA', min: 'MDA', table: 'MDA' }, usd: false, error: null };

  async function getJSON(path) {
    const r = await fetch(DATA + path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(path + ': ' + r.status);
    return r.json();
  }

  // Banxico rate for payments on an operating day: its "para pagos" value (the FIX published
  // in the DOF the previous banking day). A day Banxico does not list yet (tomorrow's MDA)
  // takes the latest DOF publication before it. The series is sorted newest first.
  const hasFx = () => !!(S.fx && (S.fx.serie || []).length);
  function rateFor(f) {
    const r = ((S.fx && S.fx.serie) || []).find(x => x.fecha <= f);
    if (!r) return null;
    return (r.fecha === f ? r.para_pagos : r.dof ?? r.para_pagos) || null;
  }

  async function show() {
    const host = document.getElementById('prices-root');
    if (!host) return;
    if (!S.index && !S.error) {
      host.innerHTML = '<div class="cp-card cp-pr-msg">Loading market prices…</div>';
      try {
        const [index, fxData, catalog] = await Promise.all([getJSON('pml/index.json'), getJSON('fx/usd-mxn.json').catch(() => null),
          live() ? NodosCatalog.list().catch(() => null) : null]);
        S.index = index; S.fx = fxData; S.catalog = catalog;
        if (!(index.nodos || []).length) throw new Error('no nodes');
        pickNode(index.nodos[0]);
      } catch { S.error = true; }
    }
    if (S.error) { host.innerHTML = '<div class="cp-card cp-pr-msg">Market prices are not available right now. Please try again later.</div>'; return; }
    await render();
  }

  // Stored NodosP (60-day history in /data/pml) and, with the Worker, every NodoP of the catalog
  const stored = (sistema, nodo) => S.index.nodos.find(n => n.sistema === sistema && n.nodo === nodo);
  const anyNode = () => live() && S.catalog;
  const nameOf = n => (S.catalog && (S.catalog.find(r => r.sistema === n.sistema && r.clave === n.nodo) || {}).nombre) || '';
  // Load zones (distributed nodes, SW-PEND) of a system, with how many NodosP each one groups
  const zonesOf = s => {
    const m = new Map();
    S.catalog.forEach(r => { if (r.sistema === s && r.zona_carga && r.zona_carga !== 'No Aplica') m.set(r.zona_carga, (m.get(r.zona_carga) || 0) + 1); });
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  };
  const isZone = n => n.kind === 'zone';
  const priceName = () => isZone(S.node) ? 'PEND' : 'PML';

  // Dates the client can query. Stored only: the stored history. With the Worker: from the
  // first published day to tomorrow (MDA), at most 31 days per query.
  const bounds = n => {
    if (anyNode()) return { min: FIRST[n.sistema] || FIRST.SIN, max: addDays(todayMX(), 1) };
    const r = [n.MDA, n.MTR].filter(Boolean);
    return { min: r.map(x => x.desde).sort()[0], max: r.map(x => x.hasta).sort().at(-1) };
  };
  // Default view is the last 14 days, so both MDA and MTR show data
  function pickNode(n) {
    S.node = n.kind === 'zone' ? { sistema: n.sistema, nodo: n.nodo, kind: 'zone' } : stored(n.sistema, n.nodo) || { sistema: n.sistema, nodo: n.nodo };
    const b = bounds(S.node);
    S.to = b.max; S.from = [addDays(b.max, -13), b.min].sort().at(-1);
  }

  // Rows for the selected NodoP or load zone and dates: from the stored file when it covers
  // the range, otherwise from the Worker (/pml or /pend; both markets, only the requested dates)
  async function nodeData() {
    const n = S.node, zone = isZone(n), k = (zone ? 'zone:' : '') + n.sistema + '/' + n.nodo;
    const covered = !zone && n.MDA && n.MTR && S.from >= [n.MDA.desde, n.MTR.desde].sort().at(-1);
    if (covered || !live()) {
      if (!S.cache[k]) S.cache[k] = getJSON(`pml/${encodeURIComponent(n.sistema)}/${encodeURIComponent(n.nodo)}.json`);
      return S.cache[k];
    }
    const kq = `${k}|${S.from}|${S.to}`;
    if (!S.cache[kq]) {
      const one = async p => {
        const qs = new URLSearchParams({ sistema: n.sistema, proceso: p, [zone ? 'zonas' : 'nodos']: n.nodo, desde: S.from, hasta: S.to });
        const r = await fetch(`${PML_API}/${zone ? 'pend' : 'pml'}?${qs}`);
        if (r.status === 422) return [];  // nothing published yet for those dates (e.g. recent MTR)
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.message || 'HTTP ' + r.status);
        const res = zone ? b.zonas : b.nodos;
        return (res && res[n.nodo]) || [];
      };
      S.cache[kq] = Promise.all([one('MDA'), one('MTR')]).then(([MDA, MTR]) => ({ MDA, MTR }));
      S.cache[kq].catch(() => delete S.cache[kq]);
    }
    return S.cache[kq];
  }
  const rowsOf = (d, p) => (d[p] || []).filter(r => r.fecha >= S.from && r.fecha <= S.to && r.pml != null);

  // Daily / hourly averages of the PML and each of its components
  function averages(rows, keyOf, keys) {
    const groups = new Map(keys.map(k => [k, []]));
    rows.forEach(r => { const g = groups.get(keyOf(r)); if (g) g.push(r); });
    return PARTS.map(([f]) => keys.map(k => mean(groups.get(k).map(r => r[f]).filter(v => v != null))));
  }

  /* ── Page ─────────────────────────────────────── */
  let seq = 0;
  async function render() {
    const host = document.getElementById('prices-root'), my = ++seq;
    host.dataset.loading = `Loading ${isZone(S.node) ? 'load zone ' : ''}${S.node.nodo} prices from CENACE…`;
    host.classList.add('cp-pr-loading');
    let d, err = null;
    try { d = await nodeData(); } catch (e) { err = e; }
    if (my !== seq) return;  // a newer query started while this one loaded
    host.classList.remove('cp-pr-loading');
    const b = bounds(S.node), nodes = S.index.nodos, n = S.node;
    const systems = anyNode() ? ['SIN', 'BCA', 'BCS'] : [...new Set(nodes.map(x => x.sistema))];
    const span = (Date.parse(S.to) - Date.parse(S.from)) / 864e5 + 1;
    const presets = anyNode() ? [[7, '7D'], [14, '14D'], [30, '30D']] : [[7, '7D'], [14, '14D'], [30, '30D'], [0, 'All']];
    const avail = p => n[p] ? `${p} ${short(n[p].desde)} – ${long(n[p].hasta)}` : `${p} not available`;
    const zone = isZone(n), P = priceName();
    const zoneCount = zone ? (zonesOf(n.sistema).find(([z]) => z === n.nodo) || [])[1] : 0;
    const note = zone
      ? `Distributed node price (PEND): CENACE's weighted average of the PML of the zone's NodosP, by its load distribution. Up to ${MAX_DAYS} days per query; MTR prices are published 7 days after the operating day. Source: CENACE.`
      : anyNode()
      ? `Any NodoP of the CENACE catalog, up to ${MAX_DAYS} days per query. MDA prices are published the day before the operating day; MTR prices 7 days after it. Source: CENACE.`
      : `${avail('MDA')} · ${avail('MTR')}. MTR prices are published 7 days after the operating day. Source: CENACE.`;
    const title = zone ? `Load zone ${n.nodo} · ${n.sistema}${zoneCount ? ` · ${zoneCount} NodosP` : ''}` : nameOf(n) ? `${n.nodo} · ${nameOf(n)}` : '';
    const nodeField = zone
      ? `<select id="pr-node">${zonesOf(n.sistema).map(([z, c]) => `<option value="${esc(z)}" ${z === n.nodo ? 'selected' : ''}>${esc(z)} (${c})</option>`).join('')}</select>`
      : anyNode()
      ? `<input id="pr-node" list="pr-nodes" value="${esc(n.nodo)}" autocomplete="off" spellcheck="false" aria-describedby="pr-node-name">
         <datalist id="pr-nodes">${S.catalog.filter(r => r.sistema === n.sistema).map(r => `<option value="${esc(r.clave)}">${esc(r.nombre)}</option>`).join('')}</datalist>`
      : `<select id="pr-node">${nodes.filter(x => x.sistema === n.sistema).map(x => `<option ${x.nodo === n.nodo ? 'selected' : ''}>${esc(x.nodo)}</option>`).join('')}</select>`;
    host.innerHTML = `
      <div class="cp-card cp-pr-bar">
        <label class="cp-pr-f"><span>System</span><select id="pr-sys">${systems.map(s => `<option ${s === n.sistema ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label class="cp-pr-f cp-pr-f--node"><span>${zone ? 'Load zone' : 'NodoP'}</span>${nodeField}</label>
        ${anyNode() ? `<label class="cp-pr-zone"><input type="checkbox" id="pr-zone" ${zone ? 'checked' : ''}><span>Distributed nodes<small>Load zones (PEND)</small></span></label>` : ''}
        <label class="cp-pr-f"><span>From</span><input type="date" id="pr-from" value="${S.from}" min="${b.min}" max="${b.max}"></label>
        <label class="cp-pr-f"><span>To</span><input type="date" id="pr-to" value="${S.to}" min="${b.min}" max="${b.max}"></label>
        <div class="cp-pr-presets" role="group" aria-label="Quick ranges">${presets.map(([k, t]) =>
          `<button class="cp-doc-filter ${S.to === b.max && (k ? span === k && S.from === addDays(b.max, 1 - k) : S.from === b.min) ? 'active' : ''}" data-n="${k}">${t}</button>`).join('')}</div>
        <button class="cp-btn-ghost cp-btn-sm cp-pr-cat" id="pr-cat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>View NodoP catalog</button>
        <div class="cp-pr-note">${title ? `<b id="pr-node-name">${esc(title)}</b> · ` : ''}${esc(note)}</div>
      </div>
      ${err ? `<div class="cp-card cp-pr-msg">The prices for ${zone ? 'load zone ' : ''}${esc(n.nodo)} could not be loaded${err.message ? ': ' + esc(err.message) : ''}. Please try again later.</div>` : `<div class="cp-board cp-pr-board">
        ${['MDA', 'MTR'].map(p => widget('pr-daily-' + p, `${p} · Daily average ${P}`, 'cp-w-m')).join('')}
        ${['MDA', 'MTR'].map(p => widget('pr-hourly-' + p, `${p} · Hourly average ${P}`, 'cp-w-m')).join('')}
        ${widget('pr-max', 'Maximum price', 'cp-w-m cp-pr-ext', seg('max'))}
        ${widget('pr-min', 'Minimum price', 'cp-w-m cp-pr-ext', seg('min'))}
        ${widget('pr-table', 'Hourly prices', 'cp-w-l', seg('table') + `<button class="cp-pr-switch" id="pr-usd" role="switch" aria-checked="${S.usd}" ${hasFx() ? '' : 'disabled title="Exchange rate not available"'}><span>MXN</span><i></i><span>USD</span></button>` +
          `<button class="cp-pr-dl" id="pr-dl" title="Download Excel with MXN and USD sheets"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>Excel</button>`)}
      </div>`}`;

    // Query controls
    const choose = (sistema, nodo, kind) => { pickNode({ sistema, nodo, kind }); render(); };
    host.querySelector('#pr-sys').onchange = e => {
      const s = e.target.value, st = nodes.find(x => x.sistema === s);
      if (zone) { const z = zonesOf(s)[0]; return z && choose(s, z[0], 'zone'); }
      const first = st ? st.nodo : anyNode() ? (S.catalog.filter(r => r.sistema === s).map(r => r.clave).sort()[0]) : null;
      if (first) choose(s, first);
    };
    const nodeInput = host.querySelector('#pr-node');
    nodeInput.onchange = () => {
      const v = nodeInput.value.trim().toUpperCase();
      if (zone) return choose(n.sistema, v, 'zone');
      if (!anyNode()) return choose(n.sistema, v);
      const hit = S.catalog.find(r => r.sistema === n.sistema && r.clave === v);
      if (hit) return choose(hit.sistema, hit.clave);
      nodeInput.setCustomValidity(`${v} is not a ${n.sistema} NodoP of the catalog.`); nodeInput.reportValidity();
    };
    nodeInput.oninput = () => nodeInput.setCustomValidity('');
    // Distributed nodes on: the selected NodoP's load zone. Off: a NodoP of the selected zone.
    const zc = host.querySelector('#pr-zone');
    if (zc) zc.onchange = () => {
      if (zc.checked) {
        const own = (S.catalog.find(r => r.sistema === n.sistema && r.clave === n.nodo) || {}).zona_carga;
        const z = own && own !== 'No Aplica' ? own : (zonesOf(n.sistema)[0] || [])[0];
        if (z) choose(n.sistema, z, 'zone');
      } else {
        const inZone = S.catalog.filter(r => r.sistema === n.sistema && r.zona_carga === n.nodo).map(r => r.clave).sort();
        const st = nodes.find(x => x.sistema === n.sistema && inZone.includes(x.nodo));
        choose(n.sistema, st ? st.nodo : inZone[0] || (nodes.find(x => x.sistema === n.sistema) || nodes[0]).nodo);
      }
    };
    // Keep the range inside the bounds and, with the Worker, at most 31 days (moving the start)
    const setRange = (f, t) => {
      if (f > t) [f, t] = [t, f];
      f = f < b.min ? b.min : f; t = t > b.max ? b.max : t;
      if (anyNode() && (Date.parse(t) - Date.parse(f)) / 864e5 + 1 > MAX_DAYS) f = addDays(t, 1 - MAX_DAYS);
      S.from = f; S.to = t; render();
    };
    const setDates = () => { const f = host.querySelector('#pr-from').value, t = host.querySelector('#pr-to').value; if (f && t) setRange(f, t); };
    host.querySelector('#pr-cat').onclick = () => NodosCatalog.open(anyNode()
      ? { all: true, onPick: (s, c) => choose(s, c), onPickZone: (s, z) => choose(s, z, 'zone') }
      : { priced: new Set(nodes.map(x => x.sistema + '/' + x.nodo)), onPick: (sistema, clave) => { if (stored(sistema, clave)) choose(sistema, clave); } });
    host.querySelector('#pr-from').onchange = setDates;
    host.querySelector('#pr-to').onchange = setDates;
    host.querySelectorAll('.cp-pr-presets button').forEach(bt => bt.onclick = () => {
      const k = +bt.dataset.n; setRange(k ? addDays(b.max, 1 - k) : b.min, b.max);
    });
    if (err) return;

    // Charts
    const days = []; for (let f = S.from; f <= S.to; f = addDays(f, 1)) days.push(f);
    const hours = Array.from({ length: 24 }, (_, i) => i + 1);
    const series = vals => PARTS.map(([, name, color], i) => ({ name: i ? name : P, color, values: vals[i] }));
    const fmt = v => fx(v) + ' MXN/MWh', axis = v => fx(v, 0);
    ['MDA', 'MTR'].forEach(p => {
      const rows = rowsOf(d, p);
      const daily = host.querySelector(`#pr-daily-${p} .cp-widget-body`), hourly = host.querySelector(`#pr-hourly-${p} .cp-widget-body`);
      if (!rows.length) { daily.innerHTML = hourly.innerHTML = empty(p); return; }
      // Only the days that have data in this process (MTR lags MDA by a week)
      const ds = days.filter(f => rows.some(r => r.fecha === f));
      Board.charts.lineChart(daily, { labels: ds.map(short), series: series(averages(rows, r => r.fecha, ds)), fmt, axis, band: false, off: [1, 2, 3], ranges: [[7, '7D'], [14, '14D'], [30, '30D']] });
      Board.charts.lineChart(hourly, { labels: hours.map(h => 'H' + h), series: series(averages(rows, r => r.hora, hours)), fmt, axis, band: false, off: [1, 2, 3], ranges: false });
      summary(daily, rows, ds.length);
      summary(hourly, rows, ds.length);
    });
    extreme('max'); extreme('min'); table();

    host.querySelectorAll('.cp-pr-seg button').forEach(bt => bt.onclick = () => {
      const w = bt.parentNode.dataset.w; S.proc[w] = bt.dataset.p;
      bt.parentNode.querySelectorAll('button').forEach(o => o.classList.toggle('on', o === bt));
      w === 'table' ? table() : extreme(w);
    });
    const sw = host.querySelector('#pr-usd');
    sw.onclick = () => { S.usd = !S.usd; sw.setAttribute('aria-checked', S.usd); table(); };
    host.querySelector('#pr-dl').onclick = exportXlsx;

    // Excel with the table's rows (selected market and dates), oldest first: one sheet in
    // MXN/MWh and one in USD/MWh, each hour converted at the FX for payments of its day
    function exportXlsx() {
      const p = S.proc.table, rows = rowsOf(d, p);
      if (!rows.length) return;
      const F = ['pml', 'pml_ene', 'pml_cng', 'pml_per'];
      const cols = unit => [{ title: 'Date', width: 12 }, { title: 'Hour', width: 7, fmt: '0' },
        ...[P, 'Energy comp.', 'Congestion comp.', 'Losses comp.'].map(t => ({ title: `${t} (${unit})`, width: 26, fmt: '0.00' }))];
      const round = v => Math.round(v * 1e6) / 1e6;
      Xlsx.download(`${P}_${S.node.sistema}_${S.node.nodo.replace(/ /g, '-')}_${p}_${S.from}_${S.to}.xlsx`, [
        { name: 'MXN', columns: cols('MXN/MWh'), rows: rows.map(r => [r.fecha, r.hora, ...F.map(f => r[f])]) },
        { name: 'USD', columns: [...cols('USD/MWh'), { title: 'FX (MXN/USD)', width: 14, fmt: '0.0000' }],
          rows: rows.map(r => { const t = rateFor(r.fecha); return [r.fecha, r.hora, ...F.map(f => r[f] == null || !t ? null : round(r[f] / t)), t]; }) }
      ]);
    }

    function extreme(w) {
      const body = host.querySelector(`#pr-${w} .cp-widget-body`), p = S.proc[w], rows = rowsOf(d, p);
      if (!rows.length) { body.innerHTML = empty(p); return; }
      const r = rows.reduce((a, c) => (w === 'max' ? c.pml > a.pml : c.pml < a.pml) ? c : a);
      body.innerHTML = `<div class="cp-kpi-value">${fx(r.pml)}<span class="cp-kpi-unit">MXN/MWh</span></div>
        <div class="cp-pr-when">${esc(long(r.fecha))} · Hour ${r.hora} · ${p}</div>
        <div class="cp-pr-parts">${PARTS.slice(1).map(([f, name, color]) => `<div><span><i style="background:${color}"></i>${name}</span><b>${fx(r[f])}</b></div>`).join('')}</div>`;
    }

    function table() {
      const body = host.querySelector('#pr-table .cp-widget-body'), p = S.proc.table, rows = rowsOf(d, p).slice().reverse();
      if (!rows.length) { body.innerHTML = empty(p); return; }
      // Each hour is converted at the rate for payments on its own operating day
      const usd = S.usd && hasFx(), unit = usd ? 'USD/MWh' : 'MXN/MWh';
      const conv = (r, f) => { if (r[f] == null) return null; if (!usd) return r[f]; const t = rateFor(r.fecha); return t ? r[f] / t : null; };
      body.innerHTML = `<div class="cp-pr-fx">${usd
          ? `Each hour is converted at the Banco de México FIX for payments on its operating day (published in the DOF the previous banking day), shown in the FX column. <a href="https://www.banxico.org.mx/tipcamb/tipCamMIAction.do?idioma=sp" target="_blank" rel="noopener noreferrer">Banxico</a>`
          : `Prices in ${unit}. ${hasFx() ? 'Switch to USD to convert each day at its Banxico FIX for payments.' : ''}`}</div>
        <div class="cp-pr-scroll"><table class="cp-mini-table cp-pr-table"><thead><tr><th>Date</th><th>Hour</th>
          ${[P, 'Energy comp.', 'Congestion comp.', 'Losses comp.'].map(t => `<th>${t}<small>${unit}</small></th>`).join('')}${usd ? '<th>FX<small>MXN/USD</small></th>' : ''}</tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.fecha}</td><td>${r.hora}</td>${['pml', 'pml_ene', 'pml_cng', 'pml_per'].map(f => `<td>${fx(conv(r, f))}</td>`).join('')}${usd ? `<td>${fx(rateFor(r.fecha), 4)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        <div class="cp-pr-count">${rows.length} hours · ${p} · ${zone ? 'load zone ' : ''}${esc(S.node.nodo)}</div>`;
    }
  }

  function widget(id, title, cls, tools = '') {
    return `<div class="cp-widget ${cls}" id="${id}"><div class="cp-widget-head"><div class="cp-widget-title">${esc(title)}</div>${tools}</div><div class="cp-widget-body"></div></div>`;
  }
  const seg = w => `<div class="cp-ch-ranges cp-pr-seg" data-w="${w}" role="group" aria-label="Market">${['MDA', 'MTR'].map(p => `<button data-p="${p}" class="${S.proc[w] === p ? 'on' : ''}" title="${PROCS[p]}">${p}</button>`).join('')}</div>`;
  const empty = p => `<div class="cp-widget-empty">No ${p} prices for these dates.${p === 'MTR' ? ' MTR prices are published 7 days after the operating day.' : ''}</div>`;
  function summary(body, rows, n) {
    body.insertAdjacentHTML('beforeend', `<div class="cp-pr-sum">Period average <b>${fx(mean(rows.map(r => r.pml)))}</b> MXN/MWh · ${n} day${n === 1 ? '' : 's'}</div>`);
  }

  return { show };
})();
