/* ── Sentinels Client Portal · Market Prices · Long-term history ─────
   Monthly history since 2020 for ANY NodoP (PML) or load zone (PEND) of the
   CENACE catalog. The hourly prices live in Azure SQL (azure/schema.sql), loaded
   by the data robot (.github/workflows/historico-masivo.yml); its summary tables
   (agg_mensual, agg_hora_mes = materialized views) are published once a month
   as one small file per NodoP / zone:
     /data/resumen/<nodo|zona>/<sistema>/<clave>.json
       { desde, hasta_mes, MDA|MTR: { meses: [[mes, horas, avg, energy, losses,
         congestion, max, max date, max hour, min, min date, min hour], …],
         perfil: { year: [24 hourly averages] } } }
     /data/resumen/index.json   robot progress
   Only closed months are published (the MTR of a month is complete 7 days after
   it ends); recent days are in the query widgets above (up to 31 days, any date).
   The client picks a month range (From / To or 1Y · 3Y · 5Y · All) that applies
   to the three widgets and the Excel. The annual summary is computed here from
   the months in the range (hour-weighted); the hourly profile is per whole year.
   "Excel + hourly" also adds every hour of the range, fetched month by month from
   CENACE through the PML Worker (/pml or /pend), with progress and cancel.
   Used by prices.js: PriceHistory.mount(el, { node, priceName, api }).
   Uses Board.charts (board.js), Xlsx (xlsx.js) and _esc (index.html). */
const PriceHistory = (() => {
  const DATA = '../data/resumen/';
  const esc = s => _esc(s);
  const fx = (v, d = 2) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mlabel = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(2, 4)}`;
  const mlong = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  const addMonths = (m, n) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const monthEnd = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
  const C = { MDA: '#0B0D0F', MTR: '#C89D2A' };
  const YEAR_COLORS = ['#0B0D0F', '#C89D2A', '#3E6B53', '#5B7FA6', '#8C3A36', '#9A6FB0', '#646C75', '#B4BBC2', '#2F8F9D', '#D17A22', '#6B8E23'];
  const PRESETS = [[12, '1Y'], [36, '3Y'], [60, '5Y'], [0, 'All']];
  const cache = {};  // url → Promise(json | null)
  const get = url => cache[url] || (cache[url] = fetch(url, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null));
  const fileOf = n => `${DATA}${n.kind === 'zone' ? 'zona' : 'nodo'}/${encodeURIComponent(n.sistema)}/${encodeURIComponent(n.nodo.replace(/ /g, '-'))}.json`;
  let range = { from: null, to: null };  // chosen months (kept while the client switches NodoP)

  // Month rows → objects, oldest first
  const months = (doc, p) => ((doc[p] && doc[p].meses) || []).map(([mes, horas, avg, ene, per, cng, max, maxF, maxH, min, minF, minH]) =>
    ({ mes, horas, avg, ene, per, cng, max: { v: max, f: maxF, h: maxH }, min: { v: min, f: minF, h: minH } })).sort((a, b) => a.mes < b.mes ? -1 : 1);
  // Annual summary from the months: hour-weighted average, max / min hour of the year
  function years(ms) {
    const g = new Map();
    for (const m of ms) {
      const y = m.mes.slice(0, 4);
      let a = g.get(y);
      if (!a) g.set(y, a = { y, horas: 0, suma: 0, max: m.max, min: m.min });
      a.horas += m.horas; a.suma += m.avg * m.horas;
      if (m.max.v > a.max.v) a.max = m.max;
      if (m.min.v < a.min.v) a.min = m.min;
    }
    return new Map([...g].map(([y, a]) => [y, { ...a, avg: a.suma / a.horas }]));
  }

  async function mount(el, { node, priceName, api }) {
    if (!el) return;
    const [idx, doc] = await Promise.all([get(DATA + 'index.json'), get(fileOf(node))]);
    if (!el.isConnected) return;
    const P = priceName, who = node.kind === 'zone' ? `load zone ${node.nodo}` : node.nodo;
    const head = `<div class="cp-hi-head"><div><h2 class="cp-hi-title">Long-term history</h2>
      <p class="cp-hi-sub">Monthly ${P} since 2020 for every NodoP and load zone of the CENACE catalog, from the Sentinels data warehouse.</p></div></div>`;
    const progress = idx && idx.avance < 100
      ? ` The data robot is still loading older months (${idx.avance}% done): every NodoP and zone is covered since ${esc(mlong((idx.cargado_desde && idx.cargado_desde.MDA || '2020-01').slice(0, 7)))}.` : '';
    const has = doc && ['MDA', 'MTR'].some(p => months(doc, p).length);
    if (!has) {
      el.innerHTML = `<div class="cp-card cp-hi">${head}<div class="cp-hi-msg">The history of <b>${esc(who)}</b> is not published yet.${progress || ' It appears after the next monthly update.'}</div></div>`;
      return;
    }
    const all = [...new Set(['MDA', 'MTR'].flatMap(p => months(doc, p).map(m => m.mes)))].sort();
    el.innerHTML = `<div class="cp-card cp-hi">${head}
      <div class="cp-hi-msg">${esc(mlong(all[0]))} – ${esc(mlong(doc.hasta_mes))}, closed months (MTR complete). Recent days: use the query above.${progress}</div>
      <div class="cp-hi-range"></div><div class="cp-hi-body"></div></div>`;
    controls(el.querySelector('.cp-hi-range'), el.querySelector('.cp-hi-body'), doc, all, P, { node, api });
  }

  /* ── Range: From / To months and presets ── */
  function controls(bar, body, doc, all, P, ctx) {
    const first = all[0], last = all.at(-1);
    const clamp = m => m < first ? first : m > last ? last : m;
    let from = clamp(range.from || first), to = clamp(range.to || last);
    if (from > to) [from, to] = [first, last];
    const opts = sel => all.map(m => `<option value="${m}" ${m === sel ? 'selected' : ''}>${mlong(m)}</option>`).join('');
    const span = (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5, 7) - +from.slice(5, 7)) + 1;
    bar.innerHTML = `
      <label class="cp-pr-f"><span>From</span><select id="hi-from">${opts(from)}</select></label>
      <label class="cp-pr-f"><span>To</span><select id="hi-to">${opts(to)}</select></label>
      <div class="cp-pr-presets" role="group" aria-label="History range">${PRESETS.map(([n, t]) =>
        `<button class="cp-doc-filter ${to === last && (n ? from === clamp(addMonths(last, 1 - n)) && span === Math.min(n, all.length) : from === first) ? 'active' : ''}" data-n="${n}">${t}</button>`).join('')}</div>`;
    const set = (f, t) => { if (f > t) [f, t] = [t, f]; range = { from: f, to: t }; controls(bar, body, doc, all, P, ctx); };
    bar.querySelector('#hi-from').onchange = e => set(e.target.value, to);
    bar.querySelector('#hi-to').onchange = e => set(from, e.target.value);
    bar.querySelectorAll('.cp-pr-presets button').forEach(b => b.onclick = () => { const n = +b.dataset.n; set(n ? clamp(addMonths(last, 1 - n)) : first, last); });
    draw(body, doc, P, from, to, ctx);
  }

  function draw(body, doc, P, from, to, ctx) {
    const W = (id, title, cls, tools = '') => `<div class="cp-widget ${cls}" id="${id}"><div class="cp-widget-head"><div class="cp-widget-title">${esc(title)}</div>${tools}</div><div class="cp-widget-body"></div></div>`;
    const seg = `<div class="cp-ch-ranges cp-pr-seg" role="group" aria-label="Market">${['MDA', 'MTR'].map((p, i) => `<button data-p="${p}" class="${i ? '' : 'on'}">${p}</button>`).join('')}</div>`;
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
    const dl = `<button class="cp-pr-dl" id="hi-xlsx" title="Monthly, annual and hourly-profile sheets">${icon}Excel</button>` +
      (ctx.api ? `<button class="cp-pr-dl" id="hi-xlsx-h" title="Also every hour of the range, fetched from CENACE">${icon}Excel + hourly</button>` : '');
    body.innerHTML = `<div class="cp-hi-dlmsg" hidden></div><div class="cp-board cp-pr-board cp-hi-board">
      ${W('hi-month', `Monthly average ${P} · MDA vs MTR`, 'cp-w-l', dl)}
      ${W('hi-year', `Annual summary ${P}`, 'cp-w-l')}
      ${W('hi-profile', `Average hourly profile by year · ${P}`, 'cp-w-l', seg)}</div>`;
    const fmt = v => fx(v) + ' MXN/MWh', axis = v => fx(v, 0);
    const inRange = r => r.mes >= from && r.mes <= to;
    const m = { MDA: months(doc, 'MDA').filter(inRange), MTR: months(doc, 'MTR').filter(inRange) };
    const yFrom = from.slice(0, 4), yTo = to.slice(0, 4);

    // Monthly averages of both markets on one timeline
    const keys = [...new Set([...m.MDA, ...m.MTR].map(r => r.mes))].sort();
    const avgOf = p => new Map(m[p].map(r => [r.mes, r.avg]));
    const mda = avgOf('MDA'), mtr = avgOf('MTR');
    Board.charts.lineChart(body.querySelector('#hi-month .cp-widget-body'), {
      labels: keys.map(mlabel), fmt, axis, band: false, ranges: false,
      series: [{ name: 'MDA', color: C.MDA, values: keys.map(k => mda.get(k) ?? null) }, { name: 'MTR', color: C.MTR, values: keys.map(k => mtr.get(k) ?? null) }]
    });

    // Annual summary of the months in the range (newest year first); partial = lacks more than two days of hours
    const y = { MDA: years(m.MDA), MTR: years(m.MTR) };
    const ys = [...new Set([...y.MDA.keys(), ...y.MTR.keys()])].sort().reverse();
    const partial = (k, r) => !r || r.horas < ((+k % 4 ? 365 : 366) - 2) * 24;
    const cell = r => r ? `<td>${fx(r.avg)}</td><td>${fx(r.max.v)}<small>${esc(r.max.f)} · H${r.max.h}</small></td><td>${fx(r.min.v)}<small>${esc(r.min.f)} · H${r.min.h}</small></td>` : '<td>—</td><td>—</td><td>—</td>';
    body.querySelector('#hi-year .cp-widget-body').innerHTML = `<div class="cp-pr-scroll cp-hi-scroll"><table class="cp-mini-table cp-pr-table cp-hi-table"><thead><tr><th>Year</th>
        <th>MDA avg<small>MXN/MWh</small></th><th>MDA max</th><th>MDA min</th><th>MTR avg<small>MXN/MWh</small></th><th>MTR max</th><th>MTR min</th><th>MTR − MDA<small>avg</small></th></tr></thead>
      <tbody>${ys.map(k => { const a = y.MDA.get(k), b = y.MTR.get(k); return `<tr><td>${k}${partial(k, a) || partial(k, b) ? '<small>partial</small>' : ''}</td>${cell(a)}${cell(b)}<td>${a && b ? fx(b.avg - a.avg) : '—'}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="cp-pr-count">Hour-weighted averages of the months in the range · "partial" = the year is not complete in the range or in the history</div>`;

    // Hourly profile: one line per (whole) year of the range; the last three start visible
    const profile = p => {
      const pf = (doc[p] && doc[p].perfil) || {}, yrs = Object.keys(pf).filter(yr => yr >= yFrom && yr <= yTo).sort();
      const el = body.querySelector('#hi-profile .cp-widget-body');
      if (!yrs.length) { el.innerHTML = `<div class="cp-widget-empty">No ${p} history in this range.</div>`; return; }
      Board.charts.lineChart(el, {
        labels: Array.from({ length: 24 }, (_, i) => 'H' + (i + 1)), fmt, axis, band: false, ranges: false,
        series: yrs.map((yr, i) => ({ name: yr, color: YEAR_COLORS[(yrs.length - 1 - i) % YEAR_COLORS.length], values: pf[yr] })),
        off: yrs.map((_, i) => i).filter(i => i < yrs.length - 3)
      });
      el.insertAdjacentHTML('beforeend', '<div class="cp-pr-count">Each line averages its whole year (all closed months), even if the range covers only part of it</div>');
    };
    profile('MDA');
    body.querySelectorAll('#hi-profile .cp-pr-seg button').forEach(bt => bt.onclick = () => {
      body.querySelectorAll('#hi-profile .cp-pr-seg button').forEach(o => o.classList.toggle('on', o === bt)); profile(bt.dataset.p);
    });

    // Excel: monthly, annual and hourly profile of the range (+ every hour, on request)
    const n2 = { width: 14, fmt: '0.00' };
    const ext = t => [{ title: `${P} max`, ...n2 }, { title: `${t} max date`, width: 12 }, { title: 'Max hour', width: 9, fmt: '0' }, { title: `${P} min`, ...n2 }, { title: `${t} min date`, width: 12 }, { title: 'Min hour', width: 9, fmt: '0' }];
    const sheets = () => [
      { name: 'Monthly', columns: [{ title: 'Market', width: 8 }, { title: 'Month', width: 9 }, { title: `${P} avg`, ...n2 }, { title: 'Energy avg', ...n2 }, { title: 'Losses avg', ...n2 }, { title: 'Congestion avg', ...n2 }, ...ext('Hour'), { title: 'Hours', width: 8, fmt: '0' }],
        rows: ['MDA', 'MTR'].flatMap(p => m[p].map(r => [p, r.mes, r.avg, r.ene, r.per, r.cng, r.max.v, r.max.f, r.max.h, r.min.v, r.min.f, r.min.h, r.horas])) },
      { name: 'Annual', columns: [{ title: 'Market', width: 8 }, { title: 'Year', width: 7 }, { title: `${P} avg`, ...n2 }, ...ext('Hour'), { title: 'Hours', width: 8, fmt: '0' }],
        rows: ['MDA', 'MTR'].flatMap(p => [...y[p].values()].sort((a, b) => a.y < b.y ? -1 : 1).map(r => [p, r.y, r.avg, r.max.v, r.max.f, r.max.h, r.min.v, r.min.f, r.min.h, r.horas])) },
      { name: 'Hourly profile', columns: [{ title: 'Market', width: 8 }, { title: 'Year', width: 7 }, ...Array.from({ length: 24 }, (_, i) => ({ title: 'H' + (i + 1), width: 9, fmt: '0.00' }))],
        rows: ['MDA', 'MTR'].flatMap(p => Object.entries((doc[p] && doc[p].perfil) || {}).filter(([yr]) => yr >= yFrom && yr <= yTo).sort().map(([yr, v]) => [p, yr, ...v])) }
    ];
    const fname = extra => `${P}_history_${doc.sistema}_${doc.clave.replace(/ /g, '-')}_${from}_${to}${extra}.xlsx`;
    body.querySelector('#hi-xlsx').onclick = () => Xlsx.download(fname(''), sheets());
    const hb = body.querySelector('#hi-xlsx-h');
    if (hb) hb.onclick = () => hourly(body, sheets, fname, P, from, to, ctx);
  }

  /* ── Hourly sheet: every hour of the range, month by month through the PML Worker ── */
  let job = null;  // the download in progress (one at a time)
  async function hourly(body, sheets, fname, P, from, to, ctx) {
    const msg = body.querySelector('.cp-hi-dlmsg'), btns = body.querySelectorAll('.cp-pr-dl');
    if (job) return;
    const list = []; for (let mo = from; mo <= to; mo = addMonths(mo, 1)) list.push(mo);
    const est = Math.max(1, Math.round(list.length * 2.5 / 60));
    const my = job = { cancel: false };
    const zone = ctx.node.kind === 'zone';
    btns.forEach(b => b.disabled = true);
    msg.hidden = false;
    const show = (t, done, total) => {
      msg.innerHTML = `<div class="cp-hi-dltxt">${t}</div>${total ? `<div class="cp-hi-bar"><i style="width:${Math.round(done / total * 100)}%"></i></div>` : ''}
        ${my.cancel || !total || done === total ? '' : '<button class="cp-btn-ghost cp-btn-sm" id="hi-cancel">Cancel</button>'}`;
      const c = msg.querySelector('#hi-cancel'); if (c) c.onclick = () => { my.cancel = true; };
    };
    const tasks = list.flatMap(mo => ['MDA', 'MTR'].map(p => ({ mo, p })));
    const rows = [];
    let done = 0, error = null;
    show(`Downloading every hour from ${mlong(from)} to ${mlong(to)} from CENACE (about ${est} min)…`, 0, tasks.length);
    const one = async ({ mo, p }) => {
      const qs = new URLSearchParams({ sistema: ctx.node.sistema, proceso: p, [zone ? 'zonas' : 'nodos']: ctx.node.nodo, desde: `${mo}-01`, hasta: monthEnd(mo) });
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await fetch(`${ctx.api}/${zone ? 'pend' : 'pml'}?${qs}`);
          if (r.status === 422) return;  // not published for those dates
          const b = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(b.message || 'HTTP ' + r.status);
          for (const h of ((zone ? b.zonas : b.nodos) || {})[ctx.node.nodo] || []) rows.push([p, h.fecha, h.hora, h.pml, h.pml_ene, h.pml_per, h.pml_cng]);
          return;
        } catch (e) { if (attempt >= 2) throw e; await new Promise(res => setTimeout(res, 3000)); }
      }
    };
    // Three requests at a time; each month is cached by Cloudflare for the next client
    const queue = tasks.slice();
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length && !my.cancel && !error) {
        const t = queue.shift();
        try { await one(t); } catch (e) { error = e; }
        done++;
        if (!my.cancel && !error) show(`Downloading every hour from ${mlong(from)} to ${mlong(to)} from CENACE… ${done} of ${tasks.length}`, done, tasks.length);
      }
    }));
    if (job === my) job = null;
    const finish = t => { if (body.isConnected) { msg.innerHTML = `<div class="cp-hi-dltxt">${t}</div>`; btns.forEach(b => b.disabled = false); } };
    if (my.cancel) return finish('Hourly download cancelled.');
    if (error) return finish(`The hourly data could not be downloaded (${esc(error.message)}). Please try again later.`);
    rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]);
    show(`Building the Excel file (${rows.length.toLocaleString('en-US')} hours)…`, 0, 0);
    await Xlsx.download(fname('_hourly'), [...sheets(), {
      name: 'Hourly', columns: [{ title: 'Market', width: 8 }, { title: 'Date', width: 11 }, { title: 'Hour', width: 6, fmt: '0' },
        { title: `${P} (MXN/MWh)`, width: 16, fmt: '0.00' }, { title: 'Energy', width: 12, fmt: '0.00' }, { title: 'Losses', width: 12, fmt: '0.00' }, { title: 'Congestion', width: 12, fmt: '0.00' }],
      rows
    }]);
    finish(`Excel ready: ${rows.length.toLocaleString('en-US')} hours from ${mlong(from)} to ${mlong(to)}.`);
  }

  return { mount };
})();
