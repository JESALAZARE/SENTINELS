/* ── Sentinels Client Portal · MEM Insights ──────────────────────────
   Market structure, price formation and dispatch analytics of the wholesale
   electricity market, for traders and guests (profiles.js). Reads the summaries
   of the private analytics bucket through the PML Worker's /ofertas/ route
   (Market.offers, with the client's market pass). Sections:
     overview   headline indicators, findings and trends
     share      market share (qualified supply, generation, reserves) by company,
                month, load zone and hour, with concentration (HHI, CR3, CR5)
     price      merit-order curve of an hour, estimated price vs the PML energy
                component and the model's fit
     dispatch   generation mix by technology and day-ahead vs real-time by company
     costs      thermal costs by company and plant
     hydro      value of water and binding energy limits
     reserves   hourly requirement, assignment and capability changes
   The page shows companies and shares only: no codes and no data sources.
   Uses Market (market.js), Board.charts (board.js) and _esc. */
const InsightsPage = (() => {
  const esc = s => _esc(s);
  const fx = (v, d = 0) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 1) => v == null || !isFinite(v) ? '—' : fx(v, d) + '%';
  const pp = v => v == null || !isFinite(v) ? '—' : Math.abs(v) < 0.05 ? '0.0 pp' : (v > 0 ? '+' : '') + fx(v, 1) + ' pp';
  const C = { ink: '#0B0D0F', gold: '#C89D2A', steel: '#646C75', grid: '#E3E6E8', green: '#3E6B53', red: '#9B3B2E', blue: '#2F5D8A', silver: '#B4BBC2' };
  const PAL = ['#C89D2A', '#2F5D8A', '#3E6B53', '#9B3B2E', '#7C6A9E', '#2F7A73', '#B5562F', '#4F8FB8', '#8A9A3A', '#9A5A86', '#0B0D0F', '#646C75'];
  // Same color for a company in every chart of the session, given in ranking order so the leaders never share one
  const colors = new Map();
  const colorOf = name => { if (!colors.has(name)) colors.set(name, PAL[colors.size % PAL.length]); return colors.get(name); };
  const seedColors = list => list.forEach(e => colorOf(e.nombre));
  const TYPE = {
    tomador: ['Must-run thermal', '#8A8F96'], nodespachable: ['Non-dispatchable', '#B4BBC2'], gi: ['Legacy contracts', '#7C6A9E'],
    importacion: ['Imports', '#2F5D8A'], intermitente: ['Wind / solar', '#3E6B53'], hidro: ['Hydro', '#4F8FB8'],
    termica_min: ['Thermal (minimum)', '#C89D2A'], termica: ['Thermal', '#9B3B2E'], hidro_real: ['Hydro', '#4F8FB8'],
  };
  const TECH = [['Nucleoelectrica', 'Nuclear', '#7C6A9E'], ['Geotermoelectrica', 'Geothermal', '#9A5A86'], ['Hidroelectrica', 'Hydro', '#4F8FB8'], ['Eolica', 'Wind', '#2F7A73'],
    ['Fotovoltaica', 'Solar', '#C89D2A'], ['Biomasa', 'Biomass', '#8A9A3A'], ['Ciclo Combinado', 'Combined cycle', '#2F5D8A'], ['Carboelectrica', 'Coal', '#0B0D0F'],
    ['Termica Convencional', 'Conventional thermal', '#646C75'], ['Turbo Gas', 'Gas turbine', '#B5562F'], ['Combustion Interna', 'Internal combustion', '#9B3B2E']];
  const SEGMENT = { C: 'Qualified supplier', U: 'Qualified user', G: 'Generator', I: 'Legacy contracts' };
  const VIEWS = [['overview', 'Overview'], ['share', 'Market share'], ['price', 'Price formation'], ['dispatch', 'Dispatch'], ['costs', 'Thermal costs'], ['hydro', 'Hydro'], ['reserves', 'Reserves'], ['critical', 'Critical hours']];
  const DAY_VIEWS = ['price', 'dispatch', 'reserves'];
  const DEV = { intermitente: 'Wind / solar', nodespachable: 'Must-run & non-dispatchable', termica: 'Thermal capacity', hidro: 'Hydro capacity' };
  const RES = { rod10: 'Spinning 10 min', nr10: 'Non-spinning 10 min', rsup: 'Spinning supplemental', nrsup: 'Non-spinning supplemental', reg: 'Regulation' };
  const SHARE = { suministro: 'Qualified supply', generacion: 'Generation', reservas: 'Reserves' };

  const S = { view: 'overview', sys: 'SIN', year: null, fecha: null, hora: 20, mkt: 'MDA', devType: 'termica', company: '', plant: '', costMkt: 'MDA', shareKind: 'suministro', zone: '', focus: '' };
  const cache = new Map();
  let seq = 0;

  // A summary (Market.offers), kept for the session; "not found" is asked again next time
  function get(path) {
    if (!cache.has(path)) cache.set(path, Market.offers(path).then(r => { if (r == null) cache.delete(path); return r; }, e => { cache.delete(path); throw e; }));
    return cache.get(path);
  }
  const widget = (id, title, cls, tools = '') =>
    `<div class="cp-widget ${cls}" id="${id}"><div class="cp-widget-head"><div class="cp-widget-title">${esc(title)}</div>${tools}</div><div class="cp-widget-body"></div></div>`;
  const body = (host, id) => host.querySelector(`#${id} .cp-widget-body`);
  const seg = (name, opts, cur) => `<div class="cp-ch-ranges cp-in-seg" data-seg="${name}" role="group">${opts.map(([v, t]) => `<button data-v="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>`;
  // Numbers in the mono font; names (a company) in the text font
  const kpi = (label, value, unit = '', note = '') =>
    `<div class="cp-in-kpi"><div class="cp-kpi-eyebrow">${esc(label)}</div><div class="cp-in-kpi-v${/[a-z]{3}/i.test(value) ? ' cp-in-kpi-v--text' : ''}">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${note ? `<div class="cp-in-kpi-n">${note}</div>` : ''}</div>`;
  const msg = t => `<div class="cp-card cp-pr-msg">${esc(t)}</div>`;
  const short = f => new Date(f + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const long = f => new Date(f + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthName = m => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const mean = a => { const v = a.filter(x => x != null && isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const hourSel = (hrs) => `<label class="cp-pr-f cp-in-hour"><select id="in-hour" aria-label="Hour">${hrs.map(x => `<option value="${x}" ${x === S.hora ? 'selected' : ''}>H${x}</option>`).join('')}</select></label>`;
  // Day slider of the bar: one step per day with data, a mark at the first day of each month
  const daySlider = (days) => {
    const i = Math.max(0, days.indexOf(S.fecha)), last = days.length - 1, cur = S.fecha.slice(0, 7);
    const arrow = d => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const marks = days.map((f, j) => [f, j]).filter(([f, j]) => j === 0 || f.slice(0, 7) !== days[j - 1].slice(0, 7));
    return `<div class="cp-in-days" role="group" aria-label="Operating day">
      <button type="button" class="cp-in-step" data-step="-1" aria-label="Previous day" ${i === 0 ? 'disabled' : ''}>${arrow('M10 3 5 8l5 5')}</button>
      <div class="cp-in-days-sl"><input type="range" id="in-day" min="0" max="${last}" step="1" value="${i}" aria-label="Operating day" aria-valuetext="${esc(long(S.fecha))}">
        <div class="cp-in-days-ticks" aria-hidden="true">${marks.map(([f, j]) => `<span class="${f.slice(0, 7) === cur ? 'on' : ''}" data-m="${f.slice(0, 7)}" style="left:calc(8px + (100% - 16px) * ${last ? j / last : 0})">${esc(monthName(f.slice(0, 7)).split(' ')[0])}</span>`).join('')}</div></div>
      <button type="button" class="cp-in-step" data-step="1" aria-label="Next day" ${i === last ? 'disabled' : ''}>${arrow('M6 3l5 5-5 5')}</button>
      <div class="cp-in-days-v" aria-live="polite">${esc(long(S.fecha))}</div>
    </div>`;
  };
  // Small trend line for tables
  const spark = (vals, color) => {
    const v = vals.filter(x => x != null); if (v.length < 2) return '';
    const lo = Math.min(...v), hi = Math.max(...v), w = 64, h = 18, x = i => (i / (vals.length - 1)) * w, y = s => h - 2 - ((s - lo) / ((hi - lo) || 1)) * (h - 4);
    return `<svg class="cp-in-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${vals.map((s, i) => s == null ? '' : `${x(i)},${y(s)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
  };

  async function show() {
    const host = document.getElementById('insights-root');
    if (!Market.ready()) { host.innerHTML = msg('MEM Insights is not enabled for your account yet. Please contact your Sentinels advisor.'); return; }
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
    const day = DAY_VIEWS.includes(S.view);
    host.innerHTML = `
      <div class="cp-card cp-pr-bar cp-in-bar">
        <div class="cp-pr-row">
          <label class="cp-pr-f"><span>System</span><select id="in-sys">${['SIN', 'BCA', 'BCS'].map(s => `<option ${s === S.sys ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          ${day ? `<label class="cp-pr-f"><span>Operating day</span><input type="date" id="in-date" value="${S.fecha || ''}" min="${days[0] || ''}" max="${days.at(-1) || ''}"></label>` : ''}
          <div class="cp-in-views" role="tablist">${VIEWS.map(([v, t]) => `<button class="cp-doc-filter ${v === S.view ? 'active' : ''}" data-view="${v}" role="tab" aria-selected="${v === S.view}">${t}</button>`).join('')}</div>
        </div>
        ${day && days.length > 1 ? daySlider(days) : ''}
      </div>
      <div id="in-view"></div>
      <p class="cp-in-sign">Sentinels analytics${days.length ? ` · Data through ${esc(long(days.at(-1)))}` : ''}. Estimates from Sentinels market models; for information purposes only.</p>`;
    host.querySelector('#in-sys').onchange = e => { S.sys = e.target.value; S.company = S.plant = S.zone = S.focus = ''; render(); };
    const dateIn = host.querySelector('#in-date'), daySl = host.querySelector('#in-day');
    // The date field and the day slider move together; the section reloads once the slider rests (250 ms)
    let dayTimer = 0;
    const showDay = i => {
      if (!daySl) return;
      const f = days[i], box = daySl.closest('.cp-in-days');
      daySl.value = i; daySl.setAttribute('aria-valuetext', long(f));
      box.querySelector('.cp-in-days-v').textContent = long(f);
      box.querySelectorAll('.cp-in-step').forEach(b => { b.disabled = +b.dataset.step < 0 ? i === 0 : i === days.length - 1; });
      box.querySelectorAll('.cp-in-days-ticks span').forEach(s => s.classList.toggle('on', s.dataset.m === f.slice(0, 7)));
      if (dateIn) dateIn.value = f;
    };
    const pickDay = (i, wait) => {
      i = Math.max(0, Math.min(days.length - 1, i)); showDay(i);
      clearTimeout(dayTimer);
      dayTimer = setTimeout(() => { if (days[i] !== S.fecha) { S.fecha = days[i]; view(); } }, wait);
    };
    if (dateIn) dateIn.onchange = e => { if (days.includes(e.target.value)) { S.fecha = e.target.value; showDay(days.indexOf(S.fecha)); view(); } else e.target.value = S.fecha; };
    if (daySl) {
      daySl.oninput = () => pickDay(+daySl.value, 250);
      host.querySelectorAll('.cp-in-step').forEach(b => b.onclick = () => pickDay(+daySl.value + +b.dataset.step, 250));
    }
    host.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view; render(); });
    if (err) { host.querySelector('#in-view').innerHTML = msg(err.message || 'MEM Insights is not available right now.'); return; }
    if (!serie) { host.querySelector('#in-view').innerHTML = msg('There is no information for this system yet.'); return; }
    view(serie);
  }

  // Renders the current section below the bar; segmented buttons change S and re-render it
  // Each call draws into its own box: when a newer call (e.g. the day slider) replaces it, a slower older one only
  // writes into its detached box and never over the current section.
  async function view(serie) {
    const box = document.createElement('div'), my = seq;
    document.querySelector('#in-view').replaceChildren(box);
    const host = box;
    host.innerHTML = '<div class="cp-card cp-pr-msg">Loading…</div>';
    try {
      serie = serie || await get(`curva/serie_${S.year}_${S.sys}.json`);
      const html = await ({ overview, share, price, dispatch, costs, hydro, reserves, critical })[S.view](host, serie);
      if (my !== seq || !box.isConnected) return;
      if (html) host.innerHTML = html;
    } catch (e) {
      if (my === seq && box.isConnected) host.innerHTML = msg('This section could not be loaded. Please try again later.');
      console.error(e);
    }
    host.querySelectorAll('.cp-in-seg').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
      S[g.dataset.seg] = /^\d+$/.test(b.dataset.v) ? +b.dataset.v : b.dataset.v;
      view();
    }));
  }

  /* ── Shared helpers ───────────────────────────── */
  const lastTwo = p => [p.meses.at(-1), p.meses.at(-2)];
  function movers(p) {
    const [m, prev] = lastTwo(p);
    if (!prev) return [];
    return p.empresas.map(e => ({ nombre: e.nombre, d: (e.meses[m] || 0) - (e.meses[prev] || 0), now: e.meses[m] || 0 })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  }
  const dailyMean = (serie, col) => { const i = serie.columnas.indexOf(col); return d => mean(serie.dias[d].map(r => r[i])); };

  /* ── Overview ─────────────────────────────────── */
  async function overview(host, serie) {
    const p = await get(`participacion/${S.year}_${S.sys}.json`);
    const ds = Object.keys(serie.dias).sort(), last30 = ds.slice(-30);
    const pml = dailyMean(serie, 'energia_pml_mda'), est = dailyMean(serie, 'precio_mda');
    const pml30 = mean(last30.map(pml)), est30 = mean(last30.map(est)), pmlPrev = mean(ds.slice(-60, -30).map(pml));
    const sup = p && p.suministro.empresas.length ? p.suministro : null, gen = p && p.generacion.empresas.length ? p.generacion : null;
    if (sup) seedColors(sup.empresas);
    if (gen) seedColors(gen.empresas);
    const [m, prev] = sup ? lastTwo(sup) : [];
    const lead = sup && sup.empresas.slice().sort((a, b) => (b.meses[m] || 0) - (a.meses[m] || 0))[0];
    const conc = sup && sup.concentracion.meses[m], concPrev = sup && prev && sup.concentracion.meses[prev];
    const mv = sup ? movers(sup) : [];
    const up = mv.filter(x => x.d > 0)[0], down = mv.filter(x => x.d < 0)[0];
    const findings = [];
    if (pml30 != null) findings.push(`The energy component of the PML averaged <b>${fx(pml30, 0)} MXN/MWh</b> in the last 30 days${pmlPrev != null ? `, ${pml30 >= pmlPrev ? 'up' : 'down'} <b>${fx(Math.abs(100 * (pml30 / pmlPrev - 1)), 1)}%</b> from the previous 30` : ''}.`);
    if (lead) findings.push(`<b>${esc(lead.nombre)}</b> leads qualified supply with <b>${pct(lead.meses[m])}</b> in ${monthName(m)}; the three largest hold <b>${pct(conc.cr3)}</b> (HHI ${fx(conc.hhi)}${concPrev ? `, ${conc.hhi >= concPrev.hhi ? '+' : ''}${fx(conc.hhi - concPrev.hhi)} vs ${monthName(prev)}` : ''}).`);
    if (up) findings.push(`Largest gain: <b>${esc(up.nombre)}</b> ${pp(up.d)} to ${pct(up.now)}.${down ? ` Largest loss: <b>${esc(down.nombre)}</b> ${pp(down.d)} to ${pct(down.now)}.` : ''}`);
    if (gen) { const g = gen.empresas[0]; findings.push(`In generation, <b>${esc(g.nombre)}</b> has the largest share of the year (${pct(g.ytd)}); the top three hold ${pct(gen.concentracion.ytd.cr3)}.`); }
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi('PML energy component · 30 days', fx(pml30, 0), 'MXN/MWh', est30 != null ? `Sentinels estimate ${fx(est30, 0)} MXN/MWh` : '')}
        ${kpi('Qualified supply concentration', conc ? fx(conc.hhi) : '—', 'HHI', conc ? `CR3 ${pct(conc.cr3)} · ${conc.activos} active suppliers` : 'No qualified supply in this system')}
        ${kpi('Largest supplier', lead ? lead.nombre : '—', '', lead ? `${pct(lead.meses[m])} in ${monthName(m)}` : '')}
        ${kpi('Biggest move', up ? up.nombre : '—', '', up ? `${pp(up.d)} vs ${monthName(prev)}` : '')}
      </div>
      <div class="cp-card cp-in-findings"><div class="cp-kpi-eyebrow">Key findings</div><ul>${findings.map(f => `<li>${f}</li>`).join('') || '<li>Not enough history yet.</li>'}</ul></div>
      <div class="cp-board cp-pr-board">
        ${widget('in-ov-price', 'PML energy component vs Sentinels estimate · daily average', 'cp-w-m')}
        ${widget('in-ov-share', sup ? 'Qualified supply · market share of the five largest' : 'Generation · market share of the five largest', 'cp-w-m')}
      </div>`;
    const pf = v => fx(v, 2) + ' MXN/MWh';
    Board.charts.lineChart(body(host, 'in-ov-price'), { labels: ds.map(short), series: [{ name: 'PML energy component', color: C.ink, values: ds.map(pml) }, { name: 'Sentinels estimate', color: C.gold, values: ds.map(est) }], fmt: pf, axis: v => fx(v), band: false, ranges: [[30, '30D'], [90, '90D']] });
    const src = sup || gen;
    if (src) Board.charts.lineChart(body(host, 'in-ov-share'), { labels: src.meses.map(monthName), series: src.empresas.slice(0, 5).map(e => ({ name: e.nombre, color: colorOf(e.nombre), values: src.meses.map(x => e.meses[x]) })), fmt: v => pct(v), axis: v => fx(v) + '%', band: false, ranges: false });
    else body(host, 'in-ov-share').innerHTML = '<div class="cp-widget-empty">No market share data yet.</div>';
    return null;
  }

  /* ── Market share ─────────────────────────────── */
  async function share(host) {
    const p = await get(`participacion/${S.year}_${S.sys}.json`);
    if (!p) return msg('There is no market share information for this system yet.');
    const kinds = Object.keys(SHARE).filter(k => p[k] && p[k].empresas.length);
    if (!kinds.includes(S.shareKind)) S.shareKind = kinds[0];
    if (!S.shareKind) return msg('There is no market share information for this system yet.');
    const d = p[S.shareKind], [m, prev] = lastTwo(d), cm = d.concentracion.meses[m], cp = prev && d.concentracion.meses[prev];
    const dl = (a, b, f = fx) => a == null || b == null ? '' : `<span class="${a - b >= 0 ? 'cp-in-pos' : 'cp-in-neg'}">${a - b >= 0 ? '+' : ''}${f(a - b)}</span> vs ${monthName(prev)}`;
    const ranked = d.empresas.slice().sort((a, b) => (b.meses[m] || 0) - (a.meses[m] || 0));
    seedColors(p.suministro.empresas); seedColors(ranked);
    if (!d.empresas.some(e => e.nombre === S.focus)) S.focus = ranked[0].nombre;
    const sup = S.shareKind === 'suministro';
    host.innerHTML = `
      <div class="cp-card cp-pr-bar"><div class="cp-pr-row">${seg('shareKind', kinds.map(k => [k, SHARE[k]]), S.shareKind)}
        <div class="cp-pr-note">${sup ? 'Qualified suppliers and qualified users that are market participants; basic service and generators are not included.' : S.shareKind === 'generacion' ? 'Energy dispatched by company.' : 'Reserves assigned by company (all products).'} Shares only; volumes are not shown.</div></div></div>
      <div class="cp-card cp-in-kpis">
        ${kpi(`HHI · ${monthName(m)}`, fx(cm.hhi), '', dl(cm.hhi, cp && cp.hhi) || concLabel(cm.hhi))}
        ${kpi('Top 3 (CR3)', pct(cm.cr3), '', dl(cm.cr3, cp && cp.cr3, v => fx(v, 1) + ' pp'))}
        ${kpi('Top 5 (CR5)', pct(cm.cr5), '', dl(cm.cr5, cp && cp.cr5, v => fx(v, 1) + ' pp'))}
        ${kpi('Active companies', fx(cm.activos), '', dl(cm.activos, cp && cp.activos))}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-sh-trend', `${SHARE[S.shareKind]} · monthly market share`, 'cp-w-l')}
        ${widget('in-sh-rank', `Ranking · ${monthName(m)}`, 'cp-w-l')}
        ${sup ? widget('in-sh-profile', `Share by hour of day · ${S.focus}`, 'cp-w-m') + widget('in-sh-zones', 'Load zones · leaders', 'cp-w-m') : ''}
        ${sup && S.zone ? widget('in-sh-zone', `${S.zone} · market share`, 'cp-w-l') : ''}
      </div>`;
    const top = ranked.slice(0, 8);
    Board.charts.lineChart(body(host, 'in-sh-trend'), { labels: d.meses.map(monthName), series: top.map(e => ({ name: e.nombre, color: colorOf(e.nombre), values: d.meses.map(x => e.meses[x]) })), fmt: v => pct(v), axis: v => fx(v) + '%', band: false, off: top.map((_, i) => i).filter(i => i > 4), ranges: false });
    body(host, 'in-sh-rank').innerHTML = `<div class="cp-pr-scroll cp-in-scroll cp-in-scroll--tall"><table class="cp-mini-table cp-in-table"><thead><tr><th>#</th><th class="cp-in-name">Company</th><th class="cp-in-name">Segment</th><th>${esc(monthName(m))}</th><th>Change</th><th>Year to date</th>${sup ? '<th>Peak hours<small>H19–H22</small></th>' : ''}<th>Trend</th></tr></thead><tbody>
      ${ranked.map((e, i) => { const now = e.meses[m] || 0, ch = prev ? now - (e.meses[prev] || 0) : null, peak = sup && e.perfil ? mean(e.perfil.slice(18, 22)) : null;
        return `<tr class="${e.nombre === S.focus ? 'cp-in-on' : ''}" data-co="${esc(e.nombre)}"><td>${i + 1}</td><td class="cp-in-name"><span class="cp-in-dot" style="background:${colorOf(e.nombre)}"></span>${esc(e.nombre)}</td><td class="cp-in-seg-t cp-in-name">${esc(SEGMENT[e.tipo] || (S.shareKind === 'suministro' ? '' : SEGMENT[e.nombre === 'Legacy contracts' ? 'I' : 'G']))}</td>
        <td><b>${pct(now, 2)}</b></td><td class="${ch > 0 ? 'cp-in-pos' : ch < 0 ? 'cp-in-neg' : ''}">${ch == null ? '—' : pp(ch)}</td><td>${pct(e.ytd, 2)}</td>${sup ? `<td>${pct(peak, 1)}</td>` : ''}<td>${spark(d.meses.map(x => e.meses[x]), colorOf(e.nombre))}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    body(host, 'in-sh-rank').querySelectorAll('[data-co]').forEach(tr => tr.onclick = () => { S.focus = tr.dataset.co; view(); });
    if (!sup) return null;
    const f = d.empresas.find(e => e.nombre === S.focus);
    Board.charts.barChart(body(host, 'in-sh-profile'), { labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), values: f.perfil, color: colorOf(f.nombre), fmt: v => pct(v, 2), axis: v => fx(v, 1) + '%' });
    body(host, 'in-sh-profile').querySelector('.cp-ch-ranges')?.remove();  // month ranges don't apply to hours of the day
    body(host, 'in-sh-zones').innerHTML = `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Load zone</th><th>Weight</th><th class="cp-in-name">Leader</th><th>Share</th><th>HHI</th></tr></thead><tbody>
      ${p.zonas.map(z => `<tr class="${z.zona === S.zone ? 'cp-in-on' : ''}" data-zone="${esc(z.zona)}"><td>${esc(z.zona)}</td><td>${pct(z.peso)}</td><td class="cp-in-name">${esc(z.empresas[0].nombre)}</td><td>${pct(z.empresas[0].ytd)}</td><td>${fx(z.concentracion.hhi)}</td></tr>`).join('')}
      </tbody></table></div><p class="cp-in-foot">Weight: the zone's part of qualified supply in the year. Select a zone to see every company in it.</p>`;
    body(host, 'in-sh-zones').querySelectorAll('[data-zone]').forEach(tr => tr.onclick = () => { S.zone = S.zone === tr.dataset.zone ? '' : tr.dataset.zone; view(); });
    const z = S.zone && p.zonas.find(x => x.zona === S.zone);
    if (z) {
      const zm = z.empresas[0] && Object.keys(z.empresas[0].meses).sort(), lm = zm && zm.at(-1);
      body(host, 'in-sh-zone').innerHTML = `<div class="cp-in-zone"><div class="cp-in-zone-k">${kpi('Zone weight', pct(z.peso))}${kpi('HHI', fx(z.concentracion.hhi), '', concLabel(z.concentracion.hhi))}${kpi('Companies', fx(z.concentracion.activos))}</div>
        <div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Company</th><th>Year to date</th><th>${esc(lm ? monthName(lm) : '')}</th><th>Trend</th></tr></thead><tbody>
        ${z.empresas.map(e => `<tr><td><span class="cp-in-dot" style="background:${colorOf(e.nombre)}"></span>${esc(e.nombre)}</td><td><b>${pct(e.ytd, 2)}</b></td><td>${pct(lm && e.meses[lm], 2)}</td><td>${spark(zm.map(x => e.meses[x]), colorOf(e.nombre))}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
    return null;
  }
  const concLabel = h => h == null ? '' : h < 1500 ? 'Unconcentrated' : h < 2500 ? 'Moderately concentrated' : 'Highly concentrated';

  /* ── Price formation ──────────────────────────── */
  async function price(host, serie) {
    const [dia, fit] = await Promise.all([get(`curva/${S.year}/${S.fecha}_${S.sys}.json`), get(`ajuste/${S.year}.json`)]);
    if (!dia) return msg(`There is no information for ${long(S.fecha)}.`);
    const hrs = dia.horas.map(h => h.hora), rt = S.mkt === 'MTR';
    if (!hrs.includes(S.hora)) S.hora = hrs.includes(20) ? 20 : hrs[0];
    // One hour of the chosen market: curve, estimated price (energy + reserve scarcity), PML energy component and demand
    const at = hora => {
      const h = dia.horas.find(x => x.hora === hora), c = rt ? h.mtr : h, f = c && c.formacion;
      return { h, c, pts: c ? c.curva : [], price: c ? c.precio : null, energy: f ? f.energia : c ? c.precio : null, adder: f && f.reserva || 0,
        pml: rt ? h.pml.energia_mtr : h.pml.energia_mda, dem: rt ? h.real.generacion : h.demanda.total };
    };
    const m = (fit && fit.sistemas[S.sys] && fit.sistemas[S.sys][rt ? 'mtr' : 'mda']) || {}, fm = m[S.fecha.slice(0, 7)] || m.total || {};
    const kpis = ({ h, c, price: p, energy, adder, pml, dem }) => {
      const marg = c && c.marginal ? `${(TYPE[c.marginal.tipo] || [c.marginal.tipo])[0]}${c.marginal.empresa ? ' · ' + c.marginal.empresa : ''}` : '—';
      const split = adder >= 0.5 ? `<br>Energy ${fx(energy, 2)} + reserve scarcity ${fx(adder, 2)}` : '';
      return `${kpi(`Sentinels estimate · ${rt ? 'real time' : 'day ahead'}`, fx(p, 2), 'MXN/MWh', esc('Price-setting unit: ' + marg) + split)}
        ${kpi(`PML energy component · ${rt ? 'MTR' : 'MDA'}`, fx(pml, 2), 'MXN/MWh', 'Same in every node of the system')}
        ${kpi('Difference', p != null && pml != null ? (p >= pml ? '+' : '') + fx(p - pml, 2) : '—', 'MXN/MWh', p != null && pml ? esc(`${fx(100 * (p - pml) / pml, 1)}% of the energy component`) : '')}
        ${kpi(rt ? 'Generation' : 'Demand', fx(dem), 'MW', rt ? '' : `Load estimate ${fx(h.real.balance)} MW`)}`;
    };
    const curveTitle = () => `Merit-order curve · ${long(S.fecha)} · hour ${S.hora}`;
    host.innerHTML = `
      <div class="cp-card cp-in-kpis" id="in-pr-kpis">${kpis(at(S.hora))}</div>
      <div class="cp-board cp-pr-board">
        ${widget('in-curve', curveTitle(), 'cp-w-l', seg('mkt', [['MDA', 'Day ahead'], ['MTR', 'Real time']], S.mkt))}
        ${widget('in-day', `Hourly price · ${long(S.fecha)}`, 'cp-w-m')}
        ${widget('in-year', `Daily average · ${S.year}`, 'cp-w-m')}
        ${widget('in-fit', 'Model accuracy', 'cp-w-l')}
      </div>`;
    const curve = body(host, 'in-curve'), title = host.querySelector('#in-curve .cp-widget-title');
    const chart = stepChart(curve, dia.tipos, hrs.map(at));
    chart.set(at(S.hora), false);
    // Moving the slider redraws only the curve and the indicators of the hour
    hourSlider(curve, hrs, hora => {
      S.hora = hora;
      const d = at(hora);
      host.querySelector('#in-pr-kpis').innerHTML = kpis(d);
      title.textContent = curveTitle();
      chart.set(d, true);
    });
    const day = hrs.map(at), est = day.map(d => d.price), ene = day.map(d => d.pml);
    const pf = v => fx(v, 2) + ' MXN/MWh', ax = v => fx(v);
    // The energy-only line shows up when part of the day's price came from reserve scarcity
    const only = day.some(d => d.adder >= 0.5) ? [{ name: 'Energy only (no reserve scarcity)', color: C.silver, values: day.map(d => d.energy) }] : [];
    Board.charts.lineChart(body(host, 'in-day'), { labels: hrs.map(x => 'H' + x), series: [{ name: 'PML energy component', color: C.ink, values: ene }, { name: 'Sentinels estimate', color: C.gold, values: est }, ...only], fmt: pf, axis: ax, band: false, ranges: false });
    const ds = Object.keys(serie.dias).sort(), e1 = dailyMean(serie, rt ? 'precio_mtr' : 'precio_mda'), p1 = dailyMean(serie, rt ? 'energia_pml_mtr' : 'energia_pml_mda');
    Board.charts.lineChart(body(host, 'in-year'), { labels: ds.map(short), series: [{ name: 'PML energy component', color: C.ink, values: ds.map(p1) }, { name: 'Sentinels estimate', color: C.gold, values: ds.map(e1) }], fmt: pf, axis: ax, band: false, ranges: [[30, '30D'], [90, '90D']] });
    body(host, 'in-fit').innerHTML = fm.horas ? `<div class="cp-in-fit">
        ${kpi('Hours within ±10%', fx(fm.pct_dentro_10, 1), '%', esc(monthName(S.fecha.slice(0, 7))))}
        ${kpi('Average absolute error', fx(fm.error_abs_prom, 2), 'MXN/MWh')}
        ${kpi('Bias', (fm.sesgo >= 0 ? '+' : '') + fx(fm.sesgo, 2), 'MXN/MWh', fm.sesgo < 0 ? 'Estimate below the PML on average' : 'Estimate above the PML on average')}
        ${kpi('Hourly correlation', fx(fm.correlacion, 2))}
      </div><p class="cp-in-foot">Sentinels' dispatch model: units in merit order, unit commitment with minimum generation, hydro at its dispatched energy and losses. When reserves run short, mostly in the evening once solar fades and hydro is already generating, the cost of the reserve passes into the energy price; the estimate adds it as reserve scarcity. The system operator also optimizes start-ups, ramps and the transmission network across the 24 hours.</p>`
      : '<div class="cp-widget-empty">No accuracy statistics for this period yet.</div>';
    return null;
  }

  // Hour slider under a chart: drag it or use the arrow keys, one hour at a time; ▶ plays the day
  function hourSlider(el, hrs, onChange) {
    const ico = { play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
      pause: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>' };
    el.insertAdjacentHTML('beforeend', `<div class="cp-in-slider">
      <button type="button" class="cp-in-play" aria-label="Play the day hour by hour">${ico.play}</button>
      <div class="cp-in-sl"><input type="range" min="0" max="${hrs.length - 1}" step="1" value="${Math.max(0, hrs.indexOf(S.hora))}" aria-label="Hour" aria-valuetext="Hour ${S.hora}">
        <div class="cp-in-sl-ticks" aria-hidden="true">${hrs.map(h => `<span class="${h === 1 || h % 6 === 0 ? 'cp-in-sl-major' : ''}${h === S.hora ? ' on' : ''}">${h}</span>`).join('')}</div></div>
      <div class="cp-in-sl-v">H${S.hora}</div></div>`);
    const box = el.querySelector('.cp-in-slider'), input = box.querySelector('input'), out = box.querySelector('.cp-in-sl-v'), play = box.querySelector('.cp-in-play'), ticks = box.querySelectorAll('.cp-in-sl-ticks span');
    let timer = 0;
    const go = i => {
      const h = hrs[i];
      input.value = i; input.setAttribute('aria-valuetext', `Hour ${h}`); out.textContent = 'H' + h;
      ticks.forEach((t, j) => t.classList.toggle('on', j === i));
      if (h !== S.hora) onChange(h);
    };
    const stop = () => { clearInterval(timer); timer = 0; play.innerHTML = ico.play; play.setAttribute('aria-label', 'Play the day hour by hour'); };
    input.oninput = () => { stop(); go(+input.value); };
    play.onclick = () => {
      if (timer) return stop();
      if (+input.value >= hrs.length - 1) go(0);
      play.innerHTML = ico.pause; play.setAttribute('aria-label', 'Pause');
      timer = setInterval(() => { const i = +input.value + 1; if (!box.isConnected || i >= hrs.length) return stop(); go(i); }, 900);
    };
  }

  // Step chart of the merit order: x = cumulative MW, y = MXN/MWh, colored by unit type.
  // The axes fit every hour of the day (all), so moving between hours shows the curve, demand and PML shift.
  function stepChart(el, tipos, all) {
    const hours = all.filter(d => d.pts.length);
    const used = [...new Set(hours.flatMap(d => d.pts.map(p => (TYPE[tipos[p[2]]] || [tipos[p[2]]])[0])))];
    const colorFor = name => (Object.values(TYPE).find(t => t[0] === name) || ['', C.steel])[1];
    el.innerHTML = `<div class="cp-ch-bar"><div class="cp-ch-legend">${used.map(t => `<span class="cp-ch-key"><span style="background:${colorFor(t)}"></span>${esc(t)}</span>`).join('')}
      <span class="cp-ch-key"><span class="cp-in-dash"></span>Demand</span><span class="cp-ch-key"><span style="background:${C.ink}"></span>PML energy</span>${all.some(d => d.adder >= 0.5) ? `<span class="cp-ch-key"><span style="background:${C.gold}"></span>Reserve scarcity</span>` : ''}</div></div><div class="cp-ch-plot"><div class="cp-ch-tip" hidden></div></div>`;
    const plot = el.querySelector('.cp-ch-plot'), tip = el.querySelector('.cp-ch-tip');
    if (!hours.length) { plot.insertAdjacentHTML('beforeend', '<div class="cp-widget-empty">No information for this day.</div>'); return { set() {} }; }
    // MW offered at zero price in an hour
    const ceroOf = pts => { const i = pts.findIndex(p => p[1] > 0); return i < 0 ? pts.at(-1)[0] : i ? pts[i - 1][0] : 0; };
    // Zoom to where the curves cross demand (most of the supply comes in at zero price), and the Y axis up to a bit
    // above the prices that matter, so a few very expensive blocks don't flatten the chart. Scarcity hours can reach
    // several times the energy price: the axis grows for them only up to 2.5× and taller lines stop at the top
    const X = Math.max(...hours.map(d => d.pts.at(-1)[0]));
    const x0 = Math.max(0, Math.min(...hours.map(d => Math.min(ceroOf(d.pts), (d.dem || X) * 0.75))) - X * 0.03);
    const x1 = Math.min(X, Math.max(x0 + X * 0.2, ...hours.map(d => Math.max((d.dem || 0) * 1.15, ceroOf(d.pts) * 1.08))));
    const base = Math.max(...hours.map(d => Math.max((d.energy || 0) * 1.4, Math.min(d.pml || 0, (d.energy || 0) * 2) * 1.1)))
      || (() => { const p = hours[0].pts.map(q => q[1]).sort((a, b) => a - b); return p[Math.floor(p.length * 0.95)] || 1; })();
    const top = Math.max(base, Math.min(Math.max(...hours.map(d => Math.max(d.pml || 0, d.price || 0))) * 1.1, base * 2.5));
    const NS = 'http://www.w3.org/2000/svg', still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let R = null, cur = null, shown = null, raf = 0, done = 0;

    // Axes and the elements that move; the curve of each hour goes in its own group
    const build = () => {
      const W = plot.clientWidth; if (!W) return false;
      const H = matchMedia('(max-width:600px)').matches ? 240 : 300, pL = 52, pR = 14, pT = 12, pB = 28;
      plot.style.height = H + 'px';
      const x = v => pL + (Math.min(Math.max(v, x0), x1) - x0) / (x1 - x0) * (W - pL - pR), y = v => pT + (1 - Math.min(Math.max(v, 0), top) / top) * (H - pT - pB);
      let g = '';
      const step = [1, 2, 2.5, 5, 10].map(k => k * 10 ** Math.floor(Math.log10(top / 4))).find(s => s >= top / 4);
      for (let v = 0; v <= top; v += step) g += `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${pL - 6}" y="${y(v) + 3.5}" text-anchor="end" class="cp-ch-ax">${fx(v)}</text>`;
      const span = x1 - x0, xs = [1, 2, 2.5, 5, 10].map(k => k * 10 ** Math.floor(Math.log10(span / 4))).find(s => s >= span / Math.max(3, Math.floor((W - pL - pR) / 80)));
      for (let v = Math.ceil(x0 / xs) * xs; v <= x1; v += xs) g += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle" class="cp-ch-ax">${fx(v / 1000, v % 1000 ? 1 : 0)}k</text>`;
      g += `<g class="cp-in-curves"></g><text data-k="zero" x="${pL + 4}" y="${y(0) - 6}" class="cp-ch-ax"></text>
        <line data-k="pml" x1="${pL}" x2="${W - pR}" stroke="${C.ink}" stroke-width="1.5"/><text data-k="pmlt" x="${pL + 4}" class="cp-ch-ax"></text>
        <line data-k="dem" y1="${pT}" y2="${H - pB}" stroke="${C.ink}" stroke-dasharray="5 4" stroke-width="1.5"/><text data-k="demt" y="${pT + 10}" class="cp-ch-ax"></text>
        <line data-k="add" stroke="${C.gold}" stroke-width="3" stroke-linecap="round"/><circle data-k="tot" r="4" fill="${C.gold}"/><text data-k="addt" class="cp-ch-ax cp-in-adder"></text>
        <circle data-k="dot" r="5" fill="#fff" stroke="${C.gold}" stroke-width="2.5"/>
        <text x="${W - pR}" y="${H - 8}" text-anchor="end" class="cp-ch-ax">MW</text>`;
      plot.querySelector('svg')?.remove();
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      svg.innerHTML = g; plot.prepend(svg);
      const k = {}; svg.querySelectorAll('[data-k]').forEach(n => (k[n.dataset.k] = n));
      R = { svg, pL, x, y, k };
      svg.onpointermove = ev => {
        const pts = cur ? cur.pts : [], mwAt = x0 + (ev.clientX - svg.getBoundingClientRect().left - pL) / (W - pL - pR) * (x1 - x0);
        const i = pts.findIndex(p => p[0] >= mwAt), p = pts[Math.max(0, i)];
        if (!p || mwAt < 0) return (tip.hidden = true);
        tip.innerHTML = `<div class="cp-ch-tip-t">${esc((TYPE[tipos[p[2]]] || [tipos[p[2]]])[0])}</div><div>Up to <b>${fx(p[0])} MW</b></div><div>Price <b>${fx(p[1], 2)} MXN/MWh</b></div>`;
        tip.hidden = false;
        const px = ev.clientX - svg.getBoundingClientRect().left;
        tip.style.left = (px + 14 + tip.offsetWidth <= W ? px + 14 : Math.max(4, px - 14 - tip.offsetWidth)) + 'px';
      };
      svg.onpointerleave = () => (tip.hidden = true);
      return true;
    };
    const curveOf = pts => {
      let g = '', prev = 0;
      pts.forEach(([mw, p, t]) => {
        if (mw <= x0 || prev >= x1) { prev = mw; return; }
        const col = (TYPE[tipos[t]] || ['', C.steel])[1];
        g += `<rect x="${R.x(prev)}" y="${R.y(p)}" width="${Math.max(0.5, R.x(mw) - R.x(prev))}" height="${Math.max(0, R.y(0) - R.y(p))}" fill="${col}" opacity="0.28"/>`;
        g += `<line x1="${R.x(prev)}" x2="${R.x(mw)}" y1="${R.y(p)}" y2="${R.y(p)}" stroke="${col}" stroke-width="2"/>`;
        prev = mw;
      });
      return g;
    };
    // The new hour's curve fades in over the old one
    const swap = (pts, fade) => {
      const box = R.svg.querySelector('.cp-in-curves'), g = document.createElementNS(NS, 'g');
      g.innerHTML = curveOf(pts);
      R.k.zero.textContent = x0 > 0 && pts.length ? `← ${fx(ceroOf(pts))} MW at zero price` : '';
      if (!fade) return box.replaceChildren(g);
      [...box.children].forEach(o => { o.style.opacity = 0; setTimeout(() => o.remove(), 320); });
      g.style.opacity = 0; box.append(g); g.getBoundingClientRect(); g.style.opacity = 1;
    };
    const attr = (n, a) => Object.entries(a).forEach(([key, v]) => n.setAttribute(key, v));
    // Demand line, PML line, the crossing point (energy price) and, in scarcity hours, the reserve scarcity
    // adder rising from it to the estimated price; at some values (in between two hours while they move)
    const lines = v => {
      const { x, y, k, pL } = R, onP = v.pml != null, onD = v.dem != null, onE = onD && v.energy != null, onA = onE && v.price - v.energy >= 0.5;
      k.pml.style.display = k.pmlt.style.display = onP ? '' : 'none';
      k.dem.style.display = k.demt.style.display = onD ? '' : 'none';
      k.dot.style.display = onE ? '' : 'none';
      k.add.style.display = k.tot.style.display = k.addt.style.display = onA ? '' : 'none';
      if (onP) { attr(k.pml, { y1: y(v.pml), y2: y(v.pml) }); attr(k.pmlt, { y: y(v.pml) - 5 }); k.pmlt.textContent = `PML energy ${fx(v.pml)}`; }
      if (onD) {
        const left = x(v.dem) - pL < 160;
        attr(k.dem, { x1: x(v.dem), x2: x(v.dem) }); attr(k.demt, { x: x(v.dem) + (left ? 4 : -4), 'text-anchor': left ? 'start' : 'end' });
        k.demt.textContent = `Demand ${fx(v.dem)} MW`;
      }
      if (onE) attr(k.dot, { cx: x(v.dem), cy: y(v.energy) });
      if (onA) {
        attr(k.add, { x1: x(v.dem), x2: x(v.dem), y1: y(v.energy), y2: y(v.price) }); attr(k.tot, { cx: x(v.dem), cy: y(v.price) });
        const left = x(v.dem) - pL < 160;
        attr(k.addt, { x: x(v.dem) + (left ? 10 : -10), y: (y(v.energy) + y(v.price)) / 2 + 4, 'text-anchor': left ? 'start' : 'end' });
        k.addt.textContent = `+${fx(v.price - v.energy)} reserve scarcity`;
      }
    };
    let last = 0;
    new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && w !== last && cur) { last = w; if (build()) { swap(cur.pts, false); lines(shown || cur); } } }).observe(plot);

    return {
      set(d, animate) {
        const from = shown;
        cur = d;
        if (!R && !build()) return;
        cancelAnimationFrame(raf); clearTimeout(done);
        swap(d.pts, animate && from && !still);
        const end = () => { cancelAnimationFrame(raf); shown = { dem: d.dem, pml: d.pml, price: d.price, energy: d.energy }; lines(shown); };
        if (!animate || !from || still) return end();
        // Frames don't run in a hidden tab; the lines still land on the new hour
        done = setTimeout(end, 400);
        const t0 = performance.now(), mix = (a, b, e) => a == null || b == null ? b : a + (b - a) * e;
        const tick = now => {
          const t = Math.min(1, (now - t0) / 350), e = 1 - (1 - t) ** 3;
          shown = { dem: mix(from.dem, d.dem, e), pml: mix(from.pml, d.pml, e), price: mix(from.price, d.price, e), energy: mix(from.energy, d.energy, e) };
          lines(shown);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
    };
  }

  /* ── Dispatch ─────────────────────────────────── */
  async function dispatch(host) {
    const [dia, ser, dev] = await Promise.all([get(`curva/${S.year}/${S.fecha}_${S.sys}.json`), get(`desvio/serie_${S.year}_${S.sys}.json`), get(`desvio/${S.year}/${S.fecha}_${S.sys}.json`)]);
    const types = ser ? Object.keys(DEV).filter(t => Object.values(ser.dias).some(d => d[t])) : [];
    if (!types.includes(S.devType)) S.devType = types[0];
    const t = S.devType, tot = dev && dev.tipos[t];
    const mix = dia && dia.horas.some(h => h.real.tecnologias_sen);
    host.innerHTML = `
      <div class="cp-board cp-pr-board">
        ${widget('in-mix', `National generation by technology · ${long(S.fecha)}`, 'cp-w-l')}
        ${widget('in-dev-year', `Day ahead vs real time · ${DEV[t] || ''}`, 'cp-w-l', types.length ? seg('devType', types.map(x => [x, DEV[x]]), t) : '')}
        ${widget('in-dev-hours', `Hourly MW · ${long(S.fecha)}`, 'cp-w-m')}
        ${widget('in-dev-co', `Largest changes by company · ${long(S.fecha)}`, 'cp-w-m')}
      </div>`;
    if (mix) {
      const hrs = dia.horas.map(h => 'H' + h.hora);
      Board.charts.stackedChart(body(host, 'in-mix'), { labels: hrs, series: TECH.map(([k, n, col]) => ({ name: n, color: col, values: dia.horas.map(h => h.real.tecnologias_sen ? h.real.tecnologias_sen[k] || 0 : 0) })).filter(s => s.values.some(v => v > 0)), fmt: v => fx(v) + ' MWh', axis: v => fx(v / 1000) + 'k' });
    } else body(host, 'in-mix').innerHTML = '<div class="cp-widget-empty">The technology mix of this day is not available yet.</div>';
    if (!ser || !types.length) { ['in-dev-year', 'in-dev-hours', 'in-dev-co'].forEach(id => body(host, id).innerHTML = '<div class="cp-widget-empty">No information yet.</div>'); return null; }
    const ds = Object.keys(ser.dias).sort();
    Board.charts.lineChart(body(host, 'in-dev-year'), { labels: ds.map(short), series: [
      { name: 'Day ahead', color: C.ink, values: ds.map(d => ser.dias[d][t] ? ser.dias[d][t].mda : null) },
      { name: 'Real time', color: C.gold, values: ds.map(d => ser.dias[d][t] ? ser.dias[d][t].mtr : null) }], fmt: v => fx(v) + ' MWh', axis: v => fx(v / 1000) + 'k', band: false, ranges: [[30, '30D'], [90, '90D']] });
    if (!tot) { body(host, 'in-dev-hours').innerHTML = body(host, 'in-dev-co').innerHTML = '<div class="cp-widget-empty">No information for this day.</div>'; return null; }
    const cos = Object.entries(tot.empresas), sumH = lado => Array.from({ length: 24 }, (_, i) => cos.reduce((s, [, e]) => s + e[lado][i], 0));
    Board.charts.lineChart(body(host, 'in-dev-hours'), { labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), series: [{ name: 'Day ahead', color: C.ink, values: sumH('mda') }, { name: 'Real time', color: C.gold, values: sumH('mtr') }], fmt: v => fx(v) + ' MW', axis: v => fx(v), band: false, ranges: false });
    const rows = cos.map(([k, e]) => { const a = e.mda.reduce((s, v) => s + v, 0), b = e.mtr.reduce((s, v) => s + v, 0); return [k, a, b, b - a]; })
      .filter(r => Math.abs(r[3]) > 0.05).sort((x, y) => Math.abs(y[3]) - Math.abs(x[3])).slice(0, 25);
    body(host, 'in-dev-co').innerHTML = rows.length ? `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Company</th><th>Day ahead<small>MWh</small></th><th>Real time<small>MWh</small></th><th>Change</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><span class="cp-in-dot" style="background:${colorOf(r[0])}"></span>${esc(r[0])}</td><td>${fx(r[1])}</td><td>${fx(r[2])}</td><td class="${r[3] < 0 ? 'cp-in-neg' : 'cp-in-pos'}">${r[3] >= 0 ? '+' : ''}${fx(r[3])}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="cp-widget-empty">No changes between day ahead and real time this day.</div>';
    return null;
  }

  /* ── Thermal costs by company and plant ───────── */
  async function costs(host) {
    const d = await get(`costos/${S.year}_${S.sys}_${S.costMkt}.json`);
    if (!d) return msg('There is no thermal cost information for this system yet.');
    const plants = Object.entries(d.plantas), companies = [...new Set(plants.map(([, e]) => e.empresa))].sort();
    if (!companies.includes(S.company)) S.company = companies[0] || '';
    const list = plants.filter(([, e]) => e.empresa === S.company).map(([k, e]) => [k, e.planta]).sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true }));
    if (!list.some(([k]) => k === S.plant)) S.plant = list[0] ? list[0][0] : '';
    const e = d.plantas[S.plant], ds = d.dias.filter(f => e && e.dias[f]);
    host.innerHTML = `
      <div class="cp-card cp-pr-bar">
        <div class="cp-pr-row">
          <label class="cp-pr-f"><span>Company</span><select id="in-co">${companies.map(s => `<option ${s === S.company ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="cp-pr-f"><span>Plant</span><select id="in-plant">${list.map(([k, n]) => `<option value="${esc(k)}" ${k === S.plant ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          ${seg('costMkt', [['MDA', 'Day ahead'], ['MTR', 'Real time']], S.costMkt)}
        </div>
        <div class="cp-pr-note">Capacity-weighted average of the plant's available units each day.</div>
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-cost-unit', `Average cost at minimum generation · ${S.company}, ${e ? e.planta : ''}`, 'cp-w-l')}
        ${widget('in-cost-blocks', `Incremental cost by block · ${S.company}, ${e ? e.planta : ''}`, 'cp-w-l')}
      </div>`;
    host.querySelector('#in-co').onchange = ev => { S.company = ev.target.value; S.plant = ''; view(); };
    host.querySelector('#in-plant').onchange = ev => { S.plant = ev.target.value; view(); };
    if (!ds.length) { body(host, 'in-cost-unit').innerHTML = body(host, 'in-cost-blocks').innerHTML = '<div class="cp-widget-empty">No information for this plant.</div>'; return null; }
    const pf = v => fx(v, 2) + ' MXN/MWh', ax = v => fx(v), L = ds.map(short), U = ds.map(f => e.dias[f].u);
    Board.charts.lineChart(body(host, 'in-cost-unit'), { labels: L, series: [
      { name: 'Average', color: C.gold, values: U.map(u => u && u[0]) }, { name: 'Lowest unit', color: C.silver, values: U.map(u => u && u[1]) }, { name: 'Highest unit', color: C.steel, values: U.map(u => u && u[2]) }],
    fmt: pf, axis: ax, band: false, ranges: [[30, '30D'], [90, '90D']] });
    const pal = ['#9B3B2E', '#B5562F', '#C89D2A', '#8A9A3A', '#3E6B53', '#2F7A73', '#2F5D8A', '#4F4F9A', '#7C6A9E', '#9A5A86', '#646C75'];
    const blocks = d.bloques.map((b, i) => ({ name: 'Block ' + Number(b), color: pal[i], values: ds.map(f => e.dias[f].b[i]) })).filter(s => s.values.some(v => v != null));
    Board.charts.lineChart(body(host, 'in-cost-blocks'), { labels: L, series: blocks, fmt: pf, axis: ax, band: false, off: blocks.map((_, i) => i).filter(i => i > 2), ranges: [[30, '30D'], [90, '90D']] });
    return null;
  }

  /* ── Hydro ────────────────────────────────────── */
  async function hydro(host) {
    if (S.sys !== 'SIN') return msg('There is no hydro generation in this system.');
    const d = await get(`hidro/${S.year}.json`);
    if (!d) return msg('There is no hydro information yet.');
    const ds = Object.keys(d.dias).sort(), lastDay = ds.at(-1), today = d.dias[lastDay] || [];
    const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null; };
    const co = f => d.dias[f].map(x => x[0]), ps = f => d.dias[f].map(x => x[1]);
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi('Median value of water', fx(q(today.map(x => x[0]), 0.5), 2), 'MXN/MWh', esc(long(lastDay)))}
        ${kpi('Range across regions', today.length ? `${fx(q(today.map(x => x[0]), 0))} – ${fx(q(today.map(x => x[0]), 1))}` : '—', 'MXN/MWh')}
        ${kpi('Binding energy limits', today.length ? String(today.filter(x => x[1] > 0).length) : '—', '', 'Regions where more water would have been used')}
        ${kpi('Highest shadow price', fx(q(today.map(x => x[1]), 1), 3))}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-hy-co', 'Value of water (opportunity cost)', 'cp-w-l')}
        ${widget('in-hy-ps', 'Shadow price of the daily energy limit', 'cp-w-l')}
      </div>
      <p class="cp-in-foot">Hydro plants are dispatched against the value of the water they hold rather than a fuel cost. The charts show the daily distribution across regions.</p>`;
    const L = ds.map(short), pf = v => fx(v, 2) + ' MXN/MWh';
    Board.charts.lineChart(body(host, 'in-hy-co'), { labels: L, series: [
      { name: 'Highest', color: C.red, values: ds.map(f => q(co(f), 1)) }, { name: 'Median', color: C.blue, values: ds.map(f => q(co(f), 0.5)) }, { name: 'Lowest', color: C.green, values: ds.map(f => q(co(f), 0)) }],
    fmt: pf, axis: v => fx(v), band: false, ranges: [[30, '30D'], [90, '90D']] });
    Board.charts.lineChart(body(host, 'in-hy-ps'), { labels: L, series: [
      { name: 'Highest shadow price', color: C.gold, values: ds.map(f => q(ps(f), 1)) }, { name: 'Regions above 0', color: C.steel, values: ds.map(f => ps(f).filter(v => v > 0).length) }],
    fmt: v => fx(v, 3), axis: v => fx(v, 1), band: false, off: [1], ranges: [[30, '30D'], [90, '90D']] });
    return null;
  }

  /* ── Reserves ─────────────────────────────────── */
  async function reserves(host) {
    const d = await get(`reservas/${S.year}/${S.fecha}_${S.sys}.json`);
    if (!d) return msg(`There is no reserve information for ${long(S.fecha)}.`);
    const hrs = d.horas.map(h => h.hora);
    if (!hrs.includes(S.hora)) S.hora = hrs[0];
    const h = d.horas.find(x => x.hora === S.hora), t = h.termica, a = h.asignado_menos_requerido || {};
    const sign = v => v == null ? '—' : (v > 0 ? '+' : '') + fx(v, 1);
    const units = Object.values(d.unidades).filter(u => u.horas[S.hora]).map(u => [u, u.horas[S.hora]])
      .sort((x, y) => (x[1].max[1] - x[1].max[0]) - (y[1].max[1] - y[1].max[0]));
    host.innerHTML = `
      <div class="cp-card cp-in-kpis">
        ${kpi('Thermal capacity, day ahead → real time', `${sign(t.mw_bajan)} / ${sign(t.mw_suben)}`, 'MW', `${t.unidades_bajan} units down · ${t.unidades_suben} up · ${t.eco_a_nd} out · ${t.nd_a_eco} back`)}
        ${kpi('Thermal headroom', `${fx(t.holgura_mda)} → ${fx(t.holgura_mtr)}`, 'MW', esc(sign(t.holgura_mtr - t.holgura_mda) + ' MW'))}
        ${kpi('Assigned − required', `${sign(a.nr10)}`, 'MW', esc(`Non-spinning 10 min · supplemental ${sign(a.sup)} · spinning ${sign(a.rod10)}`))}
        ${kpi('Requirement, real time − day ahead', sign(h.requerido_mtr_menos_mda && h.requerido_mtr_menos_mda.total), 'MW', 'Total reserve requirement')}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-res-hours', `Hourly reserves · ${long(S.fecha)}`, 'cp-w-l', hourSel(hrs))}
        ${widget('in-res-cap', `Reserve capability, day ahead → real time · hour ${S.hora}`, 'cp-w-m')}
        ${widget('in-res-units', `Units that changed · hour ${S.hora}`, 'cp-w-m')}
      </div>`;
    host.querySelector('#in-hour').onchange = e => { S.hora = +e.target.value; view(); };
    body(host, 'in-res-hours').innerHTML = `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Hour</th><th>Thermal capacity<small>MW down / up</small></th><th>Headroom<small>change</small></th>
      <th>Required<small>reg · spin · non-spin · supp</small></th><th>Assigned − required<small>non-spin 10 · supp</small></th></tr></thead><tbody>
      ${d.horas.map(x => { const r = x.requerido_mda || {}, s = x.asignado_menos_requerido || {}; return `<tr class="${x.hora === S.hora ? 'cp-in-on' : ''}" data-h="${x.hora}"><td>H${x.hora}</td>
        <td>${sign(x.termica.mw_bajan)} / ${sign(x.termica.mw_suben)}</td><td>${sign(x.termica.holgura_mtr - x.termica.holgura_mda)}</td>
        <td>${fx(r.reg)} · ${fx(r.rod10)} · ${fx(r.nr10)} · ${fx(r.sup)}</td><td class="${s.nr10 ? 'cp-in-flag' : ''}">${sign(s.nr10)} · ${sign(s.sup)}</td></tr>`; }).join('')}
      </tbody></table></div><p class="cp-in-foot">Each reserve product is shown on its own (regulation, spinning 10 min, non-spinning 10 min, supplemental). A positive non-spinning 10 min with a negative supplemental means part of the supplemental requirement was covered with faster 10-minute capacity.</p>`;
    body(host, 'in-res-hours').querySelectorAll('[data-h]').forEach(tr => tr.onclick = () => { S.hora = +tr.dataset.h; view(); });
    const kinds = ['termica', 'hidro'].filter(k => h[k]);
    body(host, 'in-res-cap').innerHTML = `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Reserve</th>${kinds.map(k => `<th>${k === 'termica' ? 'Thermal' : 'Hydro'}<small>MW</small></th>`).join('')}</tr></thead><tbody>
      ${Object.entries(RES).map(([k, n]) => `<tr><td>${esc(n)}</td>${kinds.map(o => { const [x, y] = h[o].ofrecida[k]; return `<td class="${y < x ? 'cp-in-neg' : y > x ? 'cp-in-pos' : ''}">${fx(x)} → ${fx(y)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    body(host, 'in-res-units').innerHTML = units.length ? `<div class="cp-pr-scroll cp-in-scroll"><table class="cp-mini-table cp-in-table"><thead><tr><th>Unit</th><th>Status</th><th>Max MW</th><th>Min MW</th><th>Reserve<small>MW, all products</small></th></tr></thead><tbody>
      ${units.map(([u, x]) => { const ro = l => Object.values(x.reserva).reduce((s, v) => s + v[l], 0), dm = x.max[1] - x.max[0], st = s => s === 'ND' ? 'Unavailable' : 'Available';
        return `<tr><td>${esc(u.empresa)}<small class="cp-in-sub">${u.tipo === 'hidro' ? 'Hydro' : 'Thermal'} · ${esc(u.unidad)}</small></td><td>${esc(st(x.estatus[0]))}${x.estatus[0] !== x.estatus[1] ? ' → ' + esc(st(x.estatus[1])) : ''}</td>
        <td class="${dm < 0 ? 'cp-in-neg' : dm > 0 ? 'cp-in-pos' : ''}">${fx(x.max[0], 1)} → ${fx(x.max[1], 1)}</td><td>${fx(x.min[0], 1)} → ${fx(x.min[1], 1)}</td><td>${fx(ro(0), 1)} → ${fx(ro(1), 1)}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="cp-widget-empty">No unit changed between day ahead and real time in this hour.</div>';
    return null;
  }

  /* ── Critical hours ───────────────────────────── */
  // Operating reserve of the SIN by hour (available capacity in real time − real generation) and the 100
  // hours with the least reserve inside the year's calculation window. Grid Code states for the SIN:
  // Normal ≥ 6 %, Alert 3–6 %, Emergency < 3 % of demand; spinning reserve must be at least half of it.
  const STATE = p => p == null ? ['—', ''] : p >= 6 ? ['Normal', 'cp-in-st--n'] : p >= 3 ? ['Alert', 'cp-in-st--a'] : ['Emergency', 'cp-in-st--e'];
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekday = f => (new Date(f + 'T12:00:00Z').getUTCDay() + 6) % 7;
  async function critical(host) {
    if (S.sys !== 'SIN') return msg('Critical hours are defined for the National Interconnected System (SIN).');
    const d = await get(`criticas/serie_${S.year}_SIN.json`);
    if (!d || !Object.keys(d.dias).length) return msg('There is no operating-reserve information for this year yet.');
    const c = Object.fromEntries(d.columnas.map((k, i) => [k, i])), w = d.ventana;
    const all = Object.entries(d.dias).flatMap(([f, hs]) => hs.map(r => ({ f, h: r[c.hora], ro: r[c.reserva_operativa_mw], pct: r[c.reserva_operativa_pct], dem: r[c.demanda_mw], cap: r[c.capacidad_mw], gen: r[c.generacion_mw],
      ter: r[c.cap_termica_mw], hid: r[c.cap_hidro_mw], int: r[c.cap_intermitente_mw], nd: r[c.cap_nodespachable_gi_mw], rr: r[c.reserva_rodante_ofrecida_mw], rnr: r[c.reserva_no_rodante_ofrecida_mw] })))
      .filter(x => x.ro != null).sort((a, b) => a.f.localeCompare(b.f) || a.h - b.h);
    const win = w ? all.filter(x => x.f >= w.desde && x.f <= w.hasta) : all;
    if (!win.length) return msg(`There is no operating-reserve information inside the ${S.year} critical-hours window yet.`);
    const top = [...win].sort((a, b) => a.ro - b.ro).slice(0, 100), rank = new Map(top.map((x, i) => [x, i + 1]));
    const winDays = w ? Math.round((new Date(w.hasta) - new Date(w.desde)) / 864e5) + 1 : null, haveDays = new Set(win.map(x => x.f)).size;
    const today = new Date().toISOString().slice(0, 10), final = w && today > w.hasta && haveDays >= winDays;
    const cnt = (xs, key, n) => { const a = Array(n).fill(0); xs.forEach(x => a[key(x)]++); return a; };
    const alerts = win.filter(x => x.pct < 6 && x.pct >= 3).length, emerg = win.filter(x => x.pct < 3).length;
    const spin = mean(top.map(x => x.rr + x.rnr ? (100 * x.rr) / (x.rr + x.rnr) : null));
    const months = [...new Set(win.map(x => x.f.slice(0, 7)))];
    host.innerHTML = `
      ${w ? `<div class="cp-card cp-in-window">
        <span class="cp-in-window-tag">Critical-hours window ${S.year}</span>
        <div class="cp-in-window-dates">${esc(long(w.desde))} – ${esc(long(w.hasta))}</div>
        <div class="cp-in-window-note">From the first (${esc(long(w.base.primera))}) and last (${esc(long(w.base.ultima))}) critical hours of ${w.base.anio}, ${w.dias_margen} days before and after, as the Capacity Balance Market Manual sets the calculation days.</div>
        <span class="cp-in-st ${final ? 'cp-in-st--n' : 'cp-in-st--a'}">${final ? 'Final' : 'Provisional'} · ${haveDays} of ${winDays} days with data</span>
      </div>` : ''}
      <div class="cp-card cp-in-kpis">
        ${kpi('Tightest hour', fx(top[0].ro), 'MW', esc(`${long(top[0].f)} · H${top[0].h} · ${fx(top[0].pct, 1)}% of demand · ${STATE(top[0].pct)[0]}`))}
        ${kpi('100th critical hour', fx(top.at(-1).ro), 'MW', 'Least operating reserve that still enters the 100')}
        ${kpi('Hours in Alert / Emergency', `${alerts} / ${emerg}`, '', esc(`Of ${fx(win.length)} hours in the window (Normal ≥ 6% of demand)`))}
        ${kpi('Spinning share of offered reserve', fx(spin, 1), '%', 'Average over the 100 hours · Grid Code: spinning ≥ 50%')}
      </div>
      <div class="cp-board cp-pr-board">
        ${widget('in-cr-top', `The ${top.length} critical hours · least operating reserve`, 'cp-w-l')}
        ${widget('in-cr-hour', 'Frequency by hour of day', 'cp-w-m')}
        ${widget('in-cr-wd', 'Frequency by day of week', 'cp-w-m')}
        ${widget('in-cr-heat', 'Hour × day of week', 'cp-w-l')}
        ${widget('in-cr-month', 'Frequency by month', 'cp-w-m')}
        ${widget('in-cr-dist', 'Operating reserve of the 100 hours', 'cp-w-m')}
        ${widget('in-cr-daily', `Daily minimum operating reserve · ${S.year}`, 'cp-w-l')}
        ${widget('in-cr-mix', 'Average capacity at the critical hours', 'cp-w-l')}
      </div>
      <p class="cp-in-foot">Operating reserve = available capacity in real time (thermal and hydro units not declared unavailable, wind and solar forecast, must-run and legacy contracts, the must-run offer counted at 43%) minus real generation of the SIN; % of real demand. Calibrated against the published 2025 critical hours: 90 of the 100 match and the average gap is about 370 MW. Operating states follow the Grid Code for the SIN: Normal ≥ 6%, Alert 3–6%, Emergency &lt; 3%; at least half of the operating reserve must be spinning, shown here with the spinning share of the reserve offered by the units. Critical hours are the 100 hours with the least operating reserve inside the window. Sentinels estimate; it may differ from the official calculation.</p>`;
    const pctTxt = x => `${fx(x.pct, 1)}%`;
    body(host, 'in-cr-top').innerHTML = `<div class="cp-pr-scroll cp-in-scroll cp-in-scroll--tall"><table class="cp-mini-table cp-in-table"><thead><tr><th>#</th><th class="cp-in-name">Day</th><th>Hour</th><th>Operating reserve<small>MW</small></th><th>% of demand</th><th class="cp-in-name">State</th><th>Demand<small>MW</small></th><th>Available capacity<small>MW</small></th><th>Spinning share<small>offered</small></th></tr></thead><tbody>
      ${top.map((x, i) => { const [st, cls] = STATE(x.pct); return `<tr><td>${i + 1}</td><td class="cp-in-name">${esc(long(x.f))}<small class="cp-in-sub">${WEEK[weekday(x.f)]}</small></td><td>H${x.h}</td><td>${fx(x.ro)}</td><td>${pctTxt(x)}</td>
        <td class="cp-in-name"><span class="cp-in-st ${cls}">${st}</span></td><td>${fx(x.dem)}</td><td>${fx(x.cap)}</td><td>${x.rr + x.rnr ? fx((100 * x.rr) / (x.rr + x.rnr), 0) + '%' : '—'}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    const n = v => fx(v) + ' hours';
    Board.charts.barChart(body(host, 'in-cr-hour'), { ranges: false, labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), values: cnt(top, x => x.h - 1, 24), color: C.gold, fmt: n, axis: v => fx(v) });
    Board.charts.barChart(body(host, 'in-cr-wd'), { ranges: false, labels: WEEK, values: cnt(top, x => weekday(x.f), 7), color: C.blue, fmt: n, axis: v => fx(v) });
    Board.charts.barChart(body(host, 'in-cr-month'), { ranges: false, labels: months.map(monthName), values: months.map(m => top.filter(x => x.f.startsWith(m)).length), color: C.green, fmt: n, axis: v => fx(v) });
    const bins = [[0, 3000], [3000, 4000], [4000, 5000], [5000, 6000], [6000, 7000], [7000, 8000], [8000, Infinity]];
    Board.charts.barChart(body(host, 'in-cr-dist'), { ranges: false, labels: bins.map(([a, b]) => b === Infinity ? `${fx(a / 1000)}k+` : `${fx(a / 1000)}–${fx(b / 1000)}k`), values: bins.map(([a, b]) => top.filter(x => x.ro >= a && x.ro < b).length), color: C.steel, fmt: n, axis: v => fx(v) });
    // Heat map: how many of the 100 hours fall on each hour × weekday
    const grid = WEEK.map((_, wd) => Array.from({ length: 24 }, (_, h) => top.filter(x => weekday(x.f) === wd && x.h === h + 1).length)), mx = Math.max(1, ...grid.flat());
    body(host, 'in-cr-heat').innerHTML = `<div class="cp-pr-scroll"><table class="cp-in-heat"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h + 1}</th>`).join('')}</tr></thead><tbody>
      ${grid.map((r, wd) => `<tr><th>${WEEK[wd]}</th>${r.map((v, h) => `<td style="background:rgba(200,157,42,${v ? (0.15 + 0.85 * v / mx).toFixed(2) : 0})" title="${WEEK[wd]} · H${h + 1}: ${v} hours">${v || ''}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
    // On narrow screens the heat map scrolls inside its box: start at the evening, where the critical hours are
    const heat = body(host, 'in-cr-heat').querySelector('.cp-pr-scroll'); heat.scrollLeft = heat.scrollWidth;
    const days = [...new Set(all.map(x => x.f))], minOf = f => all.filter(x => x.f === f).reduce((m, x) => (!m || x.ro < m.ro ? x : m), null);
    const mins = days.map(minOf);
    Board.charts.lineChart(body(host, 'in-cr-daily'), { labels: days.map(short), series: [
      { name: 'Daily minimum operating reserve', color: C.ink, values: mins.map(x => x.ro) },
      { name: 'Alert below (6% of demand)', color: C.gold, values: mins.map(x => x.dem ? 0.06 * x.dem : null) },
      { name: 'Emergency below (3%)', color: C.red, values: mins.map(x => x.dem ? 0.03 * x.dem : null) },
      { name: '100th critical hour', color: C.steel, values: mins.map(() => top.at(-1).ro) }],
    fmt: v => fx(v) + ' MW', axis: v => fx(v / 1000, 1) + 'k', band: false, ranges: [[30, '30D'], [90, '90D']] });
    const avg = k => mean(top.map(x => x[k]));
    Board.charts.barChart(body(host, 'in-cr-mix'), { ranges: false, labels: ['Thermal', 'Hydro', 'Wind / solar', 'Must-run & legacy', 'Real generation', 'Operating reserve'], values: [avg('ter'), avg('hid'), avg('int'), avg('nd'), avg('gen'), avg('ro')], color: C.blue, fmt: v => fx(v) + ' MW', axis: v => fx(v / 1000) + 'k' });
    return null;
  }

  return { show };
})();
