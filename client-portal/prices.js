/* ── Sentinels Client Portal · Market Prices page ────────────────────
   Local marginal prices (PML) published by CENACE for the day-ahead (MDA)
   and real-time (MTR) markets. The data is public and is downloaded daily by
   the GitHub Action .github/workflows/pml.yml into /data/pml (one JSON per
   NodoP, plus index.json listing them) and /data/fx/usd-mxn.json (Banxico FIX
   for payments, used for the USD switch). The client picks a NodoP and a date
   range; every widget is computed from the hourly rows in that range.
   Uses Board.charts (board.js) and _esc from index.html. */
const PricesPage = (() => {
  const DATA = '../data/';
  const PROCS = { MDA: 'Day-ahead market (MDA)', MTR: 'Real-time market (MTR)' };
  const PARTS = [['pml', 'PML', '#0B0D0F'], ['pml_ene', 'Energy', '#C89D2A'], ['pml_cng', 'Congestion', '#8C3A36'], ['pml_per', 'Losses', '#5B7FA6']];
  const esc = s => _esc(s);
  const fx = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const day = f => new Date(f + 'T00:00:00');
  const short = f => day(f).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const long = f => day(f).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (f, n) => iso(new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5));
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

  const S = { index: null, fx: null, node: null, from: null, to: null, cache: {}, proc: { max: 'MDA', min: 'MDA', table: 'MDA' }, usd: false, error: null };

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
        const [index, fxData] = await Promise.all([getJSON('pml/index.json'), getJSON('fx/usd-mxn.json').catch(() => null)]);
        S.index = index; S.fx = fxData;
        if (!(index.nodos || []).length) throw new Error('no nodes');
        pickNode(index.nodos[0]);
      } catch { S.error = true; }
    }
    if (S.error) { host.innerHTML = '<div class="cp-card cp-pr-msg">Market prices are not available right now. Please try again later.</div>'; return; }
    await render();
  }

  // Bounds of the data for a NodoP; default view is the last 14 days, so both MDA and MTR show data
  const bounds = n => {
    const r = [n.MDA, n.MTR].filter(Boolean);
    return { min: r.map(x => x.desde).sort()[0], max: r.map(x => x.hasta).sort().at(-1) };
  };
  function pickNode(n) {
    S.node = n;
    const b = bounds(n);
    S.to = b.max; S.from = [addDays(b.max, -13), b.min].sort().at(-1);
  }

  async function nodeData() {
    const k = S.node.sistema + '/' + S.node.nodo;
    if (!S.cache[k]) S.cache[k] = await getJSON(`pml/${encodeURIComponent(S.node.sistema)}/${encodeURIComponent(S.node.nodo)}.json`);
    return S.cache[k];
  }
  const rowsOf = (d, p) => (d[p] || []).filter(r => r.fecha >= S.from && r.fecha <= S.to && r.pml != null);

  // Daily / hourly averages of the PML and each of its components
  function averages(rows, keyOf, keys) {
    const groups = new Map(keys.map(k => [k, []]));
    rows.forEach(r => { const g = groups.get(keyOf(r)); if (g) g.push(r); });
    return PARTS.map(([f]) => keys.map(k => mean(groups.get(k).map(r => r[f]).filter(v => v != null))));
  }

  /* ── Page ─────────────────────────────────────── */
  async function render() {
    const host = document.getElementById('prices-root');
    let d;
    try { d = await nodeData(); } catch { host.innerHTML = '<div class="cp-card cp-pr-msg">The prices for this NodoP could not be loaded.</div>'; return; }
    const b = bounds(S.node), nodes = S.index.nodos;
    const systems = [...new Set(nodes.map(n => n.sistema))];
    const avail = p => S.node[p] ? `${p} ${short(S.node[p].desde)} – ${long(S.node[p].hasta)}` : `${p} not available`;
    const span = (Date.parse(S.to) - Date.parse(S.from)) / 864e5 + 1;
    host.innerHTML = `
      <div class="cp-card cp-pr-bar">
        <label class="cp-pr-f"><span>System</span><select id="pr-sys">${systems.map(s => `<option ${s === S.node.sistema ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label class="cp-pr-f cp-pr-f--node"><span>NodoP</span><select id="pr-node">${nodes.filter(n => n.sistema === S.node.sistema).map(n => `<option ${n.nodo === S.node.nodo ? 'selected' : ''}>${esc(n.nodo)}</option>`).join('')}</select></label>
        <label class="cp-pr-f"><span>From</span><input type="date" id="pr-from" value="${S.from}" min="${b.min}" max="${b.max}"></label>
        <label class="cp-pr-f"><span>To</span><input type="date" id="pr-to" value="${S.to}" min="${b.min}" max="${b.max}"></label>
        <div class="cp-pr-presets" role="group" aria-label="Quick ranges">${[[7, '7D'], [14, '14D'], [30, '30D'], [0, 'All']].map(([n, t]) =>
          `<button class="cp-doc-filter ${S.to === b.max && (n ? span === n && S.from === addDays(b.max, 1 - n) : S.from === b.min) ? 'active' : ''}" data-n="${n}">${t}</button>`).join('')}</div>
        <div class="cp-pr-note">${esc(avail('MDA'))} · ${esc(avail('MTR'))}. MTR prices are published 7 days after the operating day. Source: CENACE.</div>
      </div>
      <div class="cp-board cp-pr-board">
        ${['MDA', 'MTR'].map(p => widget('pr-daily-' + p, p + ' · Daily average PML', 'cp-w-m')).join('')}
        ${['MDA', 'MTR'].map(p => widget('pr-hourly-' + p, p + ' · Hourly average PML', 'cp-w-m')).join('')}
        ${widget('pr-max', 'Maximum price', 'cp-w-m cp-pr-ext', seg('max'))}
        ${widget('pr-min', 'Minimum price', 'cp-w-m cp-pr-ext', seg('min'))}
        ${widget('pr-table', 'Hourly prices', 'cp-w-l', seg('table') + `<button class="cp-pr-switch" id="pr-usd" role="switch" aria-checked="${S.usd}" ${hasFx() ? '' : 'disabled title="Exchange rate not available"'}><span>MXN</span><i></i><span>USD</span></button>`)}
      </div>`;

    // Query controls
    host.querySelector('#pr-sys').onchange = e => { pickNode(nodes.find(n => n.sistema === e.target.value)); render(); };
    host.querySelector('#pr-node').onchange = e => { pickNode(nodes.find(n => n.sistema === S.node.sistema && n.nodo === e.target.value)); render(); };
    const setDates = () => {
      let f = host.querySelector('#pr-from').value, t = host.querySelector('#pr-to').value;
      if (!f || !t) return;
      if (f > t) [f, t] = [t, f];
      S.from = f < b.min ? b.min : f; S.to = t > b.max ? b.max : t; render();
    };
    host.querySelector('#pr-from').onchange = setDates;
    host.querySelector('#pr-to').onchange = setDates;
    host.querySelectorAll('.cp-pr-presets button').forEach(bt => bt.onclick = () => {
      const n = +bt.dataset.n; S.to = b.max; S.from = n ? [addDays(b.max, 1 - n), b.min].sort().at(-1) : b.min; render();
    });

    // Charts
    const days = []; for (let f = S.from; f <= S.to; f = addDays(f, 1)) days.push(f);
    const hours = Array.from({ length: 24 }, (_, i) => i + 1);
    const series = vals => PARTS.map(([, name, color], i) => ({ name, color, values: vals[i] }));
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
          ${['PML', 'Energy comp.', 'Congestion comp.', 'Losses comp.'].map(t => `<th>${t}<small>${unit}</small></th>`).join('')}${usd ? '<th>FX<small>MXN/USD</small></th>' : ''}</tr></thead>
          <tbody>${rows.map(r => `<tr><td>${r.fecha}</td><td>${r.hora}</td>${['pml', 'pml_ene', 'pml_cng', 'pml_per'].map(f => `<td>${fx(conv(r, f))}</td>`).join('')}${usd ? `<td>${fx(rateFor(r.fecha), 4)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
        <div class="cp-pr-count">${rows.length} hours · ${p} · ${esc(S.node.nodo)}</div>`;
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
