/* ── Sentinels Client Portal · My Sites page ─────────────────────────
   One view per plant: its latest bill in figures, consumption by period
   (interactive chart) and every monthly bill with a preview of its PDF.
   Uses Energy (energy.js), Board.charts (board.js) and globals from
   index.html: ME, _esc, viewDoc. */
const SitesPage = (() => {
  let sel = null;
  const fx = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = v => v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US');

  function init() {
    const nav = document.querySelector('.cp-nav-item[data-section="sites"]');
    if (nav) nav.style.display = Energy.sites().length ? '' : 'none';
  }

  function kpiCard(eyebrow, value, unit, note, tone = 'neutral') {
    return `<div class="cp-kpi-card"><div class="cp-kpi-eyebrow">${_esc(eyebrow)}</div>
      <div class="cp-kpi-value">${_esc(value)}${unit ? `<span class="cp-kpi-unit">${_esc(unit)}</span>` : ''}</div>
      <div class="cp-kpi-delta cp-kpi-delta--${tone}">${_esc(note || '')}</div></div>`;
  }

  function render() {
    const host = document.getElementById('sites-root');
    if (!host || !ME) return;
    const list = Energy.siteSummary();
    if (!list.length) { host.innerHTML = '<div class="cp-card" style="padding:24px"><div class="cp-empty">Your advisor has not loaded plant data yet.</div></div>'; return; }
    if (!sel || !list.some(s => s.id === sel)) sel = list[0].id;
    const s = list.find(x => x.id === sel), b = s.last;
    const bills = s.bills.slice().reverse();
    const info = [s.city, s.tariff ? 'Tariff ' + s.tariff : '', s.rpu ? 'RPU ' + s.rpu : '', s.contracted_kw ? 'Contracted ' + fx(s.contracted_kw) + ' kW' : ''].filter(Boolean).join(' · ');
    const d = s.costKwh != null && s.costKwhPrev ? (s.costKwh / s.costKwhPrev - 1) * 100 : null;
    const saved = b ? Energy.savingsOf(b) : null;
    const q = Energy.isQualified();  // CFE equivalent / savings columns only for Qualified Supply

    host.innerHTML = `
      ${list.length > 1 ? `<div class="cp-doc-filters">${list.map(x => `<button class="cp-doc-filter ${x.id === sel ? 'active' : ''}" data-site="${x.id}">${_esc(x.name)}</button>`).join('')}</div>` : ''}
      <div class="cp-card cp-site-head"><div class="cp-contract-title" style="margin:0">${_esc(s.name)}</div><div class="cp-contract-period">${_esc(info)}</div></div>
      ${b ? `<div class="cp-kpi-grid">
        ${kpiCard('Latest bill · ' + Energy.label(b.month), money(b.total_mxn), 'MXN', saved != null ? `${money(saved)} saved vs CFE` : (b.supplier || ''), saved != null ? 'pos' : 'neutral')}
        ${kpiCard('Consumption', fx(Energy.kwh(b) / 1e6, 2), 'GWh', b.demand_kw ? `Max demand ${fx(b.demand_kw)} kW${s.demandPct != null ? ` (${fx(s.demandPct)}%)` : ''}` : '', s.demandPct != null && s.demandPct >= 95 ? 'notice' : 'neutral')}
        ${kpiCard('Cost per kWh', fx(s.costKwh, 2), 'MXN/kWh', d != null ? `${d >= 0 ? '↑' : '↓'} ${fx(Math.abs(d), 1)}% vs previous bill` : '', d != null && d > 0 ? 'notice' : 'neutral')}
        ${kpiCard('Power factor', b.pf != null ? fx(b.pf, 2) : '—', '', b.pf == null ? '' : b.pf < 0.9 ? 'Below 0.90 — CFE penalty' : 'Above 0.90 threshold', b.pf != null && b.pf < 0.9 ? 'notice' : 'pos')}
      </div>` : ''}
      <div class="cp-card cp-chart-card" style="margin-bottom:20px">
        <div class="cp-card-title" style="margin-bottom:6px">${s.bills.some(x => x.kwh_base != null || x.kwh_int != null || x.kwh_peak != null) ? 'Consumption by period' : 'Monthly consumption'}</div>
        <div id="site-chart"></div>
      </div>
      <div class="cp-card" style="padding:0">
        <div class="cp-card-head" style="padding:20px 20px 0"><div><div class="cp-card-title">Monthly bills</div><div class="cp-card-sub">${bills.length} bill${bills.length === 1 ? '' : 's'}</div></div></div>
        <div class="s1-table" style="margin:0 0 4px;padding:0 20px 16px"><table class="cp-mini-table">
          <thead><tr><th>Month</th><th>kWh</th><th>Base / Int. / Peak</th><th>Demand kW</th><th>PF</th><th>Total MXN</th>${q ? '<th>CFE equiv.</th><th>Savings</th>' : ''}<th></th></tr></thead>
          <tbody>${bills.map(x => {
            const sv = Energy.savingsOf(x), docIdx = x.doc ? (ME.docs || []).findIndex(dd => dd.file === x.doc) : -1;
            return `<tr><td>${_esc(Energy.label(x.month))}</td><td>${fx(Energy.kwh(x))}</td>
              <td>${x.kwh_base != null || x.kwh_int != null || x.kwh_peak != null ? `${fx(x.kwh_base)} / ${fx(x.kwh_int)} / ${fx(x.kwh_peak)}` : '—'}</td>
              <td>${fx(x.demand_kw)}</td><td class="${x.pf != null && x.pf < 0.9 ? 'cp-bad' : ''}">${x.pf != null ? fx(x.pf, 2) : '—'}</td>
              <td>${money(x.total_mxn)}</td>${q ? `<td>${money(x.ref_cfe_mxn)}</td><td class="${sv != null && sv > 0 ? 'cp-good' : ''}">${money(sv)}</td>` : ''}
              <td>${docIdx >= 0 ? `<button class="cp-read-btn" onclick="viewDoc(${docIdx})" title="Preview the bill (download it from Documents)">View PDF</button>` : ''}</td></tr>`;
          }).join('')}</tbody></table></div>
      </div>`;

    host.querySelectorAll('[data-site]').forEach(btn => btn.onclick = () => { sel = btn.dataset.site; render(); });
    const el = document.getElementById('site-chart');
    const rows = s.bills;
    if (rows.length) {
      if (rows.some(x => x.kwh_base != null || x.kwh_int != null || x.kwh_peak != null)) Board.charts.stackedChart(el, { labels: rows.map(x => Energy.label(x.month)), series: [
        { name: 'Base', color: '#B4BBC2', values: rows.map(x => x.kwh_base || 0) }, { name: 'Intermediate', color: '#646C75', values: rows.map(x => x.kwh_int || 0) }, { name: 'Peak', color: '#0B0D0F', values: rows.map(x => x.kwh_peak || 0) }],
        fmt: v => fx(v / 1e6, 2) + ' GWh', axis: v => fx(v / 1e6, 1) });
      else Board.charts.barChart(el, { labels: rows.map(x => Energy.label(x.month)), values: rows.map(x => Energy.kwh(x)), color: '#0B0D0F', fmt: v => fx(v / 1e6, 2) + ' GWh', axis: v => fx(v / 1e6, 1) });
    } else el.innerHTML = '<div class="cp-empty">No bills loaded for this plant yet.</div>';
  }

  return { init, render };
})();
