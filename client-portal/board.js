/* ── Sentinels Client Portal · customizable boards ───────────────────
   "Dashboard" and "My Contract" are whiteboards of widgets the client
   picks from a catalog built from what the advisor entered in the admin
   panel. Layouts are saved per client in this browser (localStorage);
   the site has no server to store them, so a new device shows the default.
   Uses globals from index.html: ME, INTEL, MY_ID, _esc, _date, _fmtDate,
   _safeUrl, _initials, _tagClass, _dlDoc, viewIntelFile, goTo,
   DOC_TYPES, FILE_ICON. */
const Board = (() => {
  const esc = s => _esc(s);
  const SIZES = { s: 1, m: 2, w: 3, l: 4 };
  const SIZE_NAMES = { s: 'Small', m: 'Medium', w: 'Wide', l: 'Full width' };
  const C = { ink: '#0B0D0F', silver: '#B4BBC2', green: '#3E6B53', gold: '#C89D2A', steel: '#646C75', grid: '#E3E6E8' };

  /* ── Data helpers ─────────────────────────────── */
  const P = () => (ME && ME.profile) || {};
  const num = v => (v === '' || v == null || !isFinite(Number(v))) ? null : Number(v);
  const points = () => ((ME && ME.chart) || []).filter(p => p && isFinite(p.rate));
  const hasCfe = () => points().length >= 2 && points().every(p => isFinite(p.cfe));
  const hasGwh = () => points().length >= 2 && points().every(p => isFinite(p.gwh));
  const fx = (v, d = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = v => {
    const a = Math.abs(v), s = v < 0 ? '−$' : '$';
    return a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? s + Math.round(a / 1e3) + 'k' : s + Math.round(a).toLocaleString('en-US');
  };
  const monthsLeft = () => {
    const end = _date(P().contract_end);
    return end ? Math.max(0, Math.round((end - new Date()) / (1000 * 60 * 60 * 24 * 30.44))) : null;
  };
  const memPct = () => { const m = /([\d.]+)/.exec(String(P().mem_portion || '')); return m ? Math.min(100, Number(m[1])) : null; };
  const spreadPct = () => { const p = P(); return (num(p.rate) && num(p.cfe_rate)) ? (p.cfe_rate - p.rate) / p.cfe_rate * 100 : null; };

  /* ── Widget bodies ────────────────────────────── */
  function kpi(body, { value, unit = '', note = '', tone = 'neutral', text = false }) {
    body.innerHTML = `<div class="cp-kpi-value${text ? ' cp-kpi-value--text' : ''}">${esc(value)}${unit ? `<span class="cp-kpi-unit">${esc(unit)}</span>` : ''}</div>` +
      (note ? `<div class="cp-kpi-delta cp-kpi-delta--${tone}">${esc(note)}</div>` : '');
  }

  const ICON = {
    kpi: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/>',
    line: '<path d="M3 17l5-6 4 3 6-8 3 3"/><path d="M3 21h18"/>',
    bar: '<path d="M6 20V11M12 20V5M18 20v-7"/><path d="M3 20h18"/>',
    donut: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 4v4.5"/>',
    timeline: '<path d="M3 12h18"/><circle cx="8" cy="12" r="2"/><path d="M17 8v8"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    contract: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'
  };

  // [category, title, icon, sizes, default size, description, ready(), missing-data hint, render(body)]
  const CATALOG = {
    kpi_rate: { cat: 'Key figures', title: 'Active rate', icon: 'kpi', sizes: ['s', 'm'], desc: 'Your current contracted rate.',
      ready: () => num(P().rate) != null, need: 'your active rate',
      render: b => { const sp = spreadPct(); kpi(b, { value: fx(P().rate), unit: 'MXN/kWh', note: sp != null ? `↓ ${fx(sp, 1)}% vs CFE GDMTH` : '', tone: 'pos' }); } },
    kpi_cfe: { cat: 'Key figures', title: 'CFE reference rate', icon: 'kpi', sizes: ['s', 'm'], desc: 'The CFE tariff you are compared against.',
      ready: () => num(P().cfe_rate) != null, need: 'the CFE reference rate',
      render: b => kpi(b, { value: fx(P().cfe_rate), unit: 'MXN/kWh', note: 'CFE GDMTH reference' }) },
    kpi_spread: { cat: 'Key figures', title: 'Savings vs CFE', icon: 'kpi', sizes: ['s', 'm'], desc: 'How far below the CFE tariff you pay.',
      ready: () => spreadPct() != null, need: 'your rate and the CFE rate',
      render: b => kpi(b, { value: fx(spreadPct(), 1), unit: '%', note: `${fx(P().cfe_rate - P().rate)} MXN/kWh below CFE`, tone: 'pos' }) },
    kpi_savings_month: { cat: 'Key figures', title: 'Est. monthly savings', icon: 'kpi', sizes: ['s', 'm'], desc: 'Estimated savings per month.',
      ready: () => num(P().savings_monthly) != null, need: 'estimated monthly savings',
      render: b => kpi(b, { value: money(P().savings_monthly), unit: 'MXN', note: 'vs CFE reference tariff', tone: 'pos' }) },
    kpi_savings_year: { cat: 'Key figures', title: 'Est. annual savings', icon: 'kpi', sizes: ['s', 'm'], desc: 'Monthly savings projected over 12 months.',
      ready: () => num(P().savings_monthly) != null, need: 'estimated monthly savings',
      render: b => kpi(b, { value: money(P().savings_monthly * 12), unit: 'MXN', note: '12-month projection', tone: 'pos' }) },
    kpi_ytd: { cat: 'Key figures', title: 'YTD consumption', icon: 'kpi', sizes: ['s', 'm'], desc: 'Energy consumed so far this year.',
      ready: () => num(P().ytd_gwh) != null, need: 'year-to-date consumption',
      render: b => kpi(b, { value: fx(P().ytd_gwh, 1), unit: 'GWh', note: 'Year to date' }) },
    kpi_contract_end: { cat: 'Contract', title: 'Contract expires', icon: 'timeline', sizes: ['s', 'm'], desc: 'End date and months remaining.',
      ready: () => !!_date(P().contract_end), need: 'the contract end date',
      render: b => kpi(b, { value: _date(P().contract_end).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), note: `${monthsLeft()} months remaining`, tone: 'notice' }) },
    kpi_counterparty: { cat: 'Contract', title: 'Counterparty', icon: 'person', sizes: ['s', 'm'], desc: 'Who supplies your energy.',
      ready: () => !!P().counterparty, need: 'the counterparty',
      render: b => kpi(b, { value: P().counterparty, note: P().counterparty_note, text: true }) },
    kpi_volume: { cat: 'Contract', title: 'Annual volume', icon: 'kpi', sizes: ['s', 'm'], desc: 'Contracted annual volume.',
      ready: () => num(P().volume_gwh) != null, need: 'the annual volume',
      render: b => kpi(b, { value: fx(P().volume_gwh, 0), unit: 'GWh', note: P().volume_note }) },
    kpi_base_price: { cat: 'Contract', title: 'Base price', icon: 'kpi', sizes: ['s', 'm'], desc: 'Contract base price.',
      ready: () => num(P().base_price) != null, need: 'the base price',
      render: b => kpi(b, { value: fx(P().base_price), unit: 'MXN/kWh', note: P().price_note }) },
    kpi_escalation: { cat: 'Contract', title: 'Price escalation', icon: 'kpi', sizes: ['s', 'm'], desc: 'How the price adjusts over time.',
      ready: () => !!P().escalation, need: 'the escalation terms',
      render: b => kpi(b, { value: P().escalation, note: P().escalation_note, text: true }) },
    kpi_mem: { cat: 'Contract', title: 'MEM-indexed portion', icon: 'kpi', sizes: ['s', 'm'], desc: 'Share of volume priced at the wholesale market.',
      ready: () => !!P().mem_portion, need: 'the MEM-indexed portion',
      render: b => kpi(b, { value: P().mem_portion, note: P().mem_note, text: true }) },
    kpi_billed: { cat: 'Contract', title: () => P().billed_label || 'Last billed', icon: 'kpi', sizes: ['s', 'm'], desc: 'Energy billed in the last period.',
      ready: () => num(P().billed_gwh) != null, need: 'the last billed volume',
      render: b => kpi(b, { value: fx(P().billed_gwh, 1), unit: 'GWh', note: P().billed_note }) },

    chart_rates: { cat: 'Charts', title: 'Rate comparison', icon: 'line', sizes: ['m', 'w', 'l'], desc: 'Your rate vs CFE month by month. Hover for details.',
      ready: () => points().length >= 2, need: 'monthly rate history',
      render: b => {
        const pts = points(), series = [{ name: 'Sentinel rate', color: C.ink, values: pts.map(p => p.rate) }];
        if (hasCfe()) series.push({ name: 'CFE GDMTH', color: C.silver, values: pts.map(p => p.cfe), fillTo: 0 });
        lineChart(b, { labels: pts.map(p => p.label), series, fmt: v => fx(v) + ' MXN/kWh', axis: v => fx(v) });
      } },
    chart_spread: { cat: 'Charts', title: 'Monthly spread vs CFE', icon: 'bar', sizes: ['m', 'w', 'l'], desc: 'MXN/kWh below the CFE tariff each month.',
      ready: hasCfe, need: 'monthly rates including CFE',
      render: b => { const pts = points(); barChart(b, { labels: pts.map(p => p.label), values: pts.map(p => p.cfe - p.rate), color: C.green, fmt: v => fx(v) + ' MXN/kWh below CFE', axis: v => fx(v) }); } },
    chart_savings_pct: { cat: 'Charts', title: 'Savings % vs CFE', icon: 'line', sizes: ['m', 'w', 'l'], desc: 'Percent below CFE over time.',
      ready: hasCfe, need: 'monthly rates including CFE',
      render: b => { const pts = points(); lineChart(b, { labels: pts.map(p => p.label), series: [{ name: 'Below CFE', color: C.green, values: pts.map(p => (p.cfe - p.rate) / p.cfe * 100), area: true }], fmt: v => fx(v, 1) + '%', axis: v => fx(v, 0) + '%' }); } },
    chart_consumption: { cat: 'Charts', title: 'Monthly consumption', icon: 'bar', sizes: ['m', 'w', 'l'], desc: 'GWh consumed each month.',
      ready: hasGwh, need: 'monthly consumption (GWh)',
      render: b => { const pts = points(); barChart(b, { labels: pts.map(p => p.label), values: pts.map(p => p.gwh), color: C.ink, fmt: v => fx(v, 1) + ' GWh', axis: v => fx(v, 0) }); } },
    chart_savings_mxn: { cat: 'Charts', title: 'Monthly savings (MXN)', icon: 'bar', sizes: ['m', 'w', 'l'], desc: 'Estimated pesos saved each month vs CFE.',
      ready: () => hasCfe() && hasGwh(), need: 'monthly rates, CFE and consumption',
      render: b => { const pts = points(); barChart(b, { labels: pts.map(p => p.label), values: pts.map(p => (p.cfe - p.rate) * p.gwh * 1e6), color: C.gold, fmt: money, axis: money, total: true }); } },
    chart_mix: { cat: 'Contract', title: 'Pricing mix', icon: 'donut', sizes: ['s', 'm'], desc: 'Fixed-price vs MEM-indexed share.',
      ready: () => memPct() != null, need: 'the MEM-indexed portion',
      render: b => { const m = memPct(); donut(b, [{ label: 'Fixed price', value: 100 - m, color: C.ink }, { label: 'MEM-indexed', value: m, color: C.silver }]); } },
    contract_progress: { cat: 'Contract', title: 'Contract timeline', icon: 'timeline', sizes: ['m', 'w', 'l'], desc: 'Where you are in the contract term.',
      ready: () => !!(_date(P().contract_start) && _date(P().contract_end)), need: 'contract start and end dates',
      render: b => timeline(b) },
    contract_summary: { cat: 'Contract', title: 'Contract summary', icon: 'contract', sizes: ['m', 'w', 'l'], desc: 'Contract ID, type and term.',
      ready: () => true, need: '',
      render: b => {
        const p = P(), s = _date(p.contract_start), e = _date(p.contract_end);
        const long = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        b.innerHTML = `<div class="cp-contract-id">CONTRACT ID · ${esc(p.contract_id || '—')}</div>
          <div class="cp-contract-title">${esc(p.contract_title || 'Power Purchase Agreement')}</div>
          <div class="cp-contract-period">${s && e ? esc(long(s) + ' — ' + long(e)) : ''}</div>
          <div class="cp-contract-status" style="margin-top:12px">Active</div>`;
      } },
    advisor: { cat: 'Contract', title: 'Your advisor', icon: 'person', sizes: ['s', 'm', 'w'], desc: 'Contact your Sentinel advisor.',
      ready: () => true, need: '',
      render: b => {
        const p = P(), mail = p.advisor_email || 'contacto@sentinels.com.mx';
        const call = _safeUrl(p.call_url) || 'mailto:' + mail + '?subject=' + encodeURIComponent('Schedule a call — ' + (p.company || ''));
        b.innerHTML = `<div class="cp-advisor-card" style="padding:0;box-shadow:none;border:0">
          <div class="cp-advisor-avatar">${esc(_initials(p.advisor_name || 'Sentinel'))}</div>
          <div style="min-width:0"><div class="cp-advisor-name">${esc(p.advisor_name || 'Sentinel Advisory Team')}</div>
            <div class="cp-advisor-role">Senior Advisor · Sentinel Energy Partners</div>
            <div class="cp-advisor-contacts">
              <a class="cp-advisor-link" href="mailto:${esc(mail)}">Email</a>
              <a class="cp-advisor-link" href="${esc(call)}" target="_blank" rel="noopener">Schedule a call</a>
            </div></div></div>`;
      } },
    intel_list: { cat: 'Updates', title: 'Market Intelligence', icon: 'news', sizes: ['s', 'm', 'w', 'l'], desc: 'Latest updates from your advisory team.',
      ready: () => true, need: '',
      render: (b, w) => {
        const items = (INTEL || []).slice(0, w.size === 's' ? 3 : 4);
        b.innerHTML = (items.length ? `<div class="cp-intel-list">${items.map((i, n) => `<div class="cp-intel-item">
            <div class="cp-intel-meta"><span class="cp-intel-tag ${_tagClass(i.tag)}">${esc(i.tag || 'Update')}</span><span class="cp-intel-date">${_fmtDate(i.date)}</span></div>
            <div class="cp-intel-title">${esc(i.title)}</div><div class="cp-intel-summary">${esc(i.summary)}</div>
            ${(i.files || []).length ? `<button class="cp-card-link" style="align-self:flex-start" onclick="viewIntelFile(${n},0)">View attachment →</button>` : ''}</div>`).join('')}</div>`
          : '<div class="cp-widget-empty">No market updates yet.</div>') +
          `<button class="cp-card-link cp-widget-more" onclick="goTo('intelligence')">View all →</button>`;
      } },
    docs_recent: { cat: 'Updates', title: 'Recent documents', icon: 'doc', sizes: ['m', 'w', 'l'], desc: 'Your latest reports and files.',
      ready: () => true, need: '',
      render: (b, w) => {
        const docs = ((ME && ME.docs) || []).slice(0, SIZES[w.size] >= 3 ? 4 : 2);
        b.innerHTML = (docs.length ? `<div class="cp-docs-grid cp-docs-grid--w">${docs.map((d, i) => `<div class="cp-doc-mini" style="cursor:pointer" onclick="_dlDoc(${i})">
            <div class="cp-doc-icon">${FILE_ICON}</div><div class="cp-doc-name">${esc(d.name)}</div>
            <div class="cp-doc-badge">${DOC_TYPES[d.type] || 'Report'}</div><div class="cp-doc-meta">${_fmtDate(d.date)}</div></div>`).join('')}</div>`
          : '<div class="cp-widget-empty">No documents have been shared yet.</div>') +
          `<button class="cp-card-link cp-widget-more" onclick="goTo('documents')">View all →</button>`;
      } },

    /* Plants & bills — real data from the monthly bills (energy.js) */
    kpi_last_bill: { cat: 'Plants & bills', title: 'Latest bill', icon: 'kpi', sizes: ['s', 'm'], desc: 'Total paid in your latest month, all plants.',
      ready: () => !!Energy.latestMonth(), need: 'monthly bills',
      render: b => { const m = Energy.latestMonth(); kpi(b, { value: money(m.total), unit: 'MXN', note: `${m.label} · ${m.sites} plant${m.sites === 1 ? '' : 's'}` }); } },
    kpi_ytd_cost: { cat: 'Plants & bills', title: 'Spend this year', icon: 'kpi', sizes: ['s', 'm'], desc: 'Total paid so far this year, from your bills.',
      ready: () => Energy.ytd().months > 0, need: 'monthly bills',
      render: b => { const y = Energy.ytd(); kpi(b, { value: money(y.total), unit: 'MXN', note: `${y.from}${y.months > 1 ? ' – ' + y.to : ''} · ${y.months} month${y.months === 1 ? '' : 's'}` }); } },
    kpi_ytd_kwh: { cat: 'Plants & bills', title: 'Consumption this year', icon: 'kpi', sizes: ['s', 'm'], desc: 'kWh consumed so far this year, from your bills.',
      ready: () => Energy.ytd().months > 0, need: 'monthly bills',
      render: b => { const y = Energy.ytd(); kpi(b, { value: fx(y.kwh / 1e6, 2), unit: 'GWh', note: `${y.from}${y.months > 1 ? ' – ' + y.to : ''} · avg ${fx(y.kwh / y.months / 1e6, 2)} GWh/month` }); } },
    kpi_real_savings_ytd: { cat: 'Plants & bills', title: 'Real savings YTD', icon: 'kpi', sizes: ['s', 'm'], desc: 'What your actual bills saved versus CFE this year.',
      ready: () => Energy.savingsYTD().months > 0, need: 'bills with their CFE equivalent',
      render: b => { const y = Energy.savingsYTD(); kpi(b, { value: money(y.saved), unit: 'MXN', note: `${y.pct != null ? fx(y.pct, 1) + '% below CFE · ' : ''}${y.months} month${y.months === 1 ? '' : 's'}`, tone: 'pos' }); } },
    kpi_cost_kwh: { cat: 'Plants & bills', title: 'Average cost per kWh', icon: 'kpi', sizes: ['s', 'm'], desc: 'Total paid ÷ kWh in your latest month, all plants.',
      ready: () => !!(Energy.latestMonth() && Energy.latestMonth().costKwh != null), need: 'monthly bills',
      render: b => {
        const m = Energy.monthly(), last = m[m.length - 1], prev = m[m.length - 2];
        const d = prev && prev.costKwh ? (last.costKwh / prev.costKwh - 1) * 100 : null;
        kpi(b, { value: fx(last.costKwh), unit: 'MXN/kWh', note: `${last.label}${d != null ? ` · ${d >= 0 ? '↑' : '↓'} ${fx(Math.abs(d), 1)}% vs ${prev.label}` : ''}`, tone: d != null && d > 0 ? 'notice' : 'neutral' });
      } },
    kpi_peak_demand: { cat: 'Plants & bills', title: 'Peak demand vs contracted', icon: 'kpi', sizes: ['s', 'm'], desc: 'Highest demand against contracted kW, latest bill.',
      ready: () => Energy.siteSummary().some(s => s.demandPct != null), need: 'demand and contracted kW',
      render: b => {
        const s = Energy.siteSummary().filter(x => x.demandPct != null).sort((a, c) => c.demandPct - a.demandPct)[0];
        kpi(b, { value: fx(s.demandPct, 0), unit: '%', note: `${s.name} · ${Energy.label(s.last.month)}`, tone: s.demandPct >= 95 ? 'notice' : 'neutral' });
      } },
    kpi_pf: { cat: 'Plants & bills', title: 'Power factor', icon: 'kpi', sizes: ['s', 'm'], desc: 'Lowest power factor across plants, latest bill.',
      ready: () => Energy.siteSummary().some(s => s.last && s.last.pf != null), need: 'power factor on the bills',
      render: b => {
        const s = Energy.siteSummary().filter(x => x.last && x.last.pf != null).sort((a, c) => a.last.pf - c.last.pf)[0];
        kpi(b, { value: fx(s.last.pf), note: `${s.name}${s.last.pf < 0.9 ? ' · below 0.90 threshold' : ' · above 0.90'}`, tone: s.last.pf < 0.9 ? 'notice' : 'pos' });
      } },
    alerts: { cat: 'Plants & bills', title: 'Alerts', icon: 'bell', sizes: ['s', 'm', 'w', 'l'], desc: 'Power factor, demand, cost spikes, missing bills, contract deadlines.',
      ready: () => true, need: '',
      render: b => {
        const a = Energy.alerts();
        b.innerHTML = a.length ? `<div class="cp-alerts">${a.map(x => `<div class="cp-alert cp-alert--${x.level}">${esc(x.text)}</div>`).join('')}</div>`
          : '<div class="cp-widget-empty">No alerts right now.</div>';
      } },
    chart_periods: { cat: 'Plants & bills', title: 'Monthly consumption by period (B · I · P)', icon: 'bar', sizes: ['m', 'w', 'l'], desc: 'Base (B), intermediate (I) and peak (P) kWh each month.',
      ready: () => Energy.hasPeriods() && Energy.monthly().length >= 1, need: 'bills with kWh by period',
      render: b => {
        const m = Energy.monthly();
        const series = [{ name: 'Base (B)', color: '#B4BBC2', values: m.map(r => r.base) }, { name: 'Intermediate (I)', color: '#646C75', values: m.map(r => r.int) }, { name: 'Peak (P)', color: C.ink, values: m.map(r => r.peak) }];
        // Bills that only report a total (e.g. GDMTO) still count toward the month
        const rest = m.map(r => Math.max(0, r.kwh - r.base - r.int - r.peak));
        if (rest.some(v => v > 0)) series.push({ name: 'Not split by period', color: '#E3DCC8', values: rest });
        stackedChart(b, { labels: m.map(r => r.label), series, fmt: v => fx(v / 1e6, 2) + ' GWh', axis: v => fx(v / 1e6, 1) });
      } },
    chart_real_savings: { cat: 'Plants & bills', title: 'Real savings by month', icon: 'bar', sizes: ['m', 'w', 'l'], desc: 'CFE equivalent minus what you paid, from your bills.',
      ready: () => Energy.monthly().filter(r => r.savings != null).length >= 1, need: 'bills with their CFE equivalent',
      render: b => { const m = Energy.monthly().filter(r => r.savings != null); barChart(b, { labels: m.map(r => r.label), values: m.map(r => r.savings), color: C.green, fmt: money, axis: money, total: true }); } },
    chart_cost_kwh: { cat: 'Plants & bills', title: 'Cost per kWh by month', icon: 'line', sizes: ['m', 'w', 'l'], desc: 'Total paid ÷ kWh, all plants combined.',
      ready: () => Energy.monthly().filter(r => r.costKwh != null).length >= 2, need: 'two or more monthly bills',
      render: b => { const m = Energy.monthly().filter(r => r.costKwh != null); lineChart(b, { labels: m.map(r => r.label), series: [{ name: 'Cost per kWh', color: C.ink, values: m.map(r => r.costKwh), area: true }], fmt: v => fx(v, 3) + ' MXN/kWh', axis: v => fx(v) }); } },
    sites_table: { cat: 'Plants & bills', title: 'Your plants', icon: 'person', sizes: ['m', 'w', 'l'], desc: 'Latest bill of each plant side by side.',
      ready: () => Energy.sites().length > 0, need: 'plants',
      render: b => {
        const rows = Energy.siteSummary();
        b.innerHTML = `<div class="s1-table" style="margin:0"><table class="cp-mini-table"><thead><tr><th>Plant</th><th>Month</th><th>kWh</th><th>MXN/kWh</th><th>PF</th><th>Demand</th></tr></thead><tbody>
          ${rows.map(s => `<tr><td>${esc(s.name)}</td><td>${s.last ? esc(Energy.label(s.last.month)) : '—'}</td><td>${s.last ? fx(Energy.kwh(s.last) / 1e6, 2) + ' GWh' : '—'}</td>
            <td>${s.costKwh != null ? fx(s.costKwh) : '—'}</td><td class="${s.last && s.last.pf != null && s.last.pf < 0.9 ? 'cp-bad' : ''}">${s.last && s.last.pf != null ? fx(s.last.pf) : '—'}</td>
            <td>${s.demandPct != null ? fx(s.demandPct, 0) + '%' : '—'}</td></tr>`).join('')}</tbody></table></div>
          <button class="cp-card-link cp-widget-more" onclick="goTo('sites')">Open My Sites →</button>`;
      } },
    contracts_list: { cat: 'Contract', title: 'Your contracts', icon: 'contract', sizes: ['m', 'w', 'l'], desc: 'Every contract with its term and progress.',
      ready: () => Energy.contracts().length > 0, need: 'contracts',
      render: b => {
        const now = new Date();
        b.innerHTML = `<div class="cp-ctr-list">${Energy.contracts().slice().sort((a, c) => String(a.end).localeCompare(String(c.end))).map(c => {
          const s = _date(c.start), e = _date(c.end), pct = s && e ? Math.min(100, Math.max(0, (now - s) / (e - s) * 100)) : null;
          return `<div class="cp-ctr"><div class="cp-ctr-top"><b>${esc(c.name || c.type)}</b><span>${esc(c.type)} · ${esc(c.counterparty)}${c.technology ? ' · ' + esc(c.technology) : ''}</span></div>
            <div class="cp-ctr-facts">${c.volume_gwh != null ? `<span>${fx(c.volume_gwh, 1)} GWh/yr</span>` : ''}${c.price_mxn_kwh != null ? `<span>${fx(c.price_mxn_kwh, 3)} MXN/kWh</span>` : ''}${c.fixed_pct != null ? `<span>${fx(c.fixed_pct, 0)}% fixed</span>` : ''}${c.escalation ? `<span>${esc(c.escalation)}</span>` : ''}</div>
            ${pct != null ? `<div class="cp-ctr-bar"><i style="width:${pct}%"></i></div><div class="cp-ctr-dates"><span>${esc(_fmtDate(c.start))}</span><span>${pct.toFixed(0)}% elapsed</span><span>${esc(_fmtDate(c.end))}</span></div>` : ''}
            ${c.notes ? `<div class="cp-ctr-notes">${esc(c.notes)}</div>` : ''}</div>`;
        }).join('')}</div>`;
      } }
  };
  const CATS = ['Plants & bills', 'Key figures', 'Charts', 'Contract', 'Updates'];
  const titleOf = t => typeof CATALOG[t].title === 'function' ? CATALOG[t].title() : CATALOG[t].title;

  // Widgets fed by the advisor's manual contract data or by savings versus CFE only
  // apply to Qualified Supply clients; CFE (basic service) clients don't see them
  const QUALIFIED_ONLY = ['kpi_rate', 'kpi_cfe', 'kpi_spread', 'kpi_savings_month', 'kpi_savings_year', 'kpi_ytd', 'kpi_contract_end',
    'kpi_counterparty', 'kpi_volume', 'kpi_base_price', 'kpi_escalation', 'kpi_mem', 'kpi_billed', 'chart_rates', 'chart_spread',
    'chart_savings_pct', 'chart_consumption', 'chart_savings_mxn', 'chart_mix', 'contract_progress', 'contract_summary',
    'kpi_real_savings_ytd', 'chart_real_savings'];
  for (const k of QUALIFIED_ONLY) { const ready = CATALOG[k].ready; CATALOG[k].qualifiedOnly = true; CATALOG[k].ready = () => Energy.isQualified() && ready(); }
  const offered = t => !CATALOG[t].qualifiedOnly || Energy.isQualified();

  // Default layouts: CFE clients get indicators computed from their bills;
  // Qualified Supply clients get savings versus CFE and their contract terms
  const BOARDS = ['dashboard', 'contract'];
  function defaults(b) {
    if (b === 'dashboard') {
      if (!Energy.isQualified()) return [['kpi_last_bill', 's'], ['kpi_ytd_cost', 's'], ['kpi_ytd_kwh', 's'], ['kpi_cost_kwh', 's'],
        ['chart_periods', 'w'], ['alerts', 's'], ['kpi_pf', 's'], ['kpi_peak_demand', 's'], ['chart_cost_kwh', 'm'], ['sites_table', 'l'], ['docs_recent', 'l']];
      return Energy.hasBills()
        ? [['kpi_real_savings_ytd', 's'], ['kpi_cost_kwh', 's'], ['kpi_peak_demand', 's'], ['kpi_contract_end', 's'], ['chart_periods', 'w'], ['alerts', 's'], ['chart_real_savings', 'm'], ['sites_table', 'm'], ['docs_recent', 'l']]
        : [['kpi_rate', 's'], ['kpi_savings_month', 's'], ['kpi_ytd', 's'], ['kpi_contract_end', 's'], ['chart_rates', 'w'], ['intel_list', 's'], ['docs_recent', 'l']];
    }
    return (Energy.contracts().length ? [['contracts_list', 'l']] : []).concat([['contract_summary', 'l'], ['kpi_counterparty', 's'], ['kpi_volume', 's'], ['kpi_base_price', 's'], ['kpi_escalation', 's'],
      ['contract_progress', 'w'], ['chart_mix', 's'], ['kpi_mem', 's'], ['kpi_billed', 's'], ['advisor', 'm']]);
  }

  /* ── Interactive charts (SVG, redrawn on resize) ── */
  const NS = 'http://www.w3.org/2000/svg';
  function chartShell(body, { labels, legend, ranges = true }) {
    const n = labels.length;
    const opts = [[3, '3M'], [6, '6M'], [12, '12M']].filter(([k]) => k < n);
    body.innerHTML = `<div class="cp-ch-bar">
        <div class="cp-ch-legend">${(legend || []).map((s, i) => `<button class="cp-ch-key" data-i="${i}"><span style="background:${s.color}"></span>${esc(s.name)}</button>`).join('')}</div>
        ${ranges && opts.length ? `<div class="cp-ch-ranges">${opts.map(([k, t]) => `<button data-r="${k}">${t}</button>`).join('')}<button data-r="0" class="on">All</button></div>` : ''}
      </div><div class="cp-ch-plot"><div class="cp-ch-tip" hidden></div></div>`;
    return { plot: body.querySelector('.cp-ch-plot'), tip: body.querySelector('.cp-ch-tip') };
  }
  function niceScale(lo, hi, ticks = 4) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }
  function observe(plot, draw) {
    let last = 0;
    const ro = new ResizeObserver(() => { const w = Math.round(plot.clientWidth); if (w && w !== last) { last = w; draw(); } });
    ro.observe(plot);
    return () => { last = 0; draw(); };
  }
  function tipAt(plot, tip, x, html) {
    tip.innerHTML = html; tip.hidden = false;
    // Beside the crosshair (right if it fits, else left) so it never hides the points
    const w = tip.offsetWidth, W = plot.clientWidth;
    tip.style.left = (x + 14 + w <= W ? x + 14 : Math.max(4, x - 14 - w)) + 'px';
  }

  function lineChart(body, { labels, series, fmt, axis }) {
    const { plot, tip } = chartShell(body, { labels, legend: series.length > 1 ? series : null });
    const hidden = new Set();
    let range = 0;
    const H = 210, pL = 46, pR = 12, pT = 12, pB = 26;
    function draw() {
      const W = plot.clientWidth; if (!W) return;
      const from = range ? Math.max(0, labels.length - range) : 0;
      const L = labels.slice(from), vis = series.filter((s, i) => !hidden.has(i));
      const n = L.length;
      plot.querySelector('svg')?.remove();
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      const vals = vis.flatMap(s => s.values.slice(from)).filter(isFinite);
      if (!vals.length) { plot.prepend(svg); return; }
      const sc = niceScale(Math.min(...vals), Math.max(...vals));
      const x = i => pL + (n === 1 ? (W - pL - pR) / 2 : i / (n - 1) * (W - pL - pR));
      const y = v => pT + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - pT - pB);
      let g = '';
      for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step)
        g += `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${pL - 6}" y="${y(v) + 3.5}" text-anchor="end" class="cp-ch-ax">${esc(axis(v))}</text>`;
      const every = Math.ceil(n / Math.max(2, Math.floor((W - pL - pR) / 62)));
      L.forEach((l, i) => { if (i % every === 0 || i === n - 1 && n <= 4) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="cp-ch-ax">${esc(l)}</text>`; });
      // Shaded gap between the two series (savings band)
      if (vis.length === 2 && series.length === 2) {
        const a = vis[0].values.slice(from), b = vis[1].values.slice(from);
        g += `<polygon points="${b.map((v, i) => `${x(i)},${y(v)}`).concat(a.map((v, i) => `${x(i)},${y(v)}`).reverse()).join(' ')}" fill="${C.green}" opacity="0.08"/>`;
      }
      vis.forEach(s => {
        const v = s.values.slice(from), pts = v.map((d, i) => `${x(i)},${y(d)}`).join(' ');
        if (s.area) g += `<polygon points="${x(0)},${y(sc.lo)} ${pts} ${x(n - 1)},${y(sc.lo)}" fill="${s.color}" opacity="0.1"/>`;
        g += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      });
      g += `<line class="cp-ch-cross" y1="${pT}" y2="${H - pB}" stroke="${C.steel}" stroke-dasharray="3 3" visibility="hidden"/>`;
      vis.forEach((s, k) => g += `<circle class="cp-ch-dot" data-k="${k}" r="4.5" fill="#fff" stroke="${s.color}" stroke-width="2.5" visibility="hidden"/>`);
      svg.innerHTML = g;
      plot.prepend(svg);
      const move = ev => {
        const r = svg.getBoundingClientRect(), px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
        const i = Math.max(0, Math.min(n - 1, Math.round((px - pL) / ((W - pL - pR) / Math.max(1, n - 1)))));
        const cross = svg.querySelector('.cp-ch-cross');
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        svg.querySelectorAll('.cp-ch-dot').forEach(d => { const s = vis[d.dataset.k]; d.setAttribute('cx', x(i)); d.setAttribute('cy', y(s.values[from + i])); d.setAttribute('visibility', 'visible'); });
        let rows = vis.map(s => `<div><span style="background:${s.color}"></span>${esc(s.name)} <b>${esc(fmt(s.values[from + i]))}</b></div>`).join('');
        if (vis.length === 2 && series.length === 2) rows += `<div class="cp-ch-tip-note">Spread ${esc(fx(vis[1].values[from + i] - vis[0].values[from + i]))} MXN/kWh</div>`;
        tipAt(plot, tip, x(i), `<div class="cp-ch-tip-t">${esc(L[i])}</div>${rows}`);
      };
      const leave = () => { tip.hidden = true; svg.querySelectorAll('.cp-ch-cross,.cp-ch-dot').forEach(e => e.setAttribute('visibility', 'hidden')); };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
    }
    const redraw = observe(plot, draw);
    body.querySelectorAll('.cp-ch-key').forEach(k => k.onclick = () => {
      const i = +k.dataset.i;
      if (hidden.has(i)) hidden.delete(i); else if (hidden.size < series.length - 1) hidden.add(i);
      k.classList.toggle('off', hidden.has(i)); redraw();
    });
    body.querySelectorAll('.cp-ch-ranges button').forEach(bt => bt.onclick = () => {
      range = +bt.dataset.r; body.querySelectorAll('.cp-ch-ranges button').forEach(o => o.classList.toggle('on', o === bt)); redraw();
    });
  }

  function barChart(body, { labels, values, color, fmt, axis, total }) {
    const { plot, tip } = chartShell(body, { labels });
    let range = 0;
    const H = 210, pL = 52, pR = 12, pT = 12, pB = 26;
    if (total) body.querySelector('.cp-ch-bar').insertAdjacentHTML('afterbegin', '<div class="cp-ch-total"></div>');
    function draw() {
      const W = plot.clientWidth; if (!W) return;
      const from = range ? Math.max(0, labels.length - range) : 0;
      const L = labels.slice(from), V = values.slice(from), n = L.length;
      if (total) body.querySelector('.cp-ch-total').innerHTML = `Total <b>${esc(fmt(V.reduce((a, b) => a + b, 0)))}</b>`;
      plot.querySelector('svg')?.remove();
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      const sc = niceScale(Math.min(0, ...V), Math.max(0, ...V));
      const y = v => pT + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - pT - pB);
      const slot = (W - pL - pR) / n, bw = Math.max(4, Math.min(42, slot * 0.62));
      const cx = i => pL + slot * i + slot / 2;
      let g = '';
      for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step)
        g += `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${pL - 6}" y="${y(v) + 3.5}" text-anchor="end" class="cp-ch-ax">${esc(axis(v))}</text>`;
      const every = Math.ceil(n / Math.max(2, Math.floor((W - pL - pR) / 52)));
      V.forEach((v, i) => {
        const top = y(Math.max(0, v)), h = Math.max(1, Math.abs(y(v) - y(0)));
        g += `<rect class="cp-ch-b" data-i="${i}" x="${cx(i) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="2" fill="${v < 0 ? '#8C3A36' : color}"/>`;
        if (i % every === 0) g += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="cp-ch-ax">${esc(L[i])}</text>`;
      });
      svg.innerHTML = g;
      plot.prepend(svg);
      const move = ev => {
        const r = svg.getBoundingClientRect(), px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
        const i = Math.max(0, Math.min(n - 1, Math.floor((px - pL) / slot)));
        svg.querySelectorAll('.cp-ch-b').forEach(b => b.setAttribute('opacity', +b.dataset.i === i ? 1 : 0.45));
        tipAt(plot, tip, cx(i), `<div class="cp-ch-tip-t">${esc(L[i])}</div><div><b>${esc(fmt(V[i]))}</b></div>`);
      };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', () => { tip.hidden = true; svg.querySelectorAll('.cp-ch-b').forEach(b => b.setAttribute('opacity', 1)); });
    }
    const redraw = observe(plot, draw);
    body.querySelectorAll('.cp-ch-ranges button').forEach(bt => bt.onclick = () => {
      range = +bt.dataset.r; body.querySelectorAll('.cp-ch-ranges button').forEach(o => o.classList.toggle('on', o === bt)); redraw();
    });
  }

  // Stacked bars (e.g. base / intermediate / peak kWh); legend toggles series
  function stackedChart(body, { labels, series, fmt, axis }) {
    const { plot, tip } = chartShell(body, { labels, legend: series });
    const hidden = new Set();
    let range = 0;
    const H = 210, pL = 46, pR = 12, pT = 12, pB = 26;
    function draw() {
      const W = plot.clientWidth; if (!W) return;
      const from = range ? Math.max(0, labels.length - range) : 0;
      const L = labels.slice(from), n = L.length, vis = series.filter((s, i) => !hidden.has(i));
      const totals = L.map((_, i) => vis.reduce((t, s) => t + (s.values[from + i] || 0), 0));
      plot.querySelector('svg')?.remove();
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
      const sc = niceScale(0, Math.max(1, ...totals));
      const y = v => pT + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - pT - pB);
      const slot = (W - pL - pR) / n, bw = Math.max(6, Math.min(44, slot * 0.62)), cx = i => pL + slot * i + slot / 2;
      let g = '';
      for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step)
        g += `<line x1="${pL}" x2="${W - pR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/><text x="${pL - 6}" y="${y(v) + 3.5}" text-anchor="end" class="cp-ch-ax">${esc(axis(v))}</text>`;
      const every = Math.ceil(n / Math.max(2, Math.floor((W - pL - pR) / 52)));
      L.forEach((l, i) => {
        let acc = 0;
        vis.forEach(s => {
          const v = s.values[from + i] || 0;
          if (v > 0) g += `<rect class="cp-ch-b" data-i="${i}" x="${cx(i) - bw / 2}" y="${y(acc + v)}" width="${bw}" height="${Math.max(0.5, y(acc) - y(acc + v))}" fill="${s.color}"/>`;
          acc += v;
        });
        if (i % every === 0) g += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="cp-ch-ax">${esc(l)}</text>`;
      });
      svg.innerHTML = g;
      plot.prepend(svg);
      const move = ev => {
        const r = svg.getBoundingClientRect(), px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
        const i = Math.max(0, Math.min(n - 1, Math.floor((px - pL) / slot)));
        svg.querySelectorAll('.cp-ch-b').forEach(b => b.setAttribute('opacity', +b.dataset.i === i ? 1 : 0.45));
        const rows = vis.slice().reverse().map(s => `<div><span style="background:${s.color}"></span>${esc(s.name)} <b>${esc(fmt(s.values[from + i] || 0))}</b></div>`).join('');
        tipAt(plot, tip, cx(i), `<div class="cp-ch-tip-t">${esc(L[i])}</div>${rows}<div class="cp-ch-tip-note">Total ${esc(fmt(totals[i]))}</div>`);
      };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', () => { tip.hidden = true; svg.querySelectorAll('.cp-ch-b').forEach(b => b.setAttribute('opacity', 1)); });
    }
    const redraw = observe(plot, draw);
    body.querySelectorAll('.cp-ch-key').forEach(k => k.onclick = () => {
      const i = +k.dataset.i;
      if (hidden.has(i)) hidden.delete(i); else if (hidden.size < series.length - 1) hidden.add(i);
      k.classList.toggle('off', hidden.has(i)); redraw();
    });
    body.querySelectorAll('.cp-ch-ranges button').forEach(bt => bt.onclick = () => {
      range = +bt.dataset.r; body.querySelectorAll('.cp-ch-ranges button').forEach(o => o.classList.toggle('on', o === bt)); redraw();
    });
  }

  function donut(body, parts) {
    const R = 54, r = 36, cx = 70, cy = 70;
    let a0 = -Math.PI / 2, arcs = '';
    const total = parts.reduce((s, p) => s + p.value, 0) || 1;
    parts.forEach((p, i) => {
      const a1 = a0 + p.value / total * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      if (p.value > 0) arcs += p.value >= total
        ? `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${p.color}" stroke-width="${R - r}" class="cp-ch-arc" data-i="${i}"/>`
        : `<path class="cp-ch-arc" data-i="${i}" d="M${pt(R, a0)} A${R},${R} 0 ${big} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${big} 0 ${pt(r, a0)}Z" fill="${p.color}"/>`;
      a0 = a1;
    });
    body.innerHTML = `<div class="cp-donut"><svg viewBox="0 0 140 140" width="140" height="140">${arcs}
        <text x="70" y="68" text-anchor="middle" class="cp-donut-v">${Math.round(parts[0].value)}%</text>
        <text x="70" y="86" text-anchor="middle" class="cp-donut-l">${esc(parts[0].label)}</text></svg>
      <div class="cp-donut-legend">${parts.map((p, i) => `<div data-i="${i}"><span style="background:${p.color}"></span>${esc(p.label)} <b>${Math.round(p.value)}%</b></div>`).join('')}</div></div>`;
    const v = body.querySelector('.cp-donut-v'), l = body.querySelector('.cp-donut-l');
    const focus = i => { v.textContent = Math.round(parts[i].value) + '%'; l.textContent = parts[i].label;
      body.querySelectorAll('.cp-ch-arc').forEach(a => a.setAttribute('opacity', +a.dataset.i === i ? 1 : 0.35)); };
    body.querySelectorAll('[data-i]').forEach(e => { e.addEventListener('pointerenter', () => focus(+e.dataset.i)); e.addEventListener('pointerdown', () => focus(+e.dataset.i)); });
    body.querySelector('.cp-donut').addEventListener('pointerleave', () => { focus(0); body.querySelectorAll('.cp-ch-arc').forEach(a => a.setAttribute('opacity', 1)); });
  }

  function timeline(body) {
    const p = P(), s = _date(p.contract_start), e = _date(p.contract_end), now = new Date();
    const pct = Math.min(100, Math.max(0, (now - s) / (e - s) * 100));
    const years = [];
    for (let yr = s.getFullYear() + 1; yr <= e.getFullYear(); yr++) { const d = new Date(yr, 0, 1); if (d > s && d < e) years.push([yr, (d - s) / (e - s) * 100]); }
    body.innerHTML = `<div class="cp-tl">
        <div class="cp-tl-top"><div><div class="cp-tl-big">${pct.toFixed(0)}%</div><div class="cp-tl-cap">of term elapsed</div></div>
          <div style="text-align:right"><div class="cp-tl-big">${monthsLeft()} <small>mo.</small></div><div class="cp-tl-cap">remaining</div></div></div>
        <div class="cp-tl-track"><div class="cp-tl-fill" style="width:${pct}%"></div>
          ${years.map(([yr, x]) => `<span class="cp-tl-year" style="left:${x}%"><i></i>${yr}</span>`).join('')}
          <span class="cp-tl-now" style="left:${pct}%" title="Today"></span></div>
        <div class="cp-tl-dates"><span>${esc(_fmtDate(p.contract_start))}</span><span>${esc(_fmtDate(p.contract_end))}</span></div>
        ${p.renewal_note ? `<div class="cp-tl-note">${esc(p.renewal_note)}</div>` : ''}</div>`;
  }

  /* ── Boards ───────────────────────────────────── */
  const layouts = {};
  const uid = () => Math.random().toString(36).slice(2, 10);
  const key = b => 'sp_board_v2_' + (MY_ID || 'anon') + '_' + b;
  function load(b) {
    try {
      const v = JSON.parse(localStorage.getItem(key(b)));
      if (Array.isArray(v)) return v.filter(w => CATALOG[w.type] && offered(w.type) && CATALOG[w.type].sizes.includes(w.size));
    } catch {}
    return defaults(b).filter(([t]) => CATALOG[t].ready()).map(([type, size]) => ({ id: uid(), type, size }));
  }
  const save = b => { try { localStorage.setItem(key(b), JSON.stringify(layouts[b])); } catch {} };

  const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
  let dragId = null;

  function widgetEl(b, w) {
    const def = CATALOG[w.type];
    const el = document.createElement('div');
    el.className = `cp-widget cp-w-${w.size}${w.type.startsWith('kpi_') ? ' cp-widget--kpi' : ''}`;
    el.dataset.id = w.id;
    el.innerHTML = `<div class="cp-widget-head">
        <span class="cp-widget-grip" title="Drag to move">${GRIP}</span>
        <div class="cp-widget-title">${esc(titleOf(w.type))}</div>
        <button class="cp-widget-btn" aria-label="Widget options">⋯</button></div>
      <div class="cp-widget-body"></div>`;
    const body = el.querySelector('.cp-widget-body');
    try {
      if (def.ready()) def.render(body, w);
      else body.innerHTML = `<div class="cp-widget-empty">Available once your advisor adds ${esc(def.need)}.</div>`;
    } catch { body.innerHTML = '<div class="cp-widget-empty">This widget could not be displayed.</div>'; }
    el.querySelector('.cp-widget-btn').onclick = ev => { ev.stopPropagation(); openMenu(b, w, ev.currentTarget); };
    // Drag to reorder (desktop): only from the grip
    const grip = el.querySelector('.cp-widget-grip');
    grip.addEventListener('pointerdown', () => { el.draggable = true; });
    el.addEventListener('dragstart', ev => { dragId = w.id; el.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', w.id); } catch {} });
    el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); dragId = null; save(b); });
    el.addEventListener('dragover', ev => {
      if (!dragId || dragId === w.id) return;
      ev.preventDefault();
      const list = layouts[b], from = list.findIndex(x => x.id === dragId), to = list.findIndex(x => x.id === w.id);
      if (from < 0 || to < 0) return;
      const host = el.parentNode, dragged = host.querySelector(`[data-id="${dragId}"]`);
      list.splice(to, 0, list.splice(from, 1)[0]);
      if (from < to) el.after(dragged); else el.before(dragged);
    });
    return el;
  }

  function addTile(b) {
    const t = document.createElement('button');
    t.className = 'cp-widget-add';
    t.innerHTML = '<span>+</span>Add widget';
    t.onclick = () => openGallery(b);
    return t;
  }

  function render(b) {
    const host = document.getElementById('board-' + b);
    if (!host || !ME) return;
    if (!layouts[b]) layouts[b] = load(b);
    host.innerHTML = '';
    layouts[b].forEach(w => host.appendChild(widgetEl(b, w)));
    host.appendChild(addTile(b));
  }
  const renderAll = () => BOARDS.forEach(render);

  /* ── Widget menu ──────────────────────────────── */
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); closeGallery(); } });
  function openMenu(b, w, btn) {
    closeMenu();
    const list = layouts[b], i = list.findIndex(x => x.id === w.id), def = CATALOG[w.type];
    menuEl = document.createElement('div');
    menuEl.className = 'cp-wmenu';
    menuEl.innerHTML = `<div class="cp-wmenu-h">Size</div>
      ${def.sizes.map(s => `<button data-a="size" data-v="${s}" class="${s === w.size ? 'on' : ''}">${SIZE_NAMES[s]}</button>`).join('')}
      <div class="cp-wmenu-sep"></div>
      <button data-a="up" ${i === 0 ? 'disabled' : ''}>Move earlier</button>
      <button data-a="down" ${i === list.length - 1 ? 'disabled' : ''}>Move later</button>
      <div class="cp-wmenu-sep"></div>
      <button data-a="remove" class="danger">Remove widget</button>`;
    document.body.appendChild(menuEl);
    const r = btn.getBoundingClientRect(), mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
    menuEl.style.top = (r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
    menuEl.addEventListener('click', ev => {
      ev.stopPropagation();
      const a = ev.target.closest('button'); if (!a || a.disabled) return;
      if (a.dataset.a === 'size') w.size = a.dataset.v;
      if (a.dataset.a === 'up') list.splice(i - 1, 0, list.splice(i, 1)[0]);
      if (a.dataset.a === 'down') list.splice(i + 1, 0, list.splice(i, 1)[0]);
      if (a.dataset.a === 'remove') list.splice(i, 1);
      save(b); closeMenu(); render(b);
    });
  }

  /* ── Gallery ("+") ────────────────────────────── */
  let galleryBoard = null;
  function openGallery(b) {
    galleryBoard = b;
    const g = document.getElementById('cp-gallery');
    const used = new Set(layouts[b].map(w => w.type));
    document.getElementById('cp-gallery-list').innerHTML = CATS.map(cat => {
      const items = Object.entries(CATALOG).filter(([t, d]) => d.cat === cat && offered(t));
      if (!items.length) return '';
      return `<div class="cp-gal-cat">${cat}</div><div class="cp-gal-grid">${items.map(([t, d]) => {
        const ready = d.ready(), added = used.has(t);
        return `<button class="cp-gal-item" data-t="${t}" ${!ready || added ? 'disabled' : ''}>
          <span class="cp-gal-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON[d.icon]}</svg></span>
          <span class="cp-gal-txt"><b>${esc(titleOf(t))}</b><span>${esc(d.desc)}</span>
          ${added ? '<em class="ok">Added</em>' : !ready ? `<em>Needs ${esc(d.need)}</em>` : ''}</span></button>`;
      }).join('')}</div>`;
    }).join('');
    document.querySelectorAll('#cp-gallery-list .cp-gal-item').forEach(it => it.onclick = () => add(galleryBoard, it.dataset.t));
    g.removeAttribute('hidden');
  }
  function closeGallery() { const g = document.getElementById('cp-gallery'); if (g) g.setAttribute('hidden', ''); }
  function add(b, type) {
    const def = CATALOG[type];
    // Charts start wide; everything else at its smallest size
    const w = { id: uid(), type, size: def.cat === 'Charts' && def.sizes.includes('w') ? 'w' : def.sizes[0] };
    layouts[b].push(w); save(b); closeGallery(); render(b);
    const el = document.querySelector(`#board-${b} [data-id="${w.id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('cp-widget-new'); }
  }
  function reset(b) {
    if (!confirm('Restore the default layout for this page?')) return;
    try { localStorage.removeItem(key(b)); } catch {}
    delete layouts[b]; render(b);
  }

  return { renderAll, render, openGallery, closeGallery, reset, charts: { lineChart, barChart, stackedChart } };
})();
