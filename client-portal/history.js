/* ── Sentinels Client Portal · Market Prices · Long-term history ─────
   Hourly prices since 2016 for the NodosP and load zones listed in
   scripts/historico-lista.json. The "Robot" (.github/workflows/historico.yml,
   scripts/fetch-historico.mjs) loads them gradually from CENACE and stores only
   the raw hourly rows in /data/historico; everything shown here is computed in
   the browser by the VIEWS below (the equivalent of SQL views over one table):

     precios_hora(proceso, fecha, hora, precio, energia, perdidas, congestion)
     v_diario   = SELECT fecha, AVG(precio)…                 GROUP BY proceso, fecha
     v_mensual  = SELECT mes, AVG/MAX/MIN(precio)…           GROUP BY proceso, mes
     v_anual    = SELECT año, AVG/MAX/MIN(precio)…           GROUP BY proceso, año
     v_perfil   = SELECT año, hora, AVG(precio)              GROUP BY proceso, año, hora

   The data is loaded only when the client asks for it ("Load history").
   Used by prices.js: PriceHistory.mount(el, { node, priceName, onPick }).
   Uses Board.charts (board.js), Xlsx (xlsx.js) and _esc (index.html). */
const PriceHistory = (() => {
  const DATA = '../data/historico/';
  const esc = s => _esc(s);
  const fx = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mlabel = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}`;
  const dlabel = f => new Date(f + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const C = { MDA: '#0B0D0F', MTR: '#C89D2A' };
  const YEAR_COLORS = ['#0B0D0F', '#C89D2A', '#3E6B53', '#5B7FA6', '#8C3A36', '#9A6FB0', '#646C75', '#B4BBC2', '#2F8F9D', '#D17A22', '#6B8E23'];
  let INDEX = null;
  const loaded = {};  // entity key → { MDA: rows, MTR: rows }

  const keyOf = n => `${n.kind === 'zone' ? 'zona' : 'nodo'}|${n.sistema}|${n.nodo}`;
  const entKey = e => `${e.tipo}|${e.sistema}|${e.clave}`;
  async function index() {
    if (!INDEX) {
      const r = await fetch(DATA + 'index.json', { cache: 'no-cache' });
      INDEX = r.ok ? await r.json() : { entidades: [] };
    }
    return INDEX;
  }

  /* ── Table: precios_hora (only stored data) ── */
  async function load(ent) {
    const k = entKey(ent);
    if (!loaded[k]) {
      loaded[k] = Promise.all(['MDA', 'MTR'].map(async p => {
        const files = (ent[p] && ent[p].archivos) || [];
        const parts = await Promise.all(files.map(f => fetch(DATA + f, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null)));
        const rows = [];
        for (const part of parts) if (part) for (const [md, h, pr, e, l, c] of part.filas) {
          const m = Math.floor(md / 100), d = md % 100;
          rows.push({ fecha: `${part.anio}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, hora: h, precio: pr, energia: e, perdidas: l, congestion: c });
        }
        return rows.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.hora - b.hora);
      })).then(([MDA, MTR]) => ({ MDA, MTR }));
      loaded[k].catch(() => delete loaded[k]);
    }
    return loaded[k];
  }

  /* ── Views ── */
  // Generic GROUP BY: average of the price and its components, plus the max / min hour
  function groupBy(rows, keyFn) {
    const g = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      let a = g.get(k);
      if (!a) g.set(k, a = { key: k, n: 0, precio: 0, energia: 0, perdidas: 0, congestion: 0, max: r, min: r });
      a.n++; a.precio += r.precio; a.energia += r.energia || 0; a.perdidas += r.perdidas || 0; a.congestion += r.congestion || 0;
      if (r.precio > a.max.precio) a.max = r;
      if (r.precio < a.min.precio) a.min = r;
    }
    return [...g.values()].map(a => ({ ...a, precio: a.precio / a.n, energia: a.energia / a.n, perdidas: a.perdidas / a.n, congestion: a.congestion / a.n }));
  }
  const VIEWS = {
    v_diario: rows => groupBy(rows, r => r.fecha),
    v_mensual: rows => groupBy(rows, r => r.fecha.slice(0, 7)),
    v_anual: rows => groupBy(rows, r => r.fecha.slice(0, 4)),
    v_perfil: rows => groupBy(rows, r => r.fecha.slice(0, 4) + '|' + r.hora)
  };

  /* ── UI ── */
  async function mount(el, { node, priceName, onPick }) {
    if (!el) return;
    let idx;
    try { idx = await index(); } catch { idx = { entidades: [] }; }
    if (!el.isConnected) return;
    const P = priceName, ent = idx.entidades.find(e => entKey(e) === keyOf(node));
    const label = e => e.tipo === 'zona' ? `${e.clave} (load zone)` : e.clave;
    const head = `<div class="cp-hi-head"><div><h2 class="cp-hi-title">Long-term history</h2>
      <p class="cp-hi-sub">Hourly ${P} since 2016, kept by the Sentinels data robot and analysed in your browser.</p></div></div>`;

    if (!ent) {
      const others = idx.entidades;
      el.innerHTML = `<div class="cp-card cp-hi">${head}<div class="cp-hi-msg">Long-term history is not kept for ${node.kind === 'zone' ? 'load zone ' : ''}<b>${esc(node.nodo)}</b> yet. Ask your Sentinel advisor to add it.</div>
        ${others.length ? `<div class="cp-hi-chips"><span>Available for:</span>${others.map(e => `<button class="cp-doc-filter" data-e="${esc(entKey(e))}">${esc(label(e))}</button>`).join('')}</div>` : ''}</div>`;
      el.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { const e = others.find(x => entKey(x) === b.dataset.e); onPick(e.sistema, e.clave, e.tipo === 'zona' ? 'zone' : undefined); });
      return;
    }

    const prog = ['MDA', 'MTR'].map(p => ent[p] && ent[p].desde
      ? `${p} ${dlabel(ent[p].desde)} – ${dlabel(ent[p].hasta)}${ent[p].completo ? '' : ` · loading ${ent[p].avance}%`}` : `${p} not loaded yet`).join(' · ');
    const files = ['MDA', 'MTR'].reduce((t, p) => t + ((ent[p] && ent[p].archivos) || []).length, 0);
    el.innerHTML = `<div class="cp-card cp-hi">${head}
      <div class="cp-hi-msg">${esc(prog)}.${['MDA', 'MTR'].some(p => !(ent[p] && ent[p].completo)) ? ' The robot keeps adding older years every hour.' : ''}</div>
      <div class="cp-hi-body">${loaded[entKey(ent)] ? '' : `<button class="cp-btn-dark cp-btn-sm" id="hi-load" ${files ? '' : 'disabled'}>Load history</button>`}</div></div>`;
    const body = el.querySelector('.cp-hi-body');
    const show = async () => {
      body.innerHTML = '<div class="cp-hi-msg">Loading the hourly history…</div>';
      let d;
      try { d = await load(ent); } catch { body.innerHTML = '<div class="cp-hi-msg">The history could not be loaded. Please try again later.</div>'; return; }
      if (el.isConnected) draw(body, d, ent, P);
    };
    const btn = el.querySelector('#hi-load');
    if (btn) btn.onclick = show; else show();
  }

  function draw(body, d, ent, P) {
    const W = (id, title, cls, tools = '') => `<div class="cp-widget ${cls}" id="${id}"><div class="cp-widget-head"><div class="cp-widget-title">${esc(title)}</div>${tools}</div><div class="cp-widget-body"></div></div>`;
    const seg = `<div class="cp-ch-ranges cp-pr-seg" role="group" aria-label="Market">${['MDA', 'MTR'].map((p, i) => `<button data-p="${p}" class="${i ? '' : 'on'}">${p}</button>`).join('')}</div>`;
    const dl = '<button class="cp-pr-dl" id="hi-xlsx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>Excel</button>';
    body.innerHTML = `<div class="cp-board cp-pr-board cp-hi-board">
      ${W('hi-month', `Monthly average ${P} · MDA vs MTR`, 'cp-w-l', dl)}
      ${W('hi-year', `Annual summary ${P}`, 'cp-w-l')}
      ${W('hi-profile', `Average hourly profile by year · ${P}`, 'cp-w-l', seg)}</div>`;
    const fmt = v => fx(v) + ' MXN/MWh', axis = v => fx(v, 0);

    // Monthly averages of both markets on one timeline
    const m = { MDA: VIEWS.v_mensual(d.MDA), MTR: VIEWS.v_mensual(d.MTR) };
    const months = [...new Set([...m.MDA, ...m.MTR].map(r => r.key))].sort();
    const byKey = p => new Map(m[p].map(r => [r.key, r.precio]));
    const mda = byKey('MDA'), mtr = byKey('MTR');
    Board.charts.lineChart(body.querySelector('#hi-month .cp-widget-body'), {
      labels: months.map(mlabel), fmt, axis, band: false, ranges: [[12, '1Y'], [36, '3Y'], [60, '5Y']],
      series: [{ name: 'MDA', color: C.MDA, values: months.map(k => mda.get(k) ?? null) }, { name: 'MTR', color: C.MTR, values: months.map(k => mtr.get(k) ?? null) }]
    });

    // Annual summary table (newest year first)
    const y = { MDA: new Map(VIEWS.v_anual(d.MDA).map(r => [r.key, r])), MTR: new Map(VIEWS.v_anual(d.MTR).map(r => [r.key, r])) };
    const years = [...new Set([...y.MDA.keys(), ...y.MTR.keys()])].sort().reverse();
    // A year is partial when it lacks more than two days of hours (not loaded yet, or the current year)
    const partial = (k, r) => !r || r.n < ((+k % 4 ? 365 : 366) - 2) * 24;
    const cell = r => r ? `<td>${fx(r.precio)}</td><td>${fx(r.max.precio)}<small>${esc(r.max.fecha)} · H${r.max.hora}</small></td><td>${fx(r.min.precio)}<small>${esc(r.min.fecha)} · H${r.min.hora}</small></td>` : '<td>—</td><td>—</td><td>—</td>';
    body.querySelector('#hi-year .cp-widget-body').innerHTML = `<div class="cp-pr-scroll cp-hi-scroll"><table class="cp-mini-table cp-pr-table cp-hi-table"><thead><tr><th>Year</th>
        <th>MDA avg<small>MXN/MWh</small></th><th>MDA max</th><th>MDA min</th><th>MTR avg<small>MXN/MWh</small></th><th>MTR max</th><th>MTR min</th><th>MTR − MDA<small>avg</small></th></tr></thead>
      <tbody>${years.map(k => { const a = y.MDA.get(k), b = y.MTR.get(k); return `<tr><td>${k}${partial(k, a) || partial(k, b) ? '<small>partial</small>' : ''}</td>${cell(a)}${cell(b)}<td>${a && b ? fx(b.precio - a.precio) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="cp-pr-count">Averages of every hour of the year · "partial" = the year is not complete in the history yet</div>`;

    // Hourly profile: one line per year; the last three years start visible
    const profile = p => {
      const v = VIEWS.v_perfil(d[p]), ys = [...new Set(v.map(r => r.key.split('|')[0]))].sort();
      const map = new Map(v.map(r => [r.key, r.precio]));
      const el = body.querySelector('#hi-profile .cp-widget-body');
      if (!ys.length) { el.innerHTML = `<div class="cp-widget-empty">No ${p} history yet.</div>`; return; }
      Board.charts.lineChart(el, {
        labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), fmt, axis, band: false, ranges: false,
        series: ys.map((yr, i) => ({ name: yr, color: YEAR_COLORS[(ys.length - 1 - i) % YEAR_COLORS.length], values: Array.from({ length: 24 }, (_, h) => map.get(yr + '|' + (h + 1)) ?? null) })),
        off: ys.map((_, i) => i).filter(i => i < ys.length - 3)
      });
    };
    profile('MDA');
    body.querySelectorAll('#hi-profile .cp-pr-seg button').forEach(bt => bt.onclick = () => {
      body.querySelectorAll('#hi-profile .cp-pr-seg button').forEach(o => o.classList.toggle('on', o === bt)); profile(bt.dataset.p);
    });

    // Excel: the three views, ready for pivot tables
    body.querySelector('#hi-xlsx').onclick = () => {
      const n2 = { width: 14, fmt: '0.00' };
      const rowsOf = (view, p) => VIEWS[view](d[p]).sort((a, b) => a.key < b.key ? -1 : 1).map(r => [p, r.key, r.precio, r.energia, r.perdidas, r.congestion, r.max.precio, r.min.precio, r.n]);
      const cols = keyTitle => [{ title: 'Market', width: 8 }, { title: keyTitle, width: 12 }, { title: P + ' avg', ...n2 }, { title: 'Energy avg', ...n2 }, { title: 'Losses avg', ...n2 },
        { title: 'Congestion avg', ...n2 }, { title: P + ' max', ...n2 }, { title: P + ' min', ...n2 }, { title: 'Hours', width: 8, fmt: '0' }];
      Xlsx.download(`${P}_history_${ent.sistema}_${ent.clave.replace(/ /g, '-')}.xlsx`, [
        { name: 'Monthly', columns: cols('Month'), rows: [...rowsOf('v_mensual', 'MDA'), ...rowsOf('v_mensual', 'MTR')] },
        { name: 'Annual', columns: cols('Year'), rows: [...rowsOf('v_anual', 'MDA'), ...rowsOf('v_anual', 'MTR')] },
        { name: 'Daily', columns: cols('Date'), rows: [...rowsOf('v_diario', 'MDA'), ...rowsOf('v_diario', 'MTR')] }
      ]);
    };
  }

  return { mount, VIEWS };
})();
