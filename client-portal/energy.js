/* ── Sentinels Client Portal · energy data helpers ───────────────────
   Plain, exact calculations over the plants (sites), monthly bills and
   contracts the advisor loads in the admin panel. Used by the boards,
   the My Sites page, the alerts and Sentinel One — so every number the
   client sees comes from one place.  Uses the global ME (index.html). */
const Energy = (() => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Plants, bills and contracts only exist for supply clients (traders and guests never see them)
  const supply = () => typeof Profiles === 'undefined' || Profiles.isSupply();
  const allSites = () => (supply() && typeof ME !== 'undefined' && ME && ME.sites) || [];
  // The Dashboard can narrow every calculation to some plants (withScope); My Sites and Sentinel One see all
  let scope = null;
  const sites = () => scope ? allSites().filter(s => scope.includes(s.id)) : allSites();
  function withScope(ids, fn) {
    const prev = scope; scope = ids && ids.length ? ids : null;
    try { return fn(); } finally { scope = prev; }
  }
  const contracts = () => (supply() && typeof ME !== 'undefined' && ME && ME.contracts) || [];
  const kwh = b => b.kwh_total || ((b.kwh_base || 0) + (b.kwh_int || 0) + (b.kwh_peak || 0)) || 0;
  const label = m => { const [y, mo] = String(m).split('-'); return MONTHS[+mo - 1] + ' ' + String(y).slice(2); };
  // Supply type: CFE Basic Service Supplier (default) or Qualified Supply. Older
  // profiles without supply_type count as Qualified when they hold manual contract data.
  const QUALIFIED_KEYS = ['rate', 'cfe_rate', 'savings_monthly', 'ytd_gwh', 'contract_id', 'contract_start', 'contract_end', 'counterparty', 'volume_gwh', 'base_price'];
  function isQualified() {
    if (!supply()) return false;
    const p = (typeof ME !== 'undefined' && ME && ME.profile) || {};
    if (p.supply_type) return p.supply_type === 'qualified';
    return QUALIFIED_KEYS.some(k => p[k] != null && p[k] !== '');
  }
  // Unit costs exclude IVA: use the captured subtotal, else total − IVA, else estimate it with
  // the plant's IVA rate (16% general, 8% in the northern/southern border region)
  const siteOf = b => allSites().find(s => b.site ? s.id === b.site : (s.bills || []).includes(b));
  const ivaRateOf = b => { const s = siteOf(b); return s && s.iva_rate != null ? s.iva_rate : 16; };
  const ivaKnown = b => b.subtotal_mxn != null || b.iva_mxn != null;
  function subtotalOf(b) {
    if (b.subtotal_mxn != null) return b.subtotal_mxn;
    if (b.total_mxn == null) return null;
    return b.iva_mxn != null ? b.total_mxn - b.iva_mxn : b.total_mxn / (1 + ivaRateOf(b) / 100);
  }
  const ivaOf = b => b.iva_mxn != null ? b.iva_mxn : (b.total_mxn != null && subtotalOf(b) != null ? b.total_mxn - subtotalOf(b) : null);
  const costKwhOf = b => b && kwh(b) && subtotalOf(b) != null ? subtotalOf(b) / kwh(b) : null;
  // Savings versus CFE only make sense when the client is not supplied by CFE
  const savingsOf = b => (isQualified() && b.ref_cfe_mxn != null && b.total_mxn != null) ? b.ref_cfe_mxn - b.total_mxn : null;

  const allBills = () => sites().flatMap(s => (s.bills || []).map(b => ({ ...b, site: s.id, siteName: s.name })));
  const hasBills = () => allBills().length > 0;
  const hasRef = () => isQualified() && allBills().some(b => b.ref_cfe_mxn != null);
  const hasPeriods = () => allBills().some(b => b.kwh_base != null || b.kwh_int != null || b.kwh_peak != null);

  // One row per month, summed across plants
  function monthly() {
    const by = {};
    for (const b of allBills()) {
      const r = by[b.month] = by[b.month] || { month: b.month, label: label(b.month), kwh: 0, base: 0, int: 0, peak: 0, total: 0, subtotal: 0, ivaEstimated: false, ref: 0, refKnown: true, sites: 0 };
      r.kwh += kwh(b); r.base += b.kwh_base || 0; r.int += b.kwh_int || 0; r.peak += b.kwh_peak || 0;
      r.total += b.total_mxn || 0; r.subtotal += subtotalOf(b) || 0; r.sites++;
      if (!ivaKnown(b)) r.ivaEstimated = true;
      if (!isQualified() || b.ref_cfe_mxn == null) r.refKnown = false; else r.ref += b.ref_cfe_mxn;
    }
    return Object.values(by).sort((a, b) => a.month.localeCompare(b.month)).map(r => ({
      ...r, costKwh: r.kwh ? r.subtotal / r.kwh : null, savings: r.refKnown ? r.ref - r.total : null,
      savingsPct: r.refKnown && r.ref ? (r.ref - r.total) / r.ref * 100 : null
    }));
  }
  const latestMonth = () => { const m = monthly(); return m.length ? m[m.length - 1] : null; };

  // Per-plant monthly rows over a shared month axis, for comparison charts (null where a plant has no bill)
  function bySite() {
    const months = [...new Set(allBills().map(b => b.month))].sort();
    return {
      months, labels: months.map(label),
      sites: sites().map(s => {
        const by = Object.fromEntries((s.bills || []).map(b => [b.month, b]));
        const pick = f => months.map(m => by[m] ? f(by[m]) : null);
        return { id: s.id, name: s.name, kwh: pick(kwh), base: pick(b => b.kwh_base || 0), int: pick(b => b.kwh_int || 0), peak: pick(b => b.kwh_peak || 0), costKwh: pick(costKwhOf) };
      })
    };
  }

  // Year-to-date consumption and spend from the bills (all plants); defaults to the latest bill's year
  function ytd(year) {
    const m = monthly();
    year = year || (m.length ? m[m.length - 1].month.slice(0, 4) : String(new Date().getFullYear()));
    const rows = m.filter(r => r.month.startsWith(year));
    return { year, kwh: rows.reduce((s, r) => s + r.kwh, 0), total: rows.reduce((s, r) => s + r.total, 0), months: rows.length,
      from: rows.length ? rows[0].label : null, to: rows.length ? rows[rows.length - 1].label : null };
  }

  function savingsYTD(year = String(new Date().getFullYear())) {
    const rows = allBills().filter(b => b.month.startsWith(year) && savingsOf(b) != null);
    const ref = rows.reduce((s, b) => s + b.ref_cfe_mxn, 0), saved = rows.reduce((s, b) => s + savingsOf(b), 0);
    return { year, saved, pct: ref ? saved / ref * 100 : null, months: new Set(rows.map(b => b.month)).size };
  }

  // Latest bill of each plant, with derived ratios
  function siteSummary() {
    return sites().map(s => {
      const bills = (s.bills || []).slice().sort((a, b) => a.month.localeCompare(b.month));
      const last = bills[bills.length - 1] || null, prev = bills[bills.length - 2] || null;
      return {
        id: s.id, name: s.name, city: s.city, tariff: s.tariff, rpu: s.rpu, contracted_kw: s.contracted_kw, iva_rate: s.iva_rate != null ? s.iva_rate : 16, bills, last,
        costKwh: costKwhOf(last), costKwhPrev: costKwhOf(prev),
        demandPct: last && last.demand_kw && s.contracted_kw ? last.demand_kw / s.contracted_kw * 100 : null
      };
    });
  }

  // Alerts computed from the data — no AI involved, no cost
  function alerts() {
    const out = [], today = new Date();
    const latest = latestMonth();
    for (const s of siteSummary()) {
      const b = s.last;
      if (!b) continue;
      if (b.pf != null && b.pf < 0.9) out.push({ level: 'warn', site: s.name, text: `${s.name}: power factor ${b.pf.toFixed(2)} in ${label(b.month)} is below 0.90 (CFE penalty threshold).` });
      if (s.demandPct != null && s.demandPct >= 95) out.push({ level: s.demandPct > 100 ? 'warn' : 'info', site: s.name, text: `${s.name}: peak demand reached ${s.demandPct.toFixed(0)}% of the contracted ${Math.round(s.contracted_kw).toLocaleString('en-US')} kW in ${label(b.month)}.` });
      if (s.costKwh != null && s.costKwhPrev && s.costKwh > s.costKwhPrev * 1.1) out.push({ level: 'info', site: s.name, text: `${s.name}: cost per kWh rose ${((s.costKwh / s.costKwhPrev - 1) * 100).toFixed(0)}% versus the previous bill (${s.costKwh.toFixed(2)} MXN/kWh before IVA).` });
      if (latest && b.month < latest.month) out.push({ level: 'info', site: s.name, text: `${s.name}: the ${label(latest.month)} bill has not been loaded yet.` });
    }
    for (const c of contracts()) {
      if (!c.end) continue;
      const days = Math.round((new Date(c.end + 'T00:00:00') - today) / 864e5);
      if (days >= 0 && days <= 365) out.push({ level: days <= 180 ? 'warn' : 'info', text: `${c.name || c.type} with ${c.counterparty} ends on ${c.end} (${Math.round(days / 30.4)} months).` });
    }
    return out;
  }

  // Plain-text version for Sentinel One's context
  function toText() {
    const L = [];
    const n = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
    for (const s of siteSummary()) {
      L.push(`### Plant: ${s.name}${s.city ? ' (' + s.city + ')' : ''} — tariff ${s.tariff || '—'}, RPU ${s.rpu || '—'}, contracted demand ${n(s.contracted_kw)} kW, IVA ${s.iva_rate}%${s.iva_rate === 8 ? ' (border region)' : ''}`);
      L.push('Month | kWh base | kWh intermediate | kWh peak | kWh total | Max demand kW | Power factor | Energy MXN | Demand MXN | Other MXN | Subtotal before IVA MXN | IVA MXN | Total paid MXN | CFE equivalent MXN | Real savings MXN | Cost MXN/kWh before IVA | Supplier');
      for (const b of s.bills) L.push([b.month, n(b.kwh_base), n(b.kwh_int), n(b.kwh_peak), n(kwh(b)), n(b.demand_kw), b.pf != null ? String(b.pf) : '—',
        n(b.energy_mxn), n(b.demand_mxn), n(b.other_mxn), (ivaKnown(b) ? '' : '~') + n(subtotalOf(b)), (ivaKnown(b) ? '' : '~') + n(ivaOf(b)), n(b.total_mxn), n(b.ref_cfe_mxn), n(savingsOf(b)),
        costKwhOf(b) != null ? costKwhOf(b).toFixed(3) : '—', b.supplier || '—'].join(' | '));
      L.push('');
    }
    const m = monthly();
    if (m.length > 1 || sites().length > 1) {
      L.push('### All plants combined (computed by the portal)', 'Month | kWh total | Subtotal before IVA MXN | Total paid MXN | CFE equivalent MXN | Real savings MXN | Savings % | Cost MXN/kWh before IVA');
      for (const r of m) L.push([r.month, n(r.kwh), (r.ivaEstimated ? '~' : '') + n(r.subtotal), n(r.total), r.refKnown ? n(r.ref) : '—', n(r.savings), r.savingsPct != null ? r.savingsPct.toFixed(1) + '%' : '—', r.costKwh != null ? r.costKwh.toFixed(3) : '—'].join(' | '));
      L.push('');
    }
    if (allBills().some(b => !ivaKnown(b))) L.push('Note: costs per kWh exclude IVA. Values marked ~ are estimated with the plant\'s IVA rate because the bill breakdown was not captured.', '');
    const y = savingsYTD();
    if (y.months) L.push(`Real savings year to date ${y.year} (computed): ${n(y.saved)} MXN (${y.pct != null ? y.pct.toFixed(1) : '—'}% below CFE) over ${y.months} month(s).`, '');
    if (contracts().length) {
      const names = Object.fromEntries(sites().map(s => [s.id, s.name]));
      L.push('### Contracts');
      for (const c of contracts()) L.push(`- ${c.name || c.type} | type ${c.type} | counterparty ${c.counterparty}${c.technology ? ' (' + c.technology + ')' : ''} | ${c.start || '?'} to ${c.end || '?'} | volume ${n(c.volume_gwh, 2)} GWh/year | price ${c.price_mxn_kwh != null ? c.price_mxn_kwh + ' MXN/kWh' : '—'} | escalation ${c.escalation || '—'} | fixed-price share ${c.fixed_pct != null ? c.fixed_pct + '%' : '—'} | plants: ${(c.sites || []).map(id => names[id]).filter(Boolean).join(', ') || 'all'}${c.notes ? ' | notes: ' + c.notes : ''}`);
      L.push('');
    }
    const a = alerts();
    if (a.length) L.push('### Current alerts (computed by the portal)', ...a.map(x => '- ' + x.text), '');
    return L.join('\n');
  }

  return { sites, allSites, withScope, bySite, contracts, kwh, label, isQualified, subtotalOf, ivaOf, ivaKnown, ivaRateOf, costKwhOf, savingsOf, allBills, hasBills, hasRef, hasPeriods, monthly, latestMonth, ytd, savingsYTD, siteSummary, alerts, toText };
})();
