/* ── Sentinels Client Portal · MEM Insights ──────────────────────────
   Supply and bids of the wholesale market (MDA / MTR), for traders and guests
   (profiles.js). Reads the summaries that scripts/ofertas-resumen.mjs writes to
   the private offers bucket, through the PML Worker's /ofertas/ route
   (Market.offers, with the client's market pass). Views:
     curve      merit-order supply curve of an hour, crossing with demand,
                estimated price vs the PML energy component, and the model's fit
     deviation  day-ahead (MDA) vs real-time (MTR) offered MW by type and Short CE
     costs      thermal costs (unit cost at minimum and each block) by Short CE
     hydro      hydro opportunity costs and shadow prices
     purchases  purchase bids by Short (year to date)
     reserves   hourly reserve validation: MDA→MTR thermal/hydro changes vs required
                and assigned reserves
   Uses Market (market.js), Board.charts (board.js) and _esc. */
const InsightsPage = (() => {
  const esc = s => _esc(s);
  const fx = (v, d = 0) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const C = { ink: '#0B0D0F', gold: '#C89D2A', steel: '#646C75', grid: '#E3E6E8', green: '#3E6B53', red: '#9B3B2E', blue: '#2F5D8A', silver: '#B4BBC2' };
  // Offer types of the supply curve, in the order of the summaries (resumen/curva … tipos)
  const TYPE = {
    tomador: ['Must-run thermal (minimum)', '#8A8F96'], nodespachable: ['Non-dispatchable', '#B4BBC2'], gi: ['Legacy (GI)', '#7C6A9E'],
    importacion: ['Imports', '#2F5D8A'], intermitente: ['Wind / solar', '#3E6B53'], hidro: ['Hydro', '#4F8FB8'],
    termica_min: ['Thermal (minimum block)', '#C89D2A'], termica: ['Thermal', '#9B3B2E'], hidro_real: ['Hydro (actual generation)', '#4F8FB8'],
  };
  const VIEWS = [['curve', 'Supply curve'], ['deviation', 'MDA vs MTR'], ['costs', 'Thermal costs'], ['hydro', 'Hydro'], ['purchases', 'Purchases'], ['reserves', 'Reserves']];
  const DEV = { intermitente: 'Wind / solar forecast', nodespachable: 'Non-dispatchable', termica: 'Thermal available capacity', hidro: 'Hydro available capacity' };
  const RES = { rod10: 'Spinning 10 min', nr10: 'Non-spinning 10 min', rsup: 'Spinning supplemental', nrsup: 'Non-spinning supplemental', reg: 'Regulation' };

  const S = { view: 'curve', sys: 'SIN', year: null, fecha: null, hora: 20, mkt: 'MDA', devType: 'nodespachable', short: '', ce: '', costMkt: 'MDA', buyer: '' };
  const cache = new Map();
  let seq = 0;

  // A summary of the bucket (Market.offers), kept for the session
  function get(path) {
    if (!cache.has(path)) cache.set(path, Market.offers(path).catch(e => { cache.delete(path); throw e; }));
    return cache.get(path);
  }
  const widget = (id, title, cls, tools = '') =>
    `<div class="cp-widget ${cls}" id="${id}"><div class="cp-widget-head"><div class="cp-widget-title">${esc(title)}</div>${tools}</div><div class="cp-widget-body"></div></div>`;
  const body = (host, id) => host.querySelector(`#${id} .cp-widget-body`);
  const seg = (name, opts, cur) => `<div class="cp-ch-ranges cp-in-seg" data-seg="${name}" role="group">${opts.map(([v, t]) => `<button data-v="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>`;
  const kpi = (label, value, unit = '', note = '') =>
    `<div class="cp-in-kpi"><div class="cp-kpi-eyebrow">${esc(label)}</div><div class="cp-in-kpi-v">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${note ? `<div class="cp-in-kpi-n">${note}</div>` : ''}</div>`;
  const short = f => new Date(f + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const long = f => new Date(f + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

  async function show() {
    const host = document.getElementById('insights-root');
    if (!Market.ready()) { host.innerHTML = `<div class="cp-card cp-pr-msg">Market data is not enabled for your account yet. Please contact Sentinels.</div>`; return; }
    if (!S.year) S.year = new Date().getUTCFullYear();
    render();
  }

  async function render() {
    const host = document.getElementById('insights-root'), my = ++seq;
    host.classList.add('cp-pr-loading');
    host.dataset.loading = 'Loading MEM Insights…';
    let serie, err = null;
    try {
      serie = await get(`curva/serie_${S.year}_${S.sys}.json`);
      if (!serie && S.year > 2026) { S.year--; return render(); }
    } catch (e) { err = e; }
    if (my !== seq) return;
    host.classList.remove('cp-pr-loading');
    const days = serie ? Object.keys(serie.dias).sort() : [];
    if (!S.fecha || !days.includes(S.fecha)) S.fecha = days.at(-1) || null;
    host.innerHTML = `
      <div class="cp-card cp-pr-bar">
        <div class="cp-pr-row">
          <label class="cp-pr-f"><span>System</span><select id="in-sys">${['SIN', 'BCA', 'BCS'].map(s => `<option ${s === S.sys ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="cp-pr-f"><span>Operating day</span><input type="date" id="in-date" value="${S.fecha || ''}" min="${days[0] || ''}" max="${days.at(-1) || ''}"></label>
          <div class="cp-in-views" role="tablist">${VIEWS.map(([v, t]) => `<button class="cp-doc-filter ${v === S.view ? 'active' : ''}" data-view="${v}" role="tab" aria-selected="${v === S.view}">${t}</button>`).join('')}</div>
        </div>
        <div class="cp-pr-note">${days.length ? `<b>${days.length} days</b> · ${long(days[0])} – ${long(days.at(-1))}. ` : ''}Offers are published by CENACE about 60 days after the operating day. Source: CENACE (SIM), Sentinels model.</div>
      </div>
      <div id="in-view"></div>`;
    host.querySelector('#in-sys').onchange = e => { S.sys = e.target.value; S.short = S.ce = S.buyer = ''; render(); };
    host.querySelector('#in-date').onchange = e => { if (days.includes(e.target.value)) { S.fecha = e.target.value; view(); } else e.target.value = S.fecha; };
    host.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view; render(); });
    if (err || !serie) {
      host.querySelector('#in-view').innerHTML = `<div class="cp-card cp-pr-msg">${err ? esc(err.message) : 'MEM Insights has no data for this system yet.'}</div>`;
      return;
    }
    view(serie);
  }

  // Renders the current view below the bar; segmented buttons change S and re-render the view
  async function view(serie) {
    const host = document.querySelector('#in-view'), my = seq;
    host.innerHTML = '<div class="cp-card cp-pr-msg">Loading…</div>';
    try {
      serie = serie || await get(`curva/serie_${S.year}_${S.sys}.json`);
      const html = await ({ curve, deviation, costs, hydro, purchases, reserves })[S.view](host, serie);
      if (my !== seq) return;
      if (html) host.innerHTML = html;
    } catch (e) {
      if (my === seq) host.innerHTML = `<div class="cp-card cp-pr-msg">This view could not be loaded${e.message ? ': ' + esc(e.message) : ''}. Please try again later.</div>`;
    }
    host.querySelectorAll('.cp-in-seg').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
      const k = g.dataset.seg;
      S[k] = /^\d+$/.test(b.dataset.v) ? +b.dataset.v : b.dataset.v;
      view();
    }));
  }

  /* ── Supply curve ─────────────────────────────── */
  async function curve(host, serie) {
    const [dia, fit] = await Promise.all([get(`curva/${S.year}/${S.fecha}_${S.sys}.json`), get(`ajuste/${S.year}.json`)]);
    if (!dia) return `<div class="cp-card cp-pr-msg">No supply curve for ${esc(long(S.fecha))}.</div>`;
    const hrs = dia.horas.map(h => h.hora);
    if (!hrs.includes(S.hora)) S.hora = hrs.includes(20) ? 20 : hrs[0];
    const h = dia.horas.find(x => x.hora === S.hora), mtr = S.mkt === 'MTR';
    const c = mtr ? h.mtr : h, pml = mtr ? h.pml.energia_mtr : h.pml.energia_mda;
    const dem = mtr ? h.real.generacion : h.demanda.total;
    const m = (fit && fit.sistemas[S.sys] && fit.sistemas[S.sys][mtr ? 'mtr' : 'mda']) || {}, mes = S.fecha.slice(0, 7);
    const fm = m[mes] || m.total || {};
    const marg = c && c.marginal ? `${(TYPE[c.marginal.tipo] || [c.marginal.tipo])[0]}${c.marginal.ce ? ' · ' + c.marginal.ce : ''}` : '—';
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi(`Estimated price · ${S.mkt}`, fx(c && c.precio, 2), 'MXN/MWh', esc('Marginal offer: ' + marg))}
        ${kpi(`PML energy component · ${S.mkt}`, fx(pml, 2), 'MXN/MWh', 'Same in every node of the system')}
        ${kpi('Difference', c && c.precio != null && pml != null ? (c.precio >= pml ? '+' : '') + fx(c.precio - pml, 2) : '—', 'MXN/MWh', pml ? esc(`${fx(100 * (c.precio - pml) / pml, 1)}% of the PML energy component`) : '')}
        ${kpi(mtr ? 'Actual generation' : 'Demand (bids)', fx(dem), 'MW', mtr ? 'Real demand estimate (balance)' : `Real demand estimate: ${fx(h.real.balance)} MW`)}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-curve', `Supply curve · ${long(S.fecha)} · hour ${S.hora}`, 'cp-w-l', seg('mkt', [['MDA', 'MDA'], ['MTR', 'MTR ex post']], S.mkt) +
          `<label class="cp-pr-f cp-in-hour"><select id="in-hour" aria-label="Hour">${hrs.map(x => `<option value="${x}" ${x === S.hora ? 'selected' : ''}>H${x}</option>`).join('')}</select></label>`)}
        ${widget('in-day', `Estimated price vs PML energy component · ${long(S.fecha)}`, 'cp-w-m')}
        ${widget('in-year', `Daily average · ${S.year}`, 'cp-w-m')}
        ${widget('in-fit', `Model fit · ${S.mkt}${m[mes] ? ' · ' + new Date(mes + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : ''}`, 'cp-w-l')}
      </div>`;
    host.querySelector('#in-hour').onchange = e => { S.hora = +e.target.value; view(); };
    stepChart(body(host, 'in-curve'), c ? c.curva : [], dia.tipos, dem, pml, c && c.precio);
    const est = dia.horas.map(x => mtr ? x.mtr && x.mtr.precio : x.precio), ene = dia.horas.map(x => mtr ? x.pml.energia_mtr : x.pml.energia_mda);
    const pf = v => fx(v, 2) + ' MXN/MWh', ax = v => fx(v);
    Board.charts.lineChart(body(host, 'in-day'), { labels: hrs.map(x => 'H' + x), series: [{ name: 'PML energy component', color: C.ink, values: ene }, { name: 'Estimated price', color: C.gold, values: est }], fmt: pf, axis: ax, band: false, ranges: false });
    const ds = Object.keys(serie.dias).sort(), col = n => serie.columnas.indexOf(n);
    const [iE, iP] = mtr ? [col('precio_mtr'), col('energia_pml_mtr')] : [col('precio_mda'), col('energia_pml_mda')];
    Board.charts.lineChart(body(host, 'in-year'), { labels: ds.map(short), series: [
      { name: 'PML energy component', color: C.ink, values: ds.map(d => mean(serie.dias[d].map(r => r[iP]))) },
      { name: 'Estimated price', color: C.gold, values: ds.map(d => mean(serie.dias[d].map(r => r[iE]))) }], fmt: pf, axis: ax, band: false, ranges: [[30, '30D'], [90, '90D']] });
    body(host, 'in-fit').innerHTML = fm.horas ? `<div class="cp-in-fit">
        ${kpi('Hours within ±10%', fx(fm.pct_dentro_10, 1), '%', `${fx(fm.horas)} hours compared`)}
        ${kpi('Average absolute error', fx(fm.error_abs_prom, 2), 'MXN/MWh')}
        ${kpi('Bias', (fm.sesgo >= 0 ? '+' : '') + fx(fm.sesgo, 2), 'MXN/MWh', fm.sesgo < 0 ? 'Estimate below the PML on average' : 'Estimate above the PML on average')}
        ${kpi('Hourly correlation', fx(fm.correlacion, 2))}
      </div><p class="cp-in-foot">The model stacks the published offers in merit order: must-run units, wind/solar, legacy (GI) and non-dispatchable programs first; hydro at its actual generation; thermal units committed by a priority list with their minimum as must-run and their blocks at their incremental cost${mtr ? '' : '; spinning reserve held on committed units'}. CENACE also solves start-ups, ramps, reserves and the network, so hours differ.</p>`
      : '<div class="cp-widget-empty">No fit statistics for this period yet.</div>';
    return null;
  }

  // Step chart of the merit order: x = cumulative MW, y = MXN/MWh, colored by offer type
  function stepChart(el, pts, tipos, demand, pml, price) {
    const used = [...new Set(pts.map(p => tipos[p[2]]))];
    el.innerHTML = `<div class="cp-ch-bar"><div class="cp-ch-legend">${used.map(t => `<span class="cp-ch-key"><span style="background:${(TYPE[t] || ['', C.steel])[1]}"></span>${esc((TYPE[t] || [t])[0])}</span>`).join('')}
      <span class="cp-ch-key"><span class="cp-in-dash"></span>Demand</span><span class="cp-ch-key"><span style="background:${C.ink}"></span>PML energy</span></div></div><div class="cp-ch-plot"><div class="cp-ch-tip" hidden></div></div>`;
    const plot = el.querySelector('.cp-ch-plot'), tip = el.querySelector('.cp-ch-tip');
    if (!pts.length) { plot.insertAdjacentHTML('beforeend', '<div class="cp-widget-empty">No offers for this hour.</div>'); return; }
    // Y axis up to a bit above the price that matters, so a few very expensive blocks don't flatten the chart
    const prices = pts.map(p => p[1]).sort((a, b) => a - b), top = Math.max(prices[Math.floor(prices.length * 0.95)], (pml || 0) * 1.4, (price || 0) * 1.4) || 1;
    // Zoom to where the curve crosses demand: most of the supply comes in at zero price (must-run,
    // wind/solar, legacy, hydro), so the axis starts a little before the first priced block
    const X = pts.at(-1)[0], cero = (pts.find(p => p[1] > 0) ? pts[pts.findIndex(p => p[1] > 0) - 1] || [0] : pts.at(-1))[0];
    const x0 = Math.max(0, Math.min(cero, (demand || X) * 0.75) - X * 0.03), x1 = Math.min(X, Math.max((demand || 0) * 1.15, cero * 1.08, x0 + X * 0.2));
    const draw = () => {
      const W = plot.clientWidth; if (!W) return;
      const H = matchMedia('(max-width:600px)').matches ? 240 : 300, pL = 52, pR = 14, pT = 12, pB = 28;
      plot.style.height = H + 'px';
      const x = v => pL + (Math.min(Math.max(v, x0), x1) - x0) / (x1 - x0) * (W - pL - pR), y = v => pT + (1 - Math.min(Math.max(v, 0), top) / top) * (H - pT - pB);
      let g = '';
      const step = [1, 2, 2.5, 5, 10].map(k => k * 10 ** Math.floor(Math.log10(top / 4))).find(s => s >= top / 4);
      for (let v = 0; v <= top; v += step) g += `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${pL - 6}" y="${y(v) + 3.5}" text-anchor="end" class="cp-ch-ax">${fx(v)}</text>`;
      const span = x1 - x0, xs = [1, 2, 2.5, 5, 10].map(k => k * 10 ** Math.floor(Math.log10(span / 4))).find(s => s >= span / Math.max(3, Math.floor((W - pL - pR) / 80)));
      for (let v = Math.ceil(x0 / xs) * xs; v <= x1; v += xs) g += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle" class="cp-ch-ax">${fx(v / 1000, v % 1000 ? 1 : 0)}k</text>`;
      if (x0 > 0) g += `<text x="${pL + 4}" y="${y(0) - 6}" class="cp-ch-ax">← ${fx(cero)} MW at zero price</text>`;
      let prev = 0;
      pts.forEach(([mw, p, t]) => {
        if (mw <= x0 || prev >= x1) { prev = mw; return; }
        const col = (TYPE[tipos[t]] || ['', C.steel])[1];
        g += `<rect x="${x(prev)}" y="${y(p)}" width="${Math.max(0.5, x(mw) - x(prev))}" height="${Math.max(0, y(0) - y(p))}" fill="${col}" opacity="0.28"/>`;
        g += `<line x1="${x(prev)}" x2="${x(mw)}" y1="${y(p)}" y2="${y(p)}" stroke="${col}" stroke-width="2"/>`;
        prev = mw;
      });
      if (pml != null) g += `<line x1="${pL}" x2="${W - pR}" y1="${y(pml)}" y2="${y(pml)}" stroke="${C.ink}" stroke-width="1.5"/><text x="${pL + 4}" y="${y(pml) - 5}" class="cp-ch-ax">PML energy ${fx(pml)}</text>`;
      if (demand != null) g += `<line x1="${x(demand)}" x2="${x(demand)}" y1="${pT}" y2="${H - pB}" stroke="${C.ink}" stroke-dasharray="5 4" stroke-width="1.5"/><text x="${x(demand) - 4}" y="${pT + 10}" text-anchor="end" class="cp-ch-ax">Demand ${fx(demand)} MW</text>`;
      if (price != null && demand != null) g += `<circle cx="${x(demand)}" cy="${y(price)}" r="5" fill="#fff" stroke="${C.gold}" stroke-width="2.5"/>`;
      g += `<text x="${W - pR}" y="${H - 8}" text-anchor="end" class="cp-ch-ax">MW</text>`;
      plot.querySelector('svg')?.remove();
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.innerHTML = g; plot.prepend(svg);
      svg.onpointermove = ev => {
        const mwAt = x0 + (ev.clientX - svg.getBoundingClientRect().left - pL) / (W - pL - pR) * (x1 - x0);
        const i = pts.findIndex(p => p[0] >= mwAt), p = pts[Math.max(0, i)];
        if (!p || mwAt < 0) return (tip.hidden = true);
        tip.innerHTML = `<div class="cp-ch-tip-t">${esc((TYPE[tipos[p[2]]] || [tipos[p[2]]])[0])}</div><div>Up to <b>${fx(p[0])} MW</b></div><div>Price <b>${fx(p[1], 2)} MXN/MWh</b></div>`;
        tip.hidden = false;
        const px = ev.clientX - svg.getBoundingClientRect().left;
        tip.style.left = (px + 14 + tip.offsetWidth <= W ? px + 14 : Math.max(4, px - 14 - tip.offsetWidth)) + 'px';
      };
      svg.onpointerleave = () => (tip.hidden = true);
    };
    let last = 0;
    new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && w !== last) { last = w; draw(); } }).observe(plot);
  }

  /* ── MDA vs MTR ───────────────────────────────── */
  async function deviation(host) {
    const [ser, dia] = await Promise.all([get(`desvio/serie_${S.year}_${S.sys}.json`), get(`desvio/${S.year}/${S.fecha}_${S.sys}.json`)]);
    if (!ser) return '<div class="cp-card cp-pr-msg">No MDA vs MTR data for this system yet.</div>';
    const types = Object.keys(DEV).filter(t => Object.values(ser.dias).some(d => d[t]));
    if (!types.includes(S.devType)) S.devType = types[0];
    const ds = Object.keys(ser.dias).sort(), t = S.devType;
    const tot = dia && dia.tipos[t];
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi(`MDA · ${DEV[t]}`, fx(tot && tot.mwh_mda), 'MWh', esc(long(S.fecha)))}
        ${kpi(`MTR · ${DEV[t]}`, fx(tot && tot.mwh_mtr), 'MWh')}
        ${kpi('MTR − MDA', tot ? (tot.mwh_mtr >= tot.mwh_mda ? '+' : '') + fx(tot.mwh_mtr - tot.mwh_mda) : '—', 'MWh', tot && tot.mwh_mda ? esc(fx(100 * (tot.mwh_mtr / tot.mwh_mda - 1), 1) + '%') : '')}
        ${kpi('Status changes', tot && tot.cambios_estatus ? `${tot.cambios_estatus.nd_a_eco} / ${tot.cambios_estatus.eco_a_nd}` : '—', '', tot && tot.cambios_estatus ? 'Unit-hours unavailable → available / available → unavailable' : 'Not applicable')}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-dev-year', `Daily MWh · ${DEV[t]}`, 'cp-w-l', seg('devType', types.map(x => [x, DEV[x].replace(' available capacity', '').replace(' forecast', '')]), t))}
        ${widget('in-dev-hours', `Hourly MW · ${long(S.fecha)}`, 'cp-w-m')}
        ${widget('in-dev-ce', `Largest changes by Short CE · ${long(S.fecha)}`, 'cp-w-m')}
      </div>`;
    const mw = v => fx(v) + ' MWh';
    Board.charts.lineChart(body(host, 'in-dev-year'), { labels: ds.map(short), series: [
      { name: 'MDA', color: C.ink, values: ds.map(d => ser.dias[d][t] ? ser.dias[d][t].mda : null) },
      { name: 'MTR', color: C.gold, values: ds.map(d => ser.dias[d][t] ? ser.dias[d][t].mtr : null) }], fmt: mw, axis: v => fx(v / 1000) + 'k', band: false, ranges: [[30, '30D'], [90, '90D']] });
    if (!tot) { body(host, 'in-dev-hours').innerHTML = body(host, 'in-dev-ce').innerHTML = '<div class="cp-widget-empty">No data for this day.</div>'; return null; }
    const ces = Object.entries(tot.short_ce), sumH = lado => Array.from({ length: 24 }, (_, i) => ces.reduce((s, [, e]) => s + e[lado][i], 0));
    Board.charts.lineChart(body(host, 'in-dev-hours'), { labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), series: [{ name: 'MDA', color: C.ink, values: sumH('mda') }, { name: 'MTR', color: C.gold, values: sumH('mtr') }], fmt: v => fx(v) + ' MW', axis: v => fx(v), band: false, ranges: false });
    const rows = ces.map(([k, e]) => { const a = e.mda.reduce((s, v) => s + v, 0), b = e.mtr.reduce((s, v) => s + v, 0); return [k, e.short, a, b, b - a]; })
      .filter(r => Math.abs(r[4]) > 0.05).sort((x, y) => Math.abs(y[4]) - Math.abs(x[4])).slice(0, 25);
    body(host, 'in-dev-ce').innerHTML = rows.length ? `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Short CE</th><th>MDA MWh</th><th>MTR MWh</th><th>Change</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${fx(r[2])}</td><td>${fx(r[3])}</td><td class="${r[4] < 0 ? 'cp-in-neg' : 'cp-in-pos'}">${r[4] >= 0 ? '+' : ''}${fx(r[4])}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="cp-widget-empty">No changes between MDA and MTR this day.</div>';
    return null;
  }

  /* ── Thermal costs by Short CE ────────────────── */
  async function costs(host) {
    const d = await get(`costos/${S.year}_${S.sys}_${S.costMkt}.json`);
    if (!d) return '<div class="cp-card cp-pr-msg">No thermal cost data for this system yet.</div>';
    const ces = Object.entries(d.short_ce), shorts = [...new Set(ces.map(([, e]) => e.short))].sort();
    if (S.short && !shorts.includes(S.short)) S.short = '';
    const list = ces.filter(([, e]) => !S.short || e.short === S.short).map(([k]) => k).sort();
    if (!list.includes(S.ce)) S.ce = list[0] || '';
    const e = d.short_ce[S.ce], ds = d.dias.filter(f => e && e.dias[f]);
    host.innerHTML = `
      <div class="cp-card cp-pr-bar">
        <div class="cp-pr-row">
          <label class="cp-pr-f"><span>Short (optional)</span><select id="in-short"><option value="">All</option>${shorts.map(s => `<option ${s === S.short ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="cp-pr-f"><span>Short CE</span><select id="in-ce">${list.map(s => `<option ${s === S.ce ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          ${seg('costMkt', [['MDA', 'MDA'], ['MTR', 'MTR']], S.costMkt)}
        </div>
        <div class="cp-pr-note">MW-weighted average of the units of the Short CE that are available each day (unavailable units and empty blocks excluded). Short = first 4 characters of the unit code; Short CE = first 6.</div>
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-cost-unit', `Unit cost at minimum · ${S.ce}`, 'cp-w-l')}
        ${widget('in-cost-blocks', `Incremental cost by block · ${S.ce}`, 'cp-w-l')}
      </div>`;
    host.querySelector('#in-short').onchange = ev => { S.short = ev.target.value; S.ce = ''; view(); };
    host.querySelector('#in-ce').onchange = ev => { S.ce = ev.target.value; view(); };
    if (!ds.length) { body(host, 'in-cost-unit').innerHTML = body(host, 'in-cost-blocks').innerHTML = '<div class="cp-widget-empty">No offers for this Short CE.</div>'; return null; }
    const pf = v => fx(v, 2) + ' MXN/MWh', ax = v => fx(v), L = ds.map(short), U = ds.map(f => e.dias[f].u);
    Board.charts.lineChart(body(host, 'in-cost-unit'), { labels: L, series: [
      { name: 'Average', color: C.gold, values: U.map(u => u && u[0]) }, { name: 'Lowest unit', color: C.silver, values: U.map(u => u && u[1]) }, { name: 'Highest unit', color: C.steel, values: U.map(u => u && u[2]) }],
    fmt: pf, axis: ax, band: false, ranges: [[30, '30D'], [90, '90D']] });
    const pal = ['#9B3B2E', '#B5562F', '#C89D2A', '#8A9A3A', '#3E6B53', '#2F7A73', '#2F5D8A', '#4F4F9A', '#7C6A9E', '#9A5A86', '#646C75'];
    const blocks = d.bloques.map((b, i) => ({ name: 'Block ' + b, color: pal[i], values: ds.map(f => e.dias[f].b[i]) })).filter(s => s.values.some(v => v != null));
    Board.charts.lineChart(body(host, 'in-cost-blocks'), { labels: L, series: blocks, fmt: pf, axis: ax, band: false, off: blocks.map((_, i) => i).filter(i => i > 2), ranges: [[30, '30D'], [90, '90D']] });
    return null;
  }

  /* ── Hydro ────────────────────────────────────── */
  async function hydro(host) {
    const d = await get(`hidro/${S.year}.json`);
    if (S.sys !== 'SIN') return '<div class="cp-card cp-pr-msg">There are no hydro plants in this system; hydro opportunity costs are published for the SIN only.</div>';
    if (!d) return '<div class="cp-card cp-pr-msg">No hydro data yet.</div>';
    const ds = d.dias.slice().sort(), by = Object.fromEntries(ds.map(f => [f, []]));
    for (const v of Object.values(d.codigos)) for (const [f, x] of Object.entries(v)) if (by[f]) by[f].push(x);
    const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
    const co = f => by[f].map(x => x[0]), ps = f => by[f].map(x => x[1]);
    const today = by[S.fecha] || [];
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi('Median opportunity cost', fx(q(today.map(x => x[0]), 0.5), 2), 'MXN/MWh', esc(long(S.fecha)))}
        ${kpi('Range', today.length ? `${fx(q(today.map(x => x[0]), 0))} – ${fx(q(today.map(x => x[0]), 1))}` : '—', 'MXN/MWh', `${today.length} plants (one code per state)`)}
        ${kpi('Binding shadow prices', today.length ? String(today.filter(x => x[1] > 0).length) : '—', '', 'Codes with a shadow price above 0')}
        ${kpi('Highest shadow price', fx(q(today.map(x => x[1]), 1), 3), '')}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-hy-co', 'Hydro opportunity cost (value of water)', 'cp-w-l')}
        ${widget('in-hy-ps', 'Shadow price of the daily energy limit', 'cp-w-l')}
      </div>
      <p class="cp-in-foot">CENACE assigns hydro plants an opportunity cost instead of an energy bid. Codes are anonymized again every day, so a code can't be followed over time; the charts show the daily distribution of the codes.</p>`;
    const L = ds.map(short), pf = v => fx(v, 2) + ' MXN/MWh';
    Board.charts.lineChart(body(host, 'in-hy-co'), { labels: L, series: [
      { name: 'Highest', color: C.red, values: ds.map(f => q(co(f), 1)) }, { name: 'Median', color: C.blue, values: ds.map(f => q(co(f), 0.5)) }, { name: 'Lowest', color: C.green, values: ds.map(f => q(co(f), 0)) }],
    fmt: pf, axis: v => fx(v), band: false, ranges: [[30, '30D'], [90, '90D']] });
    Board.charts.lineChart(body(host, 'in-hy-ps'), { labels: L, series: [
      { name: 'Highest shadow price', color: C.gold, values: ds.map(f => q(ps(f), 1)) }, { name: 'Codes above 0', color: C.steel, values: ds.map(f => ps(f).filter(v => v > 0).length) }],
    fmt: v => fx(v, 3), axis: v => fx(v, 1), band: false, off: [1], ranges: [[30, '30D'], [90, '90D']] });
    return null;
  }

  /* ── Purchases by Short ───────────────────────── */
  async function purchases(host) {
    const d = await get(`compras/${S.year}_${S.sys}.json`);
    if (!d) return '<div class="cp-card cp-pr-msg">No purchase data for this system yet.</div>';
    const total = Object.entries(d.short).filter(([k]) => k !== 'GI').reduce((s, [, v]) => s + Object.values(v.dias).reduce((x, y) => x + y, 0), 0);
    const rows = Object.entries(d.short).map(([k, v]) => {
      const mwh = Object.values(v.dias).reduce((x, y) => x + y, 0), nd = Object.keys(v.dias).length;
      return { k, mwh, share: k === 'GI' ? null : 100 * mwh / total, daily: mwh / Math.max(1, nd), hourly: mean(v.suma_hora.map((s, i) => v.dias_hora[i] ? s / v.dias_hora[i] : null)), max: v.max, min: v.min, nodes: v.nodos.length };
    }).sort((a, b) => b.mwh - a.mwh);
    if (!rows.some(r => r.k === S.buyer)) S.buyer = rows[0] ? rows[0].k : '';
    const sel = d.short[S.buyer], ds = d.dias.filter(f => sel && sel.dias[f] != null);
    const lab = k => k === 'GI' ? 'GI (legacy load)' : k;
    host.innerHTML = `
      <div class="cp-board cp-pr-board">
        ${widget('in-buy-rank', `Purchase bids by Short · ${S.year} to date (${d.dias.length} days)`, 'cp-w-l')}
        ${widget('in-buy-profile', `Average hourly profile · ${lab(S.buyer)}`, 'cp-w-m')}
        ${widget('in-buy-daily', `Daily MWh · ${lab(S.buyer)}`, 'cp-w-m')}
      </div>`;
    body(host, 'in-buy-rank').innerHTML = `<div class="cp-pr-scroll cp-in-scroll cp-in-scroll--tall"><table class="cp-mini-table cp-in-table"><thead><tr><th>Short</th><th>MWh</th><th>Share</th><th>Daily avg MWh</th><th>Hourly avg MW</th><th>Peak hour<small>MW · date</small></th><th>Lowest hour<small>MW · date</small></th><th>Nodes</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.k === S.buyer ? 'cp-in-on' : ''}" data-buyer="${esc(r.k)}"><td>${esc(lab(r.k))}</td><td>${fx(r.mwh)}</td><td>${r.share == null ? '—' : fx(r.share, 1) + '%'}</td><td>${fx(r.daily)}</td><td>${fx(r.hourly, 1)}</td>
        <td>${r.max ? `${fx(r.max.mw, 1)} · ${esc(short(r.max.fecha))} H${r.max.hora}` : '—'}</td><td>${r.min ? `${fx(r.min.mw, 1)} · ${esc(short(r.min.fecha))} H${r.min.hora}` : '—'}</td><td>${r.nodes || '—'}</td></tr>`).join('')}
      </tbody></table></div><p class="cp-in-foot">Fixed purchase bids of the MDA. GI = load of the legacy contracts represented by CFE Intermediación (not counted in the shares). Select a row to see its profile.</p>`;
    body(host, 'in-buy-rank').querySelectorAll('[data-buyer]').forEach(tr => tr.onclick = () => { S.buyer = tr.dataset.buyer; view(); });
    if (!sel) return null;
    Board.charts.barChart(body(host, 'in-buy-profile'), { labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), values: sel.suma_hora.map((s, i) => sel.dias_hora[i] ? s / sel.dias_hora[i] : 0), color: C.gold, fmt: v => fx(v, 1) + ' MW', axis: v => fx(v) });
    Board.charts.lineChart(body(host, 'in-buy-daily'), { labels: ds.map(short), series: [{ name: 'MWh', color: C.ink, values: ds.map(f => sel.dias[f]), area: true }], fmt: v => fx(v) + ' MWh', axis: v => fx(v), band: false, ranges: [[30, '30D'], [90, '90D']] });
    return null;
  }

  /* ── Reserves ─────────────────────────────────── */
  async function reserves(host) {
    const d = await get(`reservas/${S.year}/${S.fecha}_${S.sys}.json`);
    if (!d) return `<div class="cp-card cp-pr-msg">No reserve data for ${esc(long(S.fecha))}.</div>`;
    const hrs = d.horas.map(h => h.hora);
    if (!hrs.includes(S.hora)) S.hora = hrs[0];
    const h = d.horas.find(x => x.hora === S.hora), t = h.termica, a = h.asignado_menos_requerido || {};
    const sign = v => v == null ? '—' : (v > 0 ? '+' : '') + fx(v, 1);
    const units = Object.entries(d.unidades).filter(([, u]) => u.horas[S.hora]).map(([k, u]) => [k, u, u.horas[S.hora]])
      .sort((x, y) => (x[2].max[1] - x[2].max[0]) - (y[2].max[1] - y[2].max[0]));
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi('Thermal max limit MDA → MTR', `${sign(t.mw_bajan)} / ${sign(t.mw_suben)}`, 'MW', `${t.unidades_bajan} units down · ${t.unidades_suben} up · ${t.eco_a_nd} out · ${t.nd_a_eco} back`)}
        ${kpi('Thermal headroom (max − min)', `${fx(t.holgura_mda)} → ${fx(t.holgura_mtr)}`, 'MW', esc(sign(t.holgura_mtr - t.holgura_mda) + ' MW'))}
        ${kpi('Assigned − required (MDA)', `${sign(a.nr10)}`, 'MW', esc(`Non-spinning 10 min · supplemental ${sign(a.sup)} · spinning ${sign(a.rod10)}`))}
        ${kpi('Required MTR − MDA', sign(h.requerido_mtr_menos_mda && h.requerido_mtr_menos_mda.total), 'MW', 'Total reserve requirement')}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-res-hours', `Hourly reserves · ${long(S.fecha)}`, 'cp-w-l', `<label class="cp-pr-f cp-in-hour"><select id="in-hour" aria-label="Hour">${hrs.map(x => `<option value="${x}" ${x === S.hora ? 'selected' : ''}>H${x}</option>`).join('')}</select></label>`)}
        ${widget('in-res-offer', `Reserve offered MDA → MTR · hour ${S.hora}`, 'cp-w-m')}
        ${widget('in-res-units', `Units that changed · hour ${S.hora}`, 'cp-w-m')}
      </div>`;
    host.querySelector('#in-hour').onchange = e => { S.hora = +e.target.value; view(); };
    body(host, 'in-res-hours').innerHTML = `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Hour</th><th>Thermal max<small>MW down / up</small></th><th>Headroom<small>MTR − MDA</small></th>
      <th>Required<small>reg · spin · non-spin · supp</small></th><th>Assigned − required<small>non-spin 10 · supp</small></th></tr></thead><tbody>
      ${d.horas.map(x => { const r = x.requerido_mda || {}, s = x.asignado_menos_requerido || {}; return `<tr class="${x.hora === S.hora ? 'cp-in-on' : ''}" data-h="${x.hora}"><td>H${x.hora}</td>
        <td>${sign(x.termica.mw_bajan)} / ${sign(x.termica.mw_suben)}</td><td>${sign(x.termica.holgura_mtr - x.termica.holgura_mda)}</td>
        <td>${fx(r.reg)} · ${fx(r.rod10)} · ${fx(r.nr10)} · ${fx(r.sup)}</td><td class="${s.nr10 ? 'cp-in-flag' : ''}">${sign(s.nr10)} · ${sign(s.sup)}</td></tr>`; }).join('')}
      </tbody></table></div><p class="cp-in-foot">"Real" reserves: each requirement minus the one it contains (CENACE publishes cumulative totals). A positive non-spinning 10 min with a negative supplemental means the MDA covered part of the supplemental requirement with 10-minute capacity.</p>`;
    body(host, 'in-res-hours').querySelectorAll('[data-h]').forEach(tr => tr.onclick = () => { S.hora = +tr.dataset.h; view(); });
    const off = ['termica', 'hidro'].filter(k => h[k]);
    body(host, 'in-res-offer').innerHTML = `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Reserve</th>${off.map(k => `<th>${k === 'termica' ? 'Thermal' : 'Hydro'}<small>MDA → MTR (MW)</small></th>`).join('')}</tr></thead><tbody>
      ${Object.entries(RES).map(([k, n]) => `<tr><td>${esc(n)}</td>${off.map(o => { const [x, y] = h[o].ofrecida[k]; return `<td class="${y < x ? 'cp-in-neg' : y > x ? 'cp-in-pos' : ''}">${fx(x)} → ${fx(y)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    body(host, 'in-res-units').innerHTML = units.length ? `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Unit</th><th>Status</th><th>Max MW</th><th>Min MW</th><th>Reserve offered<small>MW, all types</small></th></tr></thead><tbody>
      ${units.map(([k, u, x]) => { const ro = l => Object.values(x.reserva).reduce((s, v) => s + v[l], 0), dm = x.max[1] - x.max[0];
        return `<tr><td>${esc(k)}<small class="cp-in-sub">${u.tipo === 'hidro' ? 'Hydro' : 'Thermal'} · ${esc(u.short_ce)}</small></td><td>${esc(x.estatus[0])}${x.estatus[0] !== x.estatus[1] ? ' → ' + esc(x.estatus[1]) : ''}</td>
        <td class="${dm < 0 ? 'cp-in-neg' : dm > 0 ? 'cp-in-pos' : ''}">${fx(x.max[0], 1)} → ${fx(x.max[1], 1)}</td><td>${fx(x.min[0], 1)} → ${fx(x.min[1], 1)}</td><td>${fx(ro(0), 1)} → ${fx(ro(1), 1)}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="cp-widget-empty">No unit changed its offer between MDA and MTR in this hour.</div>';
    return null;
  }

  return { show };
})();
