/* ── Panel admin · plantas, recibos y contratos ──────────────────────
   Todo vive dentro del vault cifrado del cliente (CUR.data):
     sites:     [{ id, name, city, rpu, tariff, contracted_kw, iva_rate,
                   bills: [{ month: 'YYYY-MM', supplier, kwh_base, kwh_int, kwh_peak,
                             kwh_total, demand_kw, pf, energy_mxn, demand_mxn, other_mxn,
                             subtotal_mxn, iva_mxn, total_mxn, ref_cfe_mxn, doc }] }]
     El costo por kWh del portal usa el subtotal sin IVA (o total − IVA; si
     no hay desglose, lo estima con el IVA de la planta: iva_rate 16 u 8 en frontera).
     contracts: [{ id, type, name, counterparty, technology, start, end, volume_gwh,
                   price_mxn_kwh, escalation, fixed_pct, sites: [siteId], notes }]
   El PDF de cada recibo se guarda como documento tipo "bill" (cifrado con la
   llave de documentos del cliente) y el recibo apunta a él con `doc`.
   Usa globales de admin.html: CUR, $, esc, today, fmtSize, busy, msg,
   writeVault, publish, writeFile, readFile, removeFile, SP, AI, MAX_UPLOAD. */
const Sites = (() => {
  let sel = null;
  const TARIFFS = ['GDMTH', 'GDMTO', 'DIST', 'DIT', 'GDBT', 'PDBT', 'RABT', 'Suministro calificado', 'Otra'];
  const CONTRACT_TYPES = ['PPA', 'Suministro calificado', 'Cobertura financiera', 'Otro'];
  const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  // [key, label, type]
  const BILL_FIELDS = [
    ['kwh_base', 'kWh base', 'number'], ['kwh_int', 'kWh intermedia', 'number'], ['kwh_peak', 'kWh punta', 'number'],
    ['kwh_total', 'kWh total (si el recibo no separa periodos)', 'number'],
    ['demand_kw', 'Demanda máxima (kW)', 'number'], ['pf', 'Factor de potencia (0–1, ej. 0.95)', 'number'],
    ['energy_mxn', 'Cargo por energía (MXN)', 'number'], ['demand_mxn', 'Cargo por demanda / capacidad (MXN)', 'number'],
    ['other_mxn', 'Otros cargos (MXN)', 'number'],
    ['subtotal_mxn', 'Subtotal sin IVA (MXN)', 'number'], ['iva_mxn', 'IVA (MXN)', 'number'], ['total_mxn', 'Total pagado (MXN) *', 'number'],
    ['ref_cfe_mxn', 'Costo equivalente con CFE (MXN) — para el ahorro real', 'number']
  ];

  // "Costo equivalente CFE" (real savings) only applies to Qualified Supply clients
  const billFields = () => BILL_FIELDS.filter(([k]) => k !== 'ref_cfe_mxn' || isQualifiedClient());
  const sites = () => (CUR.data.sites = CUR.data.sites || []);
  const contracts = () => (CUR.data.contracts = CUR.data.contracts || []);
  const site = () => sites().find(s => s.id === sel);
  const uid = () => SP.randomId().slice(0, 12);
  // IVA 16% general, 8% for plants in the border region (estímulo fiscal)
  const ivaRate = s => s.iva_rate != null ? s.iva_rate : 16;
  // The rate printed on a bill (or implied by its subtotal and IVA) sets the plant's rate
  function learnIvaRate(s, b) {
    let pct = b.iva_pct;
    if (pct == null && b.subtotal_mxn > 0 && b.iva_mxn != null) pct = b.iva_mxn / b.subtotal_mxn * 100;
    if (pct != null && Math.abs(pct - 8) < 1) s.iva_rate = 8;
    else if (pct != null && Math.abs(pct - 16) < 1) s.iva_rate = 16;
  }
  const kwhOf = b => b.kwh_total || ((b.kwh_base || 0) + (b.kwh_int || 0) + (b.kwh_peak || 0)) || 0;
  const fmtN = (v, d = 0) => v == null || v === '' ? '—' : Number(v).toLocaleString('es-MX', { maximumFractionDigits: d });
  const monthLabel = m => { const [y, mo] = String(m).split('-'); return MONTHS[+mo - 1] + ' ' + String(y).slice(2); };
  const save = async what => { await writeVault(); await publish(what); };

  /* ── Generic modal ───────────────────────────────── */
  function modal(html) {
    closeModal();
    const m = document.createElement('div');
    m.className = 'modal'; m.id = 'sx-modal';
    m.innerHTML = `<div class="card stack" style="max-width:720px">${html}</div>`;
    document.body.appendChild(m);
    return m;
  }
  function closeModal() { const m = $('sx-modal'); if (m) m.remove(); }

  /* ── Render ──────────────────────────────────────── */
  function render() { renderSites(); renderContracts(); }

  function renderSites() {
    const box = $('sites-panel'); if (!box) return;
    const list = sites();
    if (sel && !list.some(s => s.id === sel)) sel = null;
    if (!sel && list.length) sel = list[0].id;
    const s = site();
    box.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        ${list.map(x => `<button class="btn btn-sm ${x.id === sel ? 'btn-dark' : ''}" onclick="Sites.select('${x.id}')">${esc(x.name)}</button>`).join('')}
        <button class="btn btn-sm" onclick="Sites.editSite(null)">+ Agregar planta</button>
      </div>
      ${s ? siteDetail(s) : '<p class="muted small" style="margin:0">Agrega la primera planta o sitio del cliente para cargar sus recibos.</p>'}`;
  }

  function siteDetail(s) {
    const bills = (s.bills || []).slice().sort((a, b) => b.month.localeCompare(a.month));
    const info = [s.city, s.tariff, s.rpu ? 'RPU ' + s.rpu : '', s.contracted_kw ? 'Demanda contratada ' + fmtN(s.contracted_kw) + ' kW' : '', 'IVA ' + ivaRate(s) + '%' + (ivaRate(s) === 8 ? ' (frontera)' : '')].filter(Boolean).join(' · ');
    return `
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <div class="small muted">${esc(info) || 'Sin datos de la planta.'}</div>
        <div class="row"><button class="btn btn-sm" onclick="Sites.editSite('${s.id}')">Editar planta</button><button class="btn btn-sm btn-danger" onclick="Sites.deleteSite(this)">Eliminar planta</button></div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-sm" onclick="Sites.openImport()">Importar Excel/CSV</button>
        <label class="btn btn-sm" style="margin:0">Leer recibo PDF con IA<input type="file" accept="application/pdf,.pdf" hidden onchange="Sites.readPdf(this)"></label>
        <button class="btn btn-sm" onclick="Sites.editBill(null)">+ Captura manual</button>
        <span class="small muted" id="bill-status"></span>
      </div>
      <table><thead><tr><th>Mes</th><th>kWh base</th><th>kWh inter.</th><th>kWh punta</th><th>kWh total</th><th>Dem. kW</th><th>FP</th><th>Subtotal</th><th>IVA</th><th>Total MXN</th>${isQualifiedClient() ? "<th>Ref. CFE</th>" : ""}<th></th></tr></thead><tbody>
      ${bills.length ? bills.map(b => `<tr>
          <td class="mono small">${monthLabel(b.month)}</td><td class="mono small">${fmtN(b.kwh_base)}</td><td class="mono small">${fmtN(b.kwh_int)}</td>
          <td class="mono small">${fmtN(b.kwh_peak)}</td><td class="mono small">${fmtN(kwhOf(b))}</td><td class="mono small">${fmtN(b.demand_kw)}</td>
          <td class="mono small" style="${b.pf && b.pf < 0.9 ? 'color:var(--neg);font-weight:700' : ''}">${b.pf ? Number(b.pf).toFixed(2) : '—'}</td>
          <td class="mono small">${fmtN(b.subtotal_mxn)}</td><td class="mono small">${fmtN(b.iva_mxn)}</td>
          <td class="mono small">${fmtN(b.total_mxn)}</td>${isQualifiedClient() ? `<td class="mono small">${fmtN(b.ref_cfe_mxn)}</td>` : ""}
          <td style="text-align:right;white-space:nowrap">${b.doc ? `<button class="btn btn-sm" onclick="Sites.viewPdf('${b.month}')">PDF</button> ` : ''}${b.doc && b.subtotal_mxn == null && b.iva_mxn == null ? `<button class="btn btn-sm" title="Lee otra vez el PDF guardado para obtener subtotal e IVA" onclick="Sites.rereadBill('${b.month}', this)">Releer con IA</button> ` : ''}<button class="btn btn-sm" onclick="Sites.editBill('${b.month}')">Editar</button> <button class="btn btn-sm btn-danger" onclick="Sites.deleteBill('${b.month}', this)">Quitar</button></td>
        </tr>`).join('') : '<tr><td colspan="12" class="muted">Sin recibos todavía.</td></tr>'}
      </tbody></table>
      ${bills.some(b => b.subtotal_mxn == null && b.iva_mxn == null) ? `<p class="small muted" style="margin:6px 0 0">Los recibos sin subtotal o IVA usan un IVA estimado del ${ivaRate(s)}% para el costo por kWh. Captúralos o usa “Releer con IA”.</p>` : ''}`;
  }

  /* ── Sites ───────────────────────────────────────── */
  function editSite(id) {
    const s = id ? sites().find(x => x.id === id) : {};
    modal(`<h2>${id ? 'Editar planta' : 'Nueva planta'}</h2>
      <div class="grid">
        <div><label>Nombre *</label><input id="sx-name" value="${esc(s.name || '')}" placeholder="Planta Monterrey"></div>
        <div><label>Ciudad / estado</label><input id="sx-city" value="${esc(s.city || '')}" placeholder="Monterrey, N.L."></div>
        <div><label>RPU / número de servicio</label><input id="sx-rpu" value="${esc(s.rpu || '')}"></div>
        <div><label>Tarifa</label><select id="sx-tariff"><option value=""></option>${TARIFFS.map(t => `<option ${t === s.tariff ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label>Demanda contratada (kW)</label><input id="sx-kw" type="number" step="any" value="${esc(s.contracted_kw ?? '')}"></div>
        <div><label>IVA del recibo</label><select id="sx-iva"><option value="16">16% · general</option><option value="8" ${s.iva_rate === 8 ? 'selected' : ''}>8% · región fronteriza</option></select></div>
      </div>
      <div id="sx-msg"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Sites.closeModal()">Cancelar</button><button class="btn btn-dark" onclick="Sites.saveSite('${id || ''}', this)">Guardar</button></div>`);
  }
  async function saveSite(id, btn) {
    const name = $('sx-name').value.trim();
    if (!name) return msg('sx-msg', 'Escribe el nombre de la planta.');
    const kw = $('sx-kw').value.trim();
    const data = { name, city: $('sx-city').value.trim(), rpu: $('sx-rpu').value.trim(), tariff: $('sx-tariff').value, contracted_kw: kw === '' ? null : Number(kw), iva_rate: Number($('sx-iva').value) };
    await busy(btn, 'Guardando…', async () => {
      if (id) Object.assign(sites().find(x => x.id === id), data);
      else { const s = { id: uid(), ...data, bills: [] }; sites().push(s); sel = s.id; }
      await save('plantas');
      closeModal(); renderSites();
    });
  }
  async function deleteSite(btn) {
    const s = site();
    if (!confirm(`¿Eliminar la planta "${s.name}" con sus ${(s.bills || []).length} recibos? Esta acción no se puede deshacer.`)) return;
    await busy(btn, 'Eliminando…', async () => {
      for (const b of s.bills || []) if (b.doc) await dropDoc(b.doc);
      CUR.data.sites = sites().filter(x => x.id !== s.id);
      contracts().forEach(c => c.sites = (c.sites || []).filter(x => x !== s.id));
      sel = null;
      await save('plantas');
      renderEditor();
    });
  }

  /* ── Bills ───────────────────────────────────────── */
  let pendingPdf = null;  // { bytes, name, size } waiting to be attached to the bill being edited

  function editBill(month, prefill) {
    const s = site();
    const b = prefill || (month ? s.bills.find(x => x.month === month) : {}) || {};
    modal(`<h2>${month ? 'Editar recibo' : 'Recibo de ' + esc(s.name)}</h2>
      ${prefill ? '<div class="msg msg-notice small">Datos leídos por IA: revisa cada campo contra el recibo antes de guardar.</div>' : ''}
      <div class="grid">
        <div><label>Mes del recibo *</label><input id="bx-month" type="month" value="${esc(b.month || '')}" ${month ? 'disabled' : ''}></div>
        <div><label>Suministrador</label><input id="bx-supplier" value="${esc(b.supplier || 'CFE')}"></div>
        ${billFields().map(([k, label]) => `<div><label>${label}</label><input id="bx-${k}" type="number" step="any" value="${esc(b[k] ?? '')}"></div>`).join('')}
      </div>
      <div><label>PDF del recibo (opcional)</label>
        ${pendingPdf ? `<div class="small">📄 ${esc(pendingPdf.name)} · se adjuntará al guardar</div>` : `<input id="bx-pdf" type="file" accept="application/pdf,.pdf" style="height:auto;padding:6px">`}
        ${b.doc && !pendingPdf ? '<div class="small muted">Ya tiene PDF; si subes otro, lo reemplaza.</div>' : ''}</div>
      <div id="bx-msg"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Sites.cancelBill()">Cancelar</button><button class="btn btn-dark" onclick="Sites.saveBill('${month || ''}', this)">Guardar recibo</button></div>`);
  }
  function cancelBill() { pendingPdf = null; closeModal(); }

  async function saveBill(month, btn) {
    const s = site();
    const m = month || $('bx-month').value;
    if (!/^\d{4}-\d{2}$/.test(m)) return msg('bx-msg', 'Elige el mes del recibo.');
    const bill = { month: m, supplier: $('bx-supplier').value.trim() };
    const prev = s.bills.find(x => x.month === m) || {};
    for (const [k] of BILL_FIELDS) {
      const el = $('bx-' + k);
      if (!el) { bill[k] = prev[k] ?? null; continue; }  // field hidden for this client type
      const v = el.value.trim(); bill[k] = v === '' ? null : Number(v);
    }
    if (bill.total_mxn == null) return msg('bx-msg', 'Escribe el total pagado.');
    if (bill.pf != null && bill.pf > 1) bill.pf = +(bill.pf / 100).toFixed(4);  // 95 → 0.95
    if (!kwhOf(bill)) return msg('bx-msg', 'Escribe los kWh (por periodo o el total).');
    const existing = s.bills.find(x => x.month === m);
    if (!month && existing && !confirm(`Ya hay un recibo de ${monthLabel(m)}. ¿Reemplazarlo?`)) return;
    const fileInput = $('bx-pdf');
    let pdf = pendingPdf;
    if (!pdf && fileInput && fileInput.files[0]) { const f = fileInput.files[0]; pdf = { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, size: f.size }; }
    if (pdf && pdf.size > MAX_UPLOAD) return msg('bx-msg', 'El PDF es demasiado grande (máximo 95 MB).');
    learnIvaRate(s, bill);
    await busy(btn, 'Guardando…', async () => {
      bill.doc = existing ? existing.doc : null;
      if (pdf) {
        if (bill.doc) await dropDoc(bill.doc);
        bill.doc = await addBillDoc(s, m, pdf);
      }
      s.bills = s.bills.filter(x => x.month !== m).concat(bill);
      pendingPdf = null;
      await save('recibo');
      closeModal(); renderEditor();
    });
  }
  async function deleteBill(month, btn) {
    const s = site(), b = s.bills.find(x => x.month === month);
    if (!confirm(`¿Quitar el recibo de ${monthLabel(month)} de ${s.name}?`)) return;
    await busy(btn, '…', async () => {
      if (b.doc) await dropDoc(b.doc);
      s.bills = s.bills.filter(x => x.month !== month);
      await save('recibo');
      renderEditor();
    });
  }

  // The bill PDF is a regular encrypted client document of type "bill"
  async function addBillDoc(s, m, pdf) {
    const rid = SP.randomId() + '.bin';
    await writeFile('data/docs/' + rid, await SP.sealFile(CUR.docKey, pdf.bytes));
    CUR.data.docs = CUR.data.docs || [];
    CUR.data.docs.push({ file: rid, name: `Bill · ${s.name} · ${monthLabel(m)}`, filename: pdf.name, mime: 'application/pdf', type: 'bill', date: today(), size: fmtSize(pdf.size) });
    return rid;
  }
  async function dropDoc(file) {
    await removeFile('data/docs/' + file);
    CUR.data.docs = (CUR.data.docs || []).filter(d => d.file !== file);
  }
  async function viewPdf(month) {
    const b = site().bills.find(x => x.month === month);
    const bytes = await readFile('data/docs/' + b.doc, true);
    if (!bytes) return alert('No encontré el PDF cifrado.');
    window.open(URL.createObjectURL(new Blob([await SP.openFile(CUR.docKey, bytes)], { type: 'application/pdf' })), '_blank');
  }

  /* ── Read a bill PDF with AI (Sentinel One Worker) ─ */
  async function readPdf(input) {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    const status = $('bill-status');
    if (!AI.url || !AI.secret) { status.textContent = 'Primero configura Sentinel One (pestaña Sentinel One).'; return; }
    if (f.size > 15 * 1024 * 1024) { status.textContent = 'El PDF es muy grande para leerlo con IA (máximo 15 MB).'; return; }
    status.textContent = 'Leyendo el recibo con IA…';
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const x = await extract(bytes);
      pendingPdf = { bytes, name: f.name, size: f.size };
      status.textContent = '';
      editBill(null, { supplier: 'CFE', ...x });
    } catch (e) { status.textContent = e.message; }
  }
  async function extract(bytes) {
    const r = await fetch(AI.url + '/admin/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.secret },
      body: JSON.stringify({ pdf: SP.b64(bytes) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'No pude leer el recibo.');
    const x = j.bill || {};
    // Fill the plant's data the first time we see it
    const s = site();
    if (x.rpu && !s.rpu) s.rpu = String(x.rpu);
    if (x.tariff && !s.tariff) s.tariff = TARIFFS.includes(x.tariff) ? x.tariff : 'Otra';
    if (x.contracted_kw && !s.contracted_kw) s.contracted_kw = x.contracted_kw;
    if (x.pf != null && x.pf > 1) x.pf = +(x.pf / 100).toFixed(4);
    learnIvaRate(s, x);
    return x;
  }
  // Read a saved bill PDF again (e.g. to get subtotal and IVA) and open it for review
  async function rereadBill(month, btn) {
    const b = site().bills.find(x => x.month === month), status = $('bill-status');
    if (!AI.url || !AI.secret) { status.textContent = 'Primero configura Sentinel One (pestaña Sentinel One).'; return; }
    await busy(btn, 'Leyendo…', async () => {
      try {
        const enc = await readFile('data/docs/' + b.doc, true);
        if (!enc) throw new Error('No encontré el PDF cifrado.');
        const x = await extract(new Uint8Array(await SP.openFile(CUR.docKey, enc)));
        if (x.subtotal_mxn == null && x.iva_mxn == null) throw new Error('La IA no encontró subtotal ni IVA. Si acabas de actualizar el código, vuelve a pegar el Worker en Cloudflare; si no, captúralos con “Editar”.');
        status.textContent = '';
        // Keep what was already captured; only fill the gaps with what the AI read
        const merged = { ...b };
        for (const [k, v] of Object.entries(x)) if (v != null && merged[k] == null) merged[k] = v;
        editBill(month, merged);
      } catch (e) { status.textContent = e.message; }
    });
  }

  /* ── CSV / Excel import ──────────────────────────── */
  const COLS = {
    month: ['mes', 'month', 'periodo', 'period'], supplier: ['suministrador', 'supplier', 'proveedor'],
    kwh_base: ['kwh_base', 'base'], kwh_int: ['kwh_intermedia', 'intermedia', 'kwh_int', 'kwh_intermediate'], kwh_peak: ['kwh_punta', 'punta', 'kwh_peak'],
    kwh_total: ['kwh_total', 'consumo_kwh', 'total_kwh', 'kwh'], demand_kw: ['demanda_kw', 'demanda_maxima_kw', 'demanda', 'demand_kw'],
    pf: ['fp', 'factor_potencia', 'factor_de_potencia', 'power_factor', 'pf'], energy_mxn: ['cargo_energia', 'energia_mxn', 'energy_mxn'],
    demand_mxn: ['cargo_demanda', 'demanda_mxn', 'capacidad_mxn', 'demand_mxn'], other_mxn: ['otros_cargos', 'otros_mxn', 'other_mxn'],
    subtotal_mxn: ['subtotal', 'subtotal_mxn', 'subtotal_sin_iva', 'importe_sin_iva'], iva_mxn: ['iva', 'iva_mxn'],
    total_mxn: ['total_mxn', 'total_pagado', 'total', 'importe_total'], ref_cfe_mxn: ['ref_cfe_mxn', 'costo_cfe', 'referencia_cfe', 'ref_cfe']
  };
  const TEMPLATE = 'mes,suministrador,kwh_base,kwh_intermedia,kwh_punta,kwh_total,demanda_kw,fp,cargo_energia,cargo_demanda,otros_cargos,subtotal,iva,total_mxn,ref_cfe_mxn\n' +
    '2026-09,CFE,3100000,5420000,1210000,,14820,0.96,13100000,1640000,690000,15430000,2468800,17900000,20600000\n';
  const norm = h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const MONTH_NAMES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
  function parseMonth(v) {
    v = String(v || '').trim().toLowerCase();
    let m;
    if ((m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(v))) return fmtM(+m[1], +m[2]);
    if ((m = /^(?:\d{1,2}[-/.])?(\d{1,2})[-/.](\d{4})$/.exec(v))) return fmtM(+m[2], +m[1]);
    if ((m = /^([a-z]{3})[a-z]*[\s\-/.]*(\d{2,4})$/.exec(v)) && MONTH_NAMES[m[1]]) return fmtM(m[2].length === 2 ? 2000 + +m[2] : +m[2], MONTH_NAMES[m[1]]);
    return null;
  }
  const fmtM = (y, mo) => mo >= 1 && mo <= 12 && y > 1990 ? `${y}-${String(mo).padStart(2, '0')}` : null;
  function parseNum(v, delim) {
    let s = String(v == null ? '' : v).replace(/[$\s]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = /^-?\d{1,3}(,\d{3})+$/.test(s) && delim !== ';' ? s.replace(/,/g, '') : s.replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s) || (delim !== ',' && /^-?\d{1,3}\.\d{3}$/.test(s))) s = s.replace(/\./g, '');  // 3.010.000 / 15.100 as thousands
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function splitLine(line, d) {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === d && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(c => c.trim());
  }
  function parseCsv(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (lines.length < 2) return { error: 'Pega al menos el encabezado y una fila.' };
    const d = lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
    const head = splitLine(lines[0], d).map(norm);
    const idx = {};
    for (const [k, names] of Object.entries(COLS)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) idx[k] = i; }
    if (idx.month == null) return { error: 'No encontré la columna "mes". Usa la plantilla.' };
    if (idx.total_mxn == null) return { error: 'No encontré la columna "total_mxn". Usa la plantilla.' };
    const rows = lines.slice(1).map((l, n) => {
      const c = splitLine(l, d), bill = {}, errs = [];
      bill.month = parseMonth(c[idx.month]);
      if (!bill.month) errs.push('mes inválido');
      bill.supplier = idx.supplier != null ? c[idx.supplier] || 'CFE' : 'CFE';
      for (const k of Object.keys(COLS)) {
        if (k === 'month' || k === 'supplier' || idx[k] == null) continue;
        const v = parseNum(c[idx[k]], d);
        if (Number.isNaN(v)) errs.push(k + ' no es número');
        bill[k] = Number.isNaN(v) ? null : v;
      }
      if (bill.pf != null && bill.pf > 1) bill.pf = +(bill.pf / 100).toFixed(4);
      if (bill.total_mxn == null) errs.push('falta total');
      if (!kwhOf(bill)) errs.push('faltan kWh');
      return { line: n + 2, bill, errs };
    });
    return { rows };
  }
  function openImport() {
    modal(`<h2>Importar recibos de ${esc(site().name)}</h2>
      <p class="muted small" style="margin:0">Pega las filas desde Excel o sube un archivo CSV. Una fila por mes. Si un mes ya existe, se reemplaza. Para los PDF usa “Leer recibo PDF con IA”.</p>
      <div class="row"><button class="btn btn-sm" onclick="Sites.downloadTemplate()">Descargar plantilla</button>
        <label class="btn btn-sm" style="margin:0">Subir CSV<input type="file" accept=".csv,text/csv,.txt" hidden onchange="Sites.loadCsv(this)"></label></div>
      <textarea id="ix-text" rows="7" class="mono small" placeholder="mes,kwh_base,kwh_intermedia,kwh_punta,demanda_kw,fp,total_mxn,ref_cfe_mxn"></textarea>
      <div id="ix-preview"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Sites.closeModal()">Cancelar</button><button class="btn" onclick="Sites.previewCsv()">Vista previa</button><button class="btn btn-dark" id="ix-go" onclick="Sites.importCsv(this)" disabled>Importar</button></div>`);
    $('ix-text').addEventListener('input', () => { $('ix-go').disabled = true; });
  }
  function downloadTemplate() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' }));
    a.download = 'plantilla-recibos-sentinels.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function loadCsv(input) { const f = input.files[0]; input.value = ''; if (f) { $('ix-text').value = await f.text(); previewCsv(); } }
  let parsed = null;
  function previewCsv() {
    parsed = parseCsv($('ix-text').value);
    const box = $('ix-preview');
    if (parsed.error) { box.innerHTML = `<div class="msg msg-err">${esc(parsed.error)}</div>`; $('ix-go').disabled = true; return; }
    const ok = parsed.rows.filter(r => !r.errs.length);
    const existing = new Set(site().bills.map(b => b.month));
    box.innerHTML = `<table><thead><tr><th>Fila</th><th>Mes</th><th>kWh total</th><th>Total MXN</th><th>Ref. CFE</th><th>Estado</th></tr></thead><tbody>
      ${parsed.rows.map(r => `<tr><td class="mono small">${r.line}</td><td class="mono small">${r.bill.month ? monthLabel(r.bill.month) : '—'}</td><td class="mono small">${fmtN(kwhOf(r.bill))}</td>
        <td class="mono small">${fmtN(r.bill.total_mxn)}</td><td class="mono small">${fmtN(r.bill.ref_cfe_mxn)}</td>
        <td class="small" style="color:${r.errs.length ? 'var(--neg)' : 'var(--pos)'}">${r.errs.length ? esc(r.errs.join(', ')) : existing.has(r.bill.month) ? 'Reemplaza' : 'Nuevo'}</td></tr>`).join('')}
      </tbody></table><p class="small muted" style="margin:6px 0 0">${ok.length} de ${parsed.rows.length} filas listas para importar${ok.length < parsed.rows.length ? '; las filas con error se omiten' : ''}.</p>`;
    $('ix-go').disabled = !ok.length;
  }
  async function importCsv(btn) {
    const ok = (parsed && parsed.rows || []).filter(r => !r.errs.length);
    if (!ok.length) return;
    await busy(btn, 'Importando…', async () => {
      const s = site();
      for (const { bill } of ok) {
        const prev = s.bills.find(b => b.month === bill.month);
        bill.doc = prev ? prev.doc : null;
        learnIvaRate(s, bill);
        s.bills = s.bills.filter(b => b.month !== bill.month).concat(bill);
      }
      await save('recibos importados');
      closeModal(); renderEditor();
    });
  }

  /* ── Contracts ───────────────────────────────────── */
  function renderContracts() {
    const box = $('contracts-panel'); if (!box) return;
    const list = contracts().slice().sort((a, b) => String(b.start).localeCompare(String(a.start)));
    const names = Object.fromEntries(sites().map(s => [s.id, s.name]));
    box.innerHTML = `
      <div class="row" style="margin-bottom:10px"><button class="btn btn-sm" onclick="Sites.editContract(null)">+ Agregar contrato</button></div>
      <table><thead><tr><th>Contrato</th><th>Tipo</th><th>Vigencia</th><th>Volumen</th><th>Precio</th><th>Plantas</th><th></th></tr></thead><tbody>
      ${list.length ? list.map(c => `<tr><td><b>${esc(c.name || c.counterparty || '—')}</b><div class="small muted">${esc(c.counterparty || '')}${c.technology ? ' · ' + esc(c.technology) : ''}</div></td>
          <td class="small">${esc(c.type)}</td><td class="mono small">${esc(c.start || '—')} → ${esc(c.end || '—')}</td>
          <td class="mono small">${c.volume_gwh != null ? fmtN(c.volume_gwh, 1) + ' GWh/año' : '—'}</td><td class="mono small">${c.price_mxn_kwh != null ? fmtN(c.price_mxn_kwh, 3) + ' MXN/kWh' : '—'}</td>
          <td class="small">${(c.sites || []).map(id => esc(names[id] || '')).filter(Boolean).join(', ') || 'Todas'}</td>
          <td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" onclick="Sites.editContract('${c.id}')">Editar</button> <button class="btn btn-sm btn-danger" onclick="Sites.deleteContract('${c.id}', this)">Quitar</button></td></tr>`).join('')
        : '<tr><td colspan="7" class="muted">Sin contratos registrados. Los datos del contrato principal siguen en la sección “Contrato” de arriba.</td></tr>'}
      </tbody></table>`;
  }
  function editContract(id) {
    const c = id ? contracts().find(x => x.id === id) : { type: 'PPA', sites: [] };
    modal(`<h2>${id ? 'Editar contrato' : 'Nuevo contrato'}</h2>
      <div class="grid">
        <div><label>Tipo</label><select id="cx-type">${CONTRACT_TYPES.map(t => `<option ${t === c.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label>Nombre / ID del contrato</label><input id="cx-name" value="${esc(c.name || '')}" placeholder="PPA-2025-014"></div>
        <div><label>Contraparte *</label><input id="cx-counterparty" value="${esc(c.counterparty || '')}" placeholder="Solar Noroeste"></div>
        <div><label>Tecnología</label><input id="cx-technology" value="${esc(c.technology || '')}" placeholder="Solar, eólica, mixta…"></div>
        <div><label>Inicio</label><input id="cx-start" type="date" value="${esc(c.start || '')}"></div>
        <div><label>Fin</label><input id="cx-end" type="date" value="${esc(c.end || '')}"></div>
        <div><label>Volumen anual (GWh)</label><input id="cx-volume" type="number" step="any" value="${esc(c.volume_gwh ?? '')}"></div>
        <div><label>Precio (MXN/kWh)</label><input id="cx-price" type="number" step="any" value="${esc(c.price_mxn_kwh ?? '')}"></div>
        <div><label>Escalamiento</label><input id="cx-escalation" value="${esc(c.escalation || '')}" placeholder="INPC − 1.2% anual"></div>
        <div><label>% a precio fijo</label><input id="cx-fixed" type="number" step="any" value="${esc(c.fixed_pct ?? '')}" placeholder="70"></div>
      </div>
      <div><label>Plantas que cubre</label><div class="row">${sites().length ? sites().map(s => `<label class="small" style="display:flex;gap:6px;align-items:center;margin:0;font-weight:500"><input type="checkbox" class="cx-site" value="${s.id}" style="width:auto;height:auto" ${(c.sites || []).includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') : '<span class="small muted">Agrega plantas para asignarlas.</span>'}</div></div>
      <div><label>Notas (las ve el cliente y Sentinel One)</label><textarea id="cx-notes" rows="3">${esc(c.notes || '')}</textarea></div>
      <div id="cx-msg"></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onclick="Sites.closeModal()">Cancelar</button><button class="btn btn-dark" onclick="Sites.saveContract('${id || ''}', this)">Guardar contrato</button></div>`);
  }
  async function saveContract(id, btn) {
    const num = v => { v = v.trim(); return v === '' ? null : Number(v); };
    const data = {
      type: $('cx-type').value, name: $('cx-name').value.trim(), counterparty: $('cx-counterparty').value.trim(),
      technology: $('cx-technology').value.trim(), start: $('cx-start').value, end: $('cx-end').value,
      volume_gwh: num($('cx-volume').value), price_mxn_kwh: num($('cx-price').value), escalation: $('cx-escalation').value.trim(),
      fixed_pct: num($('cx-fixed').value), sites: [...document.querySelectorAll('.cx-site:checked')].map(x => x.value), notes: $('cx-notes').value.trim()
    };
    if (!data.counterparty) return msg('cx-msg', 'Escribe la contraparte.');
    if (data.start && data.end && data.end < data.start) return msg('cx-msg', 'La fecha de fin es anterior al inicio.');
    await busy(btn, 'Guardando…', async () => {
      if (id) Object.assign(contracts().find(x => x.id === id), data);
      else contracts().push({ id: uid(), ...data });
      await save('contratos');
      closeModal(); renderContracts();
    });
  }
  async function deleteContract(id, btn) {
    const c = contracts().find(x => x.id === id);
    if (!confirm(`¿Quitar el contrato "${c.name || c.counterparty}"?`)) return;
    await busy(btn, '…', async () => {
      CUR.data.contracts = contracts().filter(x => x.id !== id);
      await save('contratos');
      renderContracts();
    });
  }

  return {
    render, closeModal, select: id => { sel = id; renderSites(); },
    editSite, saveSite, deleteSite, editBill, cancelBill, saveBill, deleteBill, viewPdf, readPdf, rereadBill,
    openImport, downloadTemplate, loadCsv, previewCsv, importCsv, editContract, saveContract, deleteContract,
    _parseCsv: parseCsv
  };
})();
