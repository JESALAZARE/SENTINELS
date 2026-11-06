/* ── Sentinels Client Portal · Grid Map ──────────────────────────────
   Energy infrastructure around a point the user types (an address or place
   found with Esri's geocoder through the Worker, coordinates, or a Google
   Maps link), in two sections:
     Power        Transmission  national transmission lines (by kV) and
                                substations, nearest ones listed by distance.
                  Distribution  CFE medium-voltage circuits around the point
                                (0.1° cells fetched for the chosen radius).
     Natural Gas  SISTRANGAS, private and US border pipelines and LNG
                  terminals, nearest ones listed by distance.
   The Generation switch (Power and Natural Gas) overlays power plants
   (capas/generacion, one entry per plant with its units) as points sized by
   MW, filled when the location is exact and translucent with a border when it
   is approximate, with a filterable plant table under the nearby table. In
   Natural Gas each plant also shows its nearest pipeline and distance.
   All layers are private: they sit in Cloudflare R2 behind the Sentinel One
   Worker, which checks the client's signed pass (ME.ai). Distribution comes
   from /red (only the cells around the point); Transmission and Natural Gas
   are small national packs from /capa (capas/<name>.json.gz), loaded once.
   Leaflet is loaded on first use, pinned with SRI.
   Distribution hosting capacity figures are kept in the data (they drive
   the line colours) but hidden while SHOW_CAPACITY is false.
   Uses the globals ME, MY_ID and _esc (index.html). */
const GridPage = (() => {
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const SRI = {
    js: 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==',
    css: 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=='
  };
  const BASE = {
    map: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', 'Tiles &copy; Esri', 16,
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
    sat: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Imagery &copy; Esri', 19,
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}']
  };
  const MX_VIEW = [[23.6, -102.5], 5];
  const CELL = 0.1, Q = 1e5;
  // Distribution is fetched by radius (cells); the national layers just list what is nearby, so wider radii make sense
  const RADII = { dist: [1, 2, 5, 10, 15], tx: [5, 10, 25, 50, 100], gas: [5, 10, 25, 50, 100] };
  const DEF_KM = { dist: 5, tx: 25, gas: 25 };
  // Capacity figures (MW, %, CRE limit) stay hidden; set to true to show them again
  const SHOW_CAPACITY = false;
  // Distribution: colour by share of hosting capacity still available
  const BANDS = [
    { min: 50, color: '#1F9D55', label: '≥ 50% available' },
    { min: 20, color: '#D69E2E', label: '20–50%' },
    { min: 0, color: '#C53030', label: '< 20%' }
  ];
  const GREY = '#8A94A0', NODATA = '#5B7DB1', INK = '#0F1B2D';
  // Transmission: colour by voltage class
  const KV = [
    { key: 'kv400', min: 400, color: '#B83280', label: '400 kV' },
    { key: 'kv230', min: 230, color: '#2B6CB0', label: '230 kV' },
    { key: 'kv115', min: 115, color: '#2F855A', label: '115–161 kV' },
    { key: 'kvlow', min: -Infinity, color: '#8A94A0', label: '< 115 kV' }
  ];
  const kvClass = kv => KV.find(k => (kv || 0) >= k.min);
  // Natural gas layers
  const GAS = {
    sng: { color: '#DD6B20', weight: 2.6, label: 'SISTRANGAS', system: 'SISTRANGAS' },
    priv: { color: '#6B46C1', weight: 2.6, label: 'Private pipelines', system: 'Private' },
    usa: { color: '#94A3B8', weight: 1.2, label: 'US pipelines', system: 'United States' },
    gnl: { color: '#0F766E', label: 'LNG terminals', system: 'LNG terminal' }
  };
  // Power plants: colour by unit status
  const GEN_STATUS = [
    { key: 'Operating', color: '#2B6CB0' },
    { key: 'Construction', color: '#D69E2E' },
    { key: 'Pre-construction', color: '#805AD5' },
    { key: 'Announced', color: '#805AD5' },
    { key: 'Shelved', color: '#8A94A0' },
    { key: 'Mothballed', color: '#8A94A0' },
    { key: 'Cancelled', color: '#C53030' },
    { key: 'Retired', color: '#C53030' }
  ];
  const GEN_PRIORITY = ['Operating', 'Construction', 'Pre-construction', 'Announced', 'Mothballed', 'Shelved', 'Retired', 'Cancelled'];
  const genColor = st => (GEN_STATUS.find(x => x.key === st) || { color: GREY }).color;
  const GEN_FILTERS = { q: '', min: '', max: '', tech: '', status: '', fuel: '', state: '', acc: '', pipe: '' };
  const PIPE_KM = [1, 5, 10, 25, 50];   // "Pipeline within" filter (Natural Gas)
  const MODES = {
    tx: { section: 'power', title: 'Nearby transmission', what: 'transmission lines and substations', cols: ['Name', 'Type', 'kV', 'Distance km'] },
    dist: { section: 'power', title: 'Nearby circuits', what: 'CFE medium-voltage circuits', cols: ['Circuit', 'Substation', 'Zone', 'kV'].concat(SHOW_CAPACITY ? ['Avail. MW', 'Avail.'] : [], ['Nearest line km']) },
    gas: { section: 'gas', title: 'Nearby gas infrastructure', what: 'pipelines and LNG terminals', cols: ['Name', 'System', 'Diam.', 'Distance km'] }
  };

  const cfg = () => (typeof ME !== 'undefined' && ME && ME.ai && ME.ai.enabled && ME.ai.url && ME.ai.token) ? ME.ai : null;
  const $ = id => document.getElementById(id);
  const fmt = (v, d = 0) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('sp_grid_' + MY_ID)) || {}; } catch { return {}; } },
    set(v) { try { localStorage.setItem('sp_grid_' + MY_ID, JSON.stringify({ ...store.get(), ...v })); } catch {} }
  };

  let L = null, _leaflet = null, map = null, base = null, renderer = null, baseKind = 'map';
  let built = false, busy = false, mode = 'dist';
  let point = null;                     // { lat, lon, km, label } of the last search
  let data = null, selected = null;     // distribution results around the point
  let distGroup = null, pinGroup = null;
  const packs = {};                     // tx / gas: { feats, group, sub: { key: layerGroup }, on: Set }
  let near = [];                        // tx / gas rows within the radius
  let sugs = [], sugActive = -1, picked = null, sugTimer = 0, sugSeq = 0;
  let genOn = false, gen = null, genF = { ...GEN_FILTERS }, genFocus = null, genPipe = null;  // power plants overlay

  function loadLeaflet() {
    return _leaflet || (_leaflet = new Promise((res, rej) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.min.css'; css.integrity = SRI.css; css.crossOrigin = 'anonymous';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET + 'leaflet.min.js'; s.integrity = SRI.js; s.crossOrigin = 'anonymous';  // reject a tampered CDN copy
      s.onload = () => { L = window.L; res(L); };
      s.onerror = () => { _leaflet = null; rej(new Error('leaflet')); };
      document.head.appendChild(s);
    }));
  }

  /* ── Page ─────────────────────────────────────── */
  function init() {
    const nav = document.querySelector('.cp-nav-item[data-section="grid"]');
    if (nav) nav.style.display = cfg() ? '' : 'none';
  }

  const kmOptions = () => { const ks = RADII[mode], cur = store.get()['km_' + mode] || DEF_KM[mode];
    return ks.map(k => `<option value="${k}" ${k === cur ? 'selected' : ''}>${k} km</option>`).join(''); };

  function build() {
    const last = store.get();
    if (MODES[last.mode]) mode = last.mode;
    $('grid-root').innerHTML = `
      <div class="cp-gr-modes">
        <div class="cp-gr-tabs" role="tablist" aria-label="Infrastructure">
          <button type="button" role="tab" class="cp-gr-tab" data-section="power">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>Power</button>
          <button type="button" role="tab" class="cp-gr-tab" data-section="gas">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8 0 4 3 7 7 7z"/></svg>Natural Gas</button>
        </div>
        <div class="cp-gr-modes-r">
        <div class="cp-gr-seg" id="gr-seg" role="radiogroup" aria-label="Power network">
          <button type="button" role="radio" data-mode="tx">Transmission</button>
          <button type="button" role="radio" data-mode="dist">Distribution</button>
        </div>
        <label class="cp-gr-switch" id="gr-gen-wrap"><input type="checkbox" role="switch" id="gr-gen"><span class="cp-gr-knob" aria-hidden="true"></span>Generation</label>
        </div>
      </div>
      <div class="cp-card cp-gr-card">
        <form class="cp-pr-row" id="gr-form" autocomplete="off">
          <div class="cp-pr-f cp-gr-coord"><label for="gr-coord"><span>Address, place or coordinates</span></label>
            <div class="cp-gr-search">
              <input id="gr-coord" type="search" enterkeyhint="search" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="gr-sug"
                placeholder="Parque Industrial Stiva, Apodaca · 25.6866, -100.3161" value="${_esc(last.coord || '')}">
              <ul class="cp-gr-sug" id="gr-sug" role="listbox" hidden></ul>
            </div></div>
          <label class="cp-pr-f"><span>Radius</span><select id="gr-km">${kmOptions()}</select></label>
          <button type="submit" class="cp-btn-dark cp-gr-go" id="gr-go">Search</button>
          <button type="button" class="cp-pr-dl cp-gr-loc" id="gr-loc" title="Use this device's location">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>My location</button>
          <button type="button" class="cp-pr-dl cp-gr-clear" id="gr-clear" title="Clear the search, the map and the table">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>Clear</button>
        </form>
        <div class="cp-pr-note cp-gr-hint" id="gr-msg"></div>
      </div>
      <div class="cp-gr-main">
        <div class="cp-card cp-gr-mapcard">
          <div class="cp-gr-map" id="gr-map"></div>
          <div class="cp-gr-legend"><div class="cp-gr-legend-items" id="gr-legend"></div>
            <button type="button" class="cp-pr-dl cp-gr-base" id="gr-base">Satellite</button></div>
        </div>
        <div class="cp-gr-right" id="gr-right">
        <div class="cp-card cp-gr-side">
          <div class="cp-gr-sidehead">
            <div><div class="cp-widget-title" id="gr-title"></div><div class="cp-pr-note" id="gr-count">—</div></div>
          </div>
          <div class="cp-pr-scroll cp-gr-scroll"><table class="cp-mini-table cp-gr-table">
            <thead id="gr-head"></thead><tbody id="gr-rows"></tbody>
          </table></div>
        </div>
        <div class="cp-card cp-gr-side cp-gr-plants" id="gr-plants" hidden>
          <div class="cp-gr-sidehead">
            <div><div class="cp-widget-title">Power plants</div><div class="cp-pr-note" id="gr-gcount">—</div></div>
            <button type="button" class="cp-pr-dl" id="gr-greset">Reset filters</button>
          </div>
          <div class="cp-gr-filters" id="gr-gfilters"></div>
          <div class="cp-pr-scroll cp-gr-scroll cp-gr-gscroll"><table class="cp-mini-table cp-gr-table">
            <thead id="gr-ghead"></thead><tbody id="gr-grows"></tbody>
          </table></div>
        </div>
        </div>
      </div>`;
    $('grid-root').querySelectorAll('.cp-gr-tab').forEach(b => b.addEventListener('click', () =>
      setMode(b.dataset.section === 'gas' ? 'gas' : (store.get().power || 'tx'))));
    $('gr-seg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    genOn = !!last.gen; $('gr-gen').checked = genOn;
    $('gr-gen').addEventListener('change', () => { genOn = $('gr-gen').checked; store.set({ gen: genOn }); applyGen(); });
    $('gr-greset').addEventListener('click', () => { genF = { ...GEN_FILTERS }; genFilters(); filterGen(); });
    $('gr-grows').addEventListener('click', e => { const tr = e.target.closest('tr[data-g]'); if (tr) focusPlant(Number(tr.dataset.g), true); });
    $('gr-form').addEventListener('submit', e => { e.preventDefault(); if (sugActive >= 0) pick(sugActive); else { hideSug(); load(); } });
    $('gr-km').addEventListener('change', () => { store.set({ ['km_' + mode]: Number($('gr-km').value) }); if (point) load(); });
    $('gr-loc').addEventListener('click', locate);
    $('gr-clear').addEventListener('click', clear);
    const inp = $('gr-coord');
    inp.addEventListener('input', () => { picked = null; clearTimeout(sugTimer); sugTimer = setTimeout(suggest, 250); });
    inp.addEventListener('keydown', e => {
      if ($('gr-sug').hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugActive = (sugActive + (e.key === 'ArrowDown' ? 1 : -1) + sugs.length) % sugs.length; drawSug(); }
      else if (e.key === 'Escape') hideSug();
    });
    inp.addEventListener('blur', () => setTimeout(hideSug, 150));
    $('gr-sug').addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(Number(li.dataset.i)); } });
    $('gr-base').addEventListener('click', toggleBase);
    $('gr-legend').addEventListener('click', e => { const b = e.target.closest('button[data-layer]'); if (b) toggleLayer(b.dataset.layer); });
    $('gr-rows').addEventListener('click', e => { const tr = e.target.closest('tr[data-c]'); if (!tr) return;
      if (mode === 'dist') select(tr.dataset.c, true); else focusFeat(Number(tr.dataset.c), true); });
    built = true;
    chrome();
  }

  async function show() {
    if (!built) build();
    try { await loadLeaflet(); } catch { msg('The map library could not be loaded. Check your connection and reload the page.', true); return; }
    if (!map) {
      renderer = L.canvas({ padding: 0.3, tolerance: 6 });
      map = L.map('gr-map', { preferCanvas: true, zoomControl: true, attributionControl: true }).setView(...MX_VIEW);
      setBase('map');
      distGroup = L.layerGroup(); pinGroup = L.layerGroup().addTo(map);
      map.on('click', e => {
        if (busy) return;
        $('gr-coord').value = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6); picked = null; hideSug();
        msg('Point selected. Press <b>Search</b> to list what is around it.');
      });
      map.on('zoomend', scaleSubs);
      await setMode(mode, true);
      if (store.get().coord) load();
    }
    setTimeout(() => map.invalidateSize(), 0);
  }

  // Tabs, switch, radius options, legend and table header for the current mode
  function chrome() {
    const m = MODES[mode];
    $('grid-root').querySelectorAll('.cp-gr-tab').forEach(b => { const on = b.dataset.section === m.section; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    $('gr-seg').hidden = m.section !== 'power';
    $('gr-seg').querySelectorAll('button').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    $('gr-km').innerHTML = kmOptions();
    $('gr-title').textContent = m.title;
    $('gr-head').innerHTML = `<tr>${m.cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
    legend();
    if (!point) {
      $('gr-count').textContent = '—';
      empty(mode === 'dist' ? 'Search a place to see its circuits.' : `Search a place to list the nearest ${m.what}.`);
      msg(mode === 'dist'
        ? 'Search an address, industrial park or company, or type coordinates (you can paste a Google Maps link), and choose a radius. You can also click the map to pick a point.'
        : `The map shows Mexico's ${m.what}. Search a place to list the nearest ones; click a line or a point for its details.`);
    }
  }
  const empty = text => { $('gr-rows').innerHTML = `<tr><td colspan="${MODES[mode].cols.length}" class="cp-gr-empty">${text}</td></tr>`; };

  function legend() {
    const chip = (key, label, sw, on) => `<button type="button" class="cp-gr-chip ${on ? '' : 'is-off'}" data-layer="${key}" aria-pressed="${on}">${sw}${label}</button>`;
    const on = key => !packs[mode] || packs[mode].on.has(key);
    let html;
    if (mode === 'dist') {
      html = BANDS.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('') +
        `<span><i style="background:${GREY}"></i>Out of service</span><span><i style="background:${NODATA}"></i>No data</span>
         <span><i class="cp-gr-dash"></i>Underground</span><span><i class="cp-gr-sub"></i>Substation</span>`;
    } else if (mode === 'tx') {
      html = KV.map(k => chip(k.key, k.label, `<i style="background:${k.color}"></i>`, on(k.key))).join('') +
        chip('se', 'Substations', '<i class="cp-gr-sub"></i>', on('se'));
    } else {
      html = ['sng', 'priv', 'usa'].map(k => chip(k, GAS[k].label, `<i style="background:${GAS[k].color}"></i>`, on(k))).join('') +
        chip('gnl', GAS.gnl.label, `<i class="cp-gr-lng"></i>`, on('gnl')) + '<span><i class="cp-gr-dash"></i>Project / construction</span>';
    }
    // Power plants: status colours and exact / approximate location
    if (genOn) {
      const dot = (c, approx) => `<i class="cp-gr-pt${approx ? ' cp-gr-pt--approx' : ''}" style="--c:${c}"></i>`;
      html += `<span class="cp-gr-legsep"></span>` + [['Operating', '#2B6CB0'], ['Construction', '#D69E2E'], ['Planned', '#805AD5'], ['Shelved / mothballed', '#8A94A0'], ['Cancelled / retired', '#C53030']]
        .map(([l, c]) => `<span>${dot(c)}${l}</span>`).join('') + `<span>${dot('#2B6CB0')}Exact</span><span>${dot('#2B6CB0', true)}Approximate location</span>`;
    }
    $('gr-legend').innerHTML = html;
  }

  async function setMode(m, first) {
    if (!MODES[m] || (m === mode && !first)) return;
    mode = m;
    store.set({ mode: m, ...(MODES[m].section === 'power' ? { power: m } : {}) });
    map && map.closePopup();
    chrome();
    if (!map) return;
    // Show only this mode's layers
    for (const k of ['tx', 'gas']) if (packs[k] && map.hasLayer(packs[k].group) && k !== m) map.removeLayer(packs[k].group);
    if (m !== 'dist' && map.hasLayer(distGroup)) map.removeLayer(distGroup);
    if (m === 'dist') { distGroup.addTo(map); pinGroup.eachLayer(l => l.bringToFront && l.bringToFront()); }
    if (m !== 'dist') {
      try { await ensurePack(m); } catch (e) { msg(_esc(e.message), true); return; }
      if (mode !== m) return;
      packs[m].group.addTo(map); legend(); scaleSubs();
    }
    applyGen();
    if (point) {
      if (m === 'dist') { if (data && data.lat === point.lat && data.lon === point.lon && data.km === point.km) { rows(); msgResult(); } else if (!first) load(); }
      else { point.km = Number($('gr-km').value); drawPin(); nearby(); }
    } else if (m !== 'dist' && !first) map.setView(...MX_VIEW);
  }

  function setBase(kind) {
    baseKind = kind;
    if (base) map.removeLayer(base);
    const [url, attribution, maxNativeZoom, labels] = BASE[kind];
    // Esri tiles need no key or referrer (the portal sends none); labels go in their own layer
    base = L.layerGroup([L.tileLayer(url, { maxZoom: 19, maxNativeZoom, attribution }), L.tileLayer(labels, { maxZoom: 19, maxNativeZoom })]).addTo(map);
    $('gr-base').textContent = kind === 'map' ? 'Satellite' : 'Map';
  }
  const toggleBase = () => map && setBase(baseKind === 'map' ? 'sat' : 'map');

  function msg(html, err) { const m = $('gr-msg'); m.innerHTML = html; m.classList.toggle('cp-gr-err', !!err); }

  // "25.68, -100.31", "25.68 -100.31", or a Google Maps link with @lat,lon
  function parse(s) {
    s = String(s || '').trim();
    const at = s.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    const m = at || s.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    let lat = Number(m[1]), lon = Number(m[2]);
    if (lat < 0 && lon > 0 && Math.abs(lat) > 80) [lat, lon] = [lon, lat];  // typed lon, lat
    if (!(lat >= 14 && lat <= 33.5 && lon >= -118.5 && lon <= -86)) return null;
    return { lat, lon };
  }

  function locate() {
    if (!navigator.geolocation) { msg('This device does not share its location.', true); return; }
    msg('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      p => { $('gr-coord').value = p.coords.latitude.toFixed(6) + ', ' + p.coords.longitude.toFixed(6); load(); },
      () => msg('The location could not be read. Allow location access or type the coordinates.', true),
      { enableHighAccuracy: true, timeout: 15000 });
  }

  /* ── Clear ────────────────────────────────────── */
  function clear() {
    if (busy) return;
    $('gr-coord').value = ''; picked = null; hideSug();
    store.set({ coord: '' });
    point = null; data = null; selected = null; near = [];
    if (map) { map.closePopup(); distGroup.clearLayers(); pinGroup.clearLayers(); unfocus(); map.setView(...MX_VIEW); }
    chrome();
    if (gen) genRows();
    $('gr-coord').focus();
  }

  /* ── Address search (Esri, through the Worker) ── */
  const post = (path, body) => { const c = cfg();
    return fetch(c.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: MY_ID, token: c.token, ...body }) }); };
  // Bias results toward what the map shows once it has a point
  const bias = () => point ? { lat: point.lat, lon: point.lon } : {};

  async function suggest() {
    const text = $('gr-coord').value.trim(), seq = ++sugSeq;
    if (!cfg() || text.length < 3 || parse(text)) { hideSug(); return; }
    try {
      const r = await post('/geo/suggest', { text, ...bias() });
      if (seq !== sugSeq) return;
      if (!r.ok) { hideSug(); return; }
      sugs = (await r.json()).suggestions || []; sugActive = -1; drawSug();
    } catch { if (seq === sugSeq) hideSug(); }
  }
  function drawSug() {
    const ul = $('gr-sug'), inp = $('gr-coord'), open = sugs.length > 0 && document.activeElement === inp;
    ul.innerHTML = sugs.map((x, i) => `<li role="option" data-i="${i}" id="gr-sug-${i}" aria-selected="${i === sugActive}" class="${i === sugActive ? 'is-act' : ''}">${_esc(x.text)}</li>`).join('');
    ul.hidden = !open; inp.setAttribute('aria-expanded', String(open));
    if (sugActive >= 0) inp.setAttribute('aria-activedescendant', 'gr-sug-' + sugActive); else inp.removeAttribute('aria-activedescendant');
  }
  function hideSug() {
    sugs = []; sugActive = -1; sugSeq++;
    const ul = $('gr-sug'); if (!ul) return;
    ul.hidden = true; ul.innerHTML = ''; $('gr-coord').setAttribute('aria-expanded', 'false'); $('gr-coord').removeAttribute('aria-activedescendant');
  }
  function pick(i) { const x = sugs[i]; if (!x) return; $('gr-coord').value = x.text; picked = x; hideSug(); load(); }

  // Text → point: coordinates or a Google Maps link directly, anything else through the geocoder
  async function resolve(text) {
    const p = parse(text);
    if (p) return { ...p, label: '' };
    if (text.length < 3) throw new Error('Type an address or place, or coordinates as latitude, longitude.');
    const r = await post('/geo/find', { text, magicKey: picked && picked.text === text ? picked.magicKey : undefined, ...bias() });
    const d = await r.json().catch(() => ({}));
    if (r.status === 503) throw new Error('Address search is not enabled yet. Type the coordinates as latitude, longitude.');
    if (!r.ok) throw new Error(d.message || 'Address search is temporarily unavailable.');
    if (!(d.lat >= 14 && d.lat <= 33.5 && d.lon >= -118.5 && d.lon <= -86)) throw new Error('That place is outside Mexico.');
    return { lat: d.lat, lon: d.lon, label: d.label || text };
  }

  /* ── Search ───────────────────────────────────── */
  async function load() {
    if (busy) return;
    if (!cfg()) { msg('The grid map is not enabled for your account. Contact your Sentinel advisor.', true); return; }
    const text = $('gr-coord').value.trim(), km = Number($('gr-km').value);
    if (!text) { msg('Search an address or place, or type coordinates as <b>latitude, longitude</b>, e.g. 25.6866, -100.3161.', true); return; }
    store.set({ coord: text, ['km_' + mode]: km });
    busy = true; $('gr-go').disabled = true; $('gr-go').textContent = 'Loading…';
    msg(parse(text) ? 'Loading…' : 'Finding the place…');
    try {
      const p = await resolve(text);
      point = { lat: p.lat, lon: p.lon, km, label: p.label };
      if (mode === 'dist') {
        if (p.label) msg(`Loading the grid within ${km} km of <b>${_esc(p.label)}</b>…`);
        const { cells, updated } = await fetchArea(p.lat, p.lon, km);
        data = { ...assemble(cells, p.lat, p.lon, km), lat: p.lat, lon: p.lon, km, updated };
        drawPin(); draw(); msgResult();
        if (gen) genRows();
      } else {
        await ensurePack(mode);
        drawPin(); nearby();
      }
      if (gen) genRows();
    } catch (e) {
      msg(_esc(e.message || 'The grid map could not be loaded.'), true);
    } finally {
      busy = false; $('gr-go').disabled = false; $('gr-go').textContent = 'Search';
    }
  }

  const where = () => point.label ? `<b>${_esc(point.label)}</b> (${point.lat.toFixed(5)}, ${point.lon.toFixed(5)})` : `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  function msgResult() {
    const n = data.list.length;
    msg(n ? `<b>${n}</b> circuit${n === 1 ? '' : 's'} within ${data.km} km of ${where()}. Click a line or a row to highlight its circuit.`
      : `No CFE medium-voltage lines within ${data.km} km of this point. Try a larger radius.`);
  }

  // The searched point and its radius, shared by every mode
  function drawPin() {
    pinGroup.clearLayers();
    const { lat, lon, km, label } = point;
    L.circle([lat, lon], { radius: km * 1000, renderer, color: INK, weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(pinGroup);
    L.circleMarker([lat, lon], { renderer, radius: 7, color: '#fff', weight: 2, fillColor: INK, fillOpacity: 1 })
      .bindTooltip(label ? _esc(label) : 'Selected point').addTo(pinGroup);
    map.stop(); map.fitBounds(L.latLng(lat, lon).toBounds(km * 2000), { padding: [10, 10], animate: false });
  }

  /* ── Distribution (cells from /red) ───────────── */
  async function fetchArea(lat, lon, km) {
    const r = await post('/red', { lat, lon, km });
    if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch {} throw new Error(m || 'The grid map is temporarily unavailable.'); }
    const buf = new Uint8Array(await r.arrayBuffer()), dv = new DataView(buf.buffer), cells = [];
    for (let o = 0; o + 4 <= buf.length;) {
      const n = dv.getUint32(o); o += 4;
      cells.push(JSON.parse(await gunzip(buf.subarray(o, o + n)))); o += n;
    }
    return { cells, updated: r.headers.get('X-Grid-Updated') || '' };
  }
  const gunzip = bytes => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

  // Equirectangular distance in km (accurate enough at these radii)
  function distKm(lat0, lon0, lat, lon) {
    const k = 111.32, x = (lon - lon0) * k * Math.cos(lat0 * Math.PI / 180), y = (lat - lat0) * k;
    return Math.sqrt(x * x + y * y);
  }

  // Cells → circuits within the radius, each with its segments (deduplicated across cell borders)
  function assemble(cells, lat, lon, km) {
    const circ = new Map(), seen = new Set(), subs = new Map();
    for (const cell of cells) {
      for (const s of cell.s) {
        const info = cell.c[s[0]], code = info[0];
        const key = code + '|' + s.slice(1).join(',');
        if (seen.has(key)) continue; seen.add(key);
        const pts = []; let x = s[2], y = s[3], nr = Infinity;
        for (let k = 2; k < s.length; k += 2) {
          if (k > 2) { x += s[k]; y += s[k + 1]; }
          const la = y / Q, lo = x / Q; pts.push([la, lo]);
          const d = distKm(lat, lon, la, lo); if (d < nr) nr = d;
        }
        if (nr > km) continue;
        const c = circ.get(code) || circ.set(code, { info, near: Infinity, lines: [[], [], [], []] }).get(code);
        c.lines[s[1]].push(pts);  // flag: 1 underground, 2 trunk
        if (nr < c.near) c.near = nr;
      }
      for (const e of cell.e) {
        const d = distKm(lat, lon, e[4], e[3]);
        if (d <= km) subs.set(e[0] + '|' + e[3] + '|' + e[4], { code: e[0], name: e[1], lon: e[3], lat: e[4], d });
      }
    }
    // Substation names from the substation layer when the catalog has none
    const names = {}; for (const s of subs.values()) if (s.name) names[s.code] ||= s.name;
    const list = [...circ.values()].map(c => {
      const [code, sub, subName, division, kv, total, inst, avail, cre, out] = c.info;
      const pct = total > 0 && avail != null ? avail / total * 100 : null;
      return { code, sub, subName: subName || names[sub] || '', division, kv, total, inst, avail, cre, out: !!out, pct, near: c.near, lines: c.lines };
    }).sort((a, b) => a.near - b.near);
    return { list, subs: [...subs.values()] };
  }

  const colorOf = c => c.out ? GREY : c.pct == null ? NODATA : BANDS.find(b => c.pct >= b.min).color;

  function draw() {
    distGroup.clearLayers(); selected = null;
    for (const c of data.list) {
      const color = colorOf(c);
      c.layers = c.lines.map((ls, flag) => ls.length ? L.polyline(ls, {
        renderer, color, weight: flag & 2 ? 3.2 : 2, opacity: .9, dashArray: flag & 1 ? '5 4' : null, base: { color, weight: flag & 2 ? 3.2 : 2, opacity: .9 }
      }).on('click', ev => { L.DomEvent.stopPropagation(ev); select(c.code, false, ev.latlng); }).addTo(distGroup) : null).filter(Boolean);
    }
    for (const s of data.subs) {
      L.circleMarker([s.lat, s.lon], { renderer, radius: 6, color: INK, weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`<b>${_esc(s.code)}</b> ${_esc(s.name || '')}`).addTo(distGroup);
    }
    rows();
  }

  function rows() {
    const list = data.list;
    const mw = SHOW_CAPACITY ? ` · ${fmt(list.reduce((s, c) => s + (c.out ? 0 : c.avail || 0), 0) / 1000, 1)} MW available` : '';
    $('gr-count').textContent = list.length ? `${list.length} circuit${list.length === 1 ? '' : 's'}${mw}` : 'No circuits';
    if (!list.length) return empty('No circuits in this area.');
    $('gr-rows').innerHTML = list.map(c => `<tr data-c="${_esc(c.code)}" class="${selected === c.code ? 'is-sel' : ''}">
        <td><i class="cp-gr-dot" style="background:${colorOf(c)}"></i>${_esc(c.code)}</td>
        <td title="${_esc(c.subName)}">${_esc(c.sub || '')}${c.subName ? ' · ' + _esc(c.subName) : ''}</td>
        <td>${_esc(c.division || '—')}</td><td>${fmt(c.kv, 1)}</td>
        ${SHOW_CAPACITY ? `<td>${c.out ? 'Out' : fmt(c.avail / 1000, 2)}</td><td>${c.pct == null ? '—' : fmt(c.pct) + '%'}</td>` : ''}
        <td>${fmt(c.near, 2)}</td></tr>`).join('');
  }

  function select(code, fit, at) {
    const c = data && data.list.find(x => x.code === code); if (!c) return;
    selected = code;
    for (const x of data.list) x.layers.forEach(l => l.setStyle({ ...l.options.base, opacity: x === c ? 1 : .35 }));
    c.layers.forEach(l => { l.setStyle({ color: INK, weight: 4.5 }); l.bringToFront(); });
    const cap = SHOW_CAPACITY ? `Total capacity: ${fmt(c.total / 1000, 2)} MW<br>Installed DG: ${fmt(c.inst / 1000, 2)} MW<br>
      Available: <b>${c.out ? 'out of service' : fmt(c.avail / 1000, 2) + ' MW'}</b>${c.pct == null ? '' : ' (' + fmt(c.pct) + '%)'}<br>
      CRE limit per project: ${fmt(c.cre)} kW<br>` : '';
    const html = `<div class="cp-gr-pop"><b>${_esc(c.code)}</b><br>
      Substation: ${_esc(c.sub || '—')}${c.subName ? ' · ' + _esc(c.subName) : ''}<br>
      Zone: ${_esc(c.division || '—')}<br>
      Voltage: ${c.kv ? fmt(c.kv, 1) + ' kV' : '—'}<br>
      ${cap}Nearest line: <b>${fmt(c.near, 2)} km</b></div>`;
    const b = L.latLngBounds(c.layers.flatMap(l => l.getLatLngs().flat(2)));
    L.popup({ maxWidth: 280 }).setLatLng(at || b.getCenter()).setContent(html).openOn(map);
    if (fit) map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    map.once('popupclose', () => { if (selected !== code) return; clearSel(); });
    rows();
  }

  function clearSel() {
    selected = null;
    if (data) for (const x of data.list) x.layers.forEach(l => l.setStyle(l.options.base));
    if (mode === 'dist' && data) rows();
  }

  /* ── Transmission and Natural Gas (national packs from /capa) ── */
  const _packLoads = {};
  function ensurePack(m) {
    if (packs[m]) return Promise.resolve(packs[m]);
    return _packLoads[m] || (_packLoads[m] = (async () => {
      const r = await post('/capa', { name: m === 'tx' ? 'transmision' : 'gas' });
      if (!r.ok) { let t = ''; try { t = (await r.json()).message; } catch {} throw new Error(t || 'This map layer is temporarily unavailable.'); }
      const pack = JSON.parse(await gunzip(new Uint8Array(await r.arrayBuffer())));
      packs[m] = buildPack(m, pack);
      return packs[m];
    })().finally(() => { delete _packLoads[m]; }));
  }

  // Decode a pack into features (with bounding boxes for the nearby search) and Leaflet layers per toggle key
  function buildPack(m, pack) {
    const q = pack.q || Q, feats = [], sub = {}, group = L.layerGroup();
    const layerFor = key => sub[key] || (sub[key] = L.layerGroup().addTo(group));
    const decode = arr => { const pts = []; let x = arr[0], y = arr[1]; pts.push([y / q, x / q]);
      for (let i = 2; i < arr.length; i += 2) { x += arr[i]; y += arr[i + 1]; pts.push([y / q, x / q]); } return pts; };
    const add = f => {
      f.id = feats.length; feats.push(f);
      if (f.pts) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
        for (const ln of f.pts) for (const [la, lo] of ln) { if (la < a) a = la; if (la > b) b = la; if (lo < c) c = lo; if (lo > d) d = lo; }
        f.bbox = [a, b, c, d]; }
      f.layer._fid = f.id;
      f.layer.on('click', ev => { L.DomEvent.stopPropagation(ev); focusFeat(f.id, false, ev.latlng); }).addTo(layerFor(f.key));
    };
    for (const [lk, lay] of Object.entries(pack.layers)) {
      for (const [p, ...parts] of lay.lines || []) {
        const pts = parts.map(decode);
        let key, style;
        if (m === 'tx') { const k = kvClass(p.kv); key = k.key; style = { color: k.color, weight: k.min >= 400 ? 2.6 : k.min >= 230 ? 2.2 : 1.6 }; }
        else { key = lk; const g = GAS[lk]; const planned = lk === 'priv' && !/operaci/i.test(p.status || '');
          style = { color: g.color, weight: g.weight, dashArray: planned ? '6 5' : null }; }
        const layer = L.polyline(pts, { renderer, opacity: .9, ...style, base: { ...style, opacity: .9 } });
        add({ kind: lk, key, p, pts, layer });
      }
      for (const [p, x, y] of lay.points || []) {
        const ll = [y / q, x / q];
        let style;
        if (m === 'tx') { const k = kvClass(p.kv); style = { radius: 4, color: k.color, weight: 2, fillColor: '#fff', fillOpacity: 1 }; }
        else { const live = /operaci/i.test(p.status || ''), dead = /cancel/i.test(p.status || '');
          style = { radius: 7, color: dead ? GREY : GAS.gnl.color, weight: 2, fillColor: live ? GAS.gnl.color : '#fff', fillOpacity: 1, dashArray: live ? null : '3 2' }; }
        const layer = L.circleMarker(ll, { renderer, ...style, base: style }).bindTooltip(_esc(p.name || ''));
        add({ kind: lk, key: m === 'tx' ? 'se' : 'gnl', p, ll, layer });
      }
    }
    // Points above lines
    for (const k of ['se', 'gnl']) if (sub[k]) { group.removeLayer(sub[k]); sub[k].addTo(group); }
    return { feats, group, sub, on: new Set(Object.keys(sub)), updated: pack.updated || '' };
  }

  // Substations stay small in the national view and grow as the map zooms in
  function scaleSubs() {
    const pk = packs.tx; if (!pk || !pk.sub.se || !map) return;
    const z = map.getZoom(), radius = z <= 6 ? 2 : z <= 8 ? 3 : z <= 10 ? 4 : 5, weight = z <= 6 ? 1 : 2;
    pk.sub.se.eachLayer(l => { const f = pk.feats[l._fid]; f.layer.options.base = { ...f.layer.options.base, radius, weight };
      if (focused !== f.id) l.setStyle({ radius, weight }); });
  }

  function toggleLayer(key) {
    const pk = packs[mode]; if (!pk || !pk.sub[key]) return;
    if (pk.on.has(key)) { pk.on.delete(key); pk.group.removeLayer(pk.sub[key]); }
    else { pk.on.add(key); pk.sub[key].addTo(pk.group); for (const k of ['se', 'gnl']) if (k !== key && pk.on.has(k)) pk.sub[k].eachLayer(l => l.bringToFront()); }
    legend();
    if (point) nearby();
  }

  // Shortest distance from the point to a polyline (km), in a local flat projection
  function lineDist(lat0, lon0, pts) {
    const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 111.32;
    let best = Infinity;
    for (const ln of pts) {
      let px = (ln[0][1] - lon0) * kx, py = (ln[0][0] - lat0) * ky;
      if (ln.length === 1) best = Math.min(best, Math.hypot(px, py));
      for (let i = 1; i < ln.length; i++) {
        const qx = (ln[i][1] - lon0) * kx, qy = (ln[i][0] - lat0) * ky, dx = qx - px, dy = qy - py, l2 = dx * dx + dy * dy;
        let t = l2 ? -(px * dx + py * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px + t * dx, py + t * dy); if (d < best) best = d;
        px = qx; py = qy;
      }
    }
    return best;
  }

  function nearby() {
    const pk = packs[mode]; if (!pk || !point) return;
    unfocus();
    const { lat, lon, km } = point, dLat = km / 111.32, dLon = km / (111.32 * Math.cos(lat * Math.PI / 180));
    near = [];
    for (const f of pk.feats) {
      if (!pk.on.has(f.key)) continue;
      let d;
      if (f.ll) d = distKm(lat, lon, f.ll[0], f.ll[1]);
      else { const [a, b, c, e] = f.bbox; if (a > lat + dLat || b < lat - dLat || c > lon + dLon || e < lon - dLon) continue; d = lineDist(lat, lon, f.pts); }
      if (d <= km) near.push({ f, d });
    }
    near.sort((x, y) => x.d - y.d);
    nearRows();
    const lines = near.filter(r => r.f.pts).length, pts = near.length - lines;
    const what = mode === 'tx' ? `${lines} line${lines === 1 ? '' : 's'} and ${pts} substation${pts === 1 ? '' : 's'}`
      : `${lines} pipeline${lines === 1 ? '' : 's'}${pts ? ` and ${pts} LNG terminal${pts === 1 ? '' : 's'}` : ''}`;
    msg(near.length ? `<b>${what}</b> within ${km} km of ${where()}. Click a row or the map for details.`
      : `Nothing within ${km} km of ${where()}. Try a larger radius.`);
  }

  // Row cells per feature: [name, second column, kV / diameter]; anything not yet operating says so in its name
  function cellsOf(f) {
    const p = f.p, tag = s => /operaci|operating/i.test(s || '') ? '' : ` (${status(s).toLowerCase()})`;
    if (mode === 'tx') return f.pts ? [p.name || 'Transmission line', 'Line', fmt(p.kv)] : [(p.name || 'Substation') + tag(p.status), 'Substation', fmt(p.kv)];
    if (f.kind === 'sng') return ['SISTRANGAS pipeline', GAS.sng.system, p.diam ? p.diam + '"' : '—'];
    if (f.kind === 'priv') return [(p.name || 'Private pipeline') + tag(p.status), GAS.priv.system, p.diam || '—'];
    if (f.kind === 'usa') return [p.operator || 'US pipeline', GAS.usa.system, '—'];
    return [(p.name || 'LNG terminal') + tag(p.status), GAS.gnl.system, '—'];
  }
  const status = s => ({ 'en operación': 'In operation', 'en operacion': 'In operation', 'en construcción': 'Under construction', 'en proyecto': 'Project', 'cancelado': 'Cancelled', 'operating': 'In operation' }[String(s || '').toLowerCase()] || s || '—');
  const colorFeat = f => f.layer.options.base.color;

  function nearRows() {
    const lines = near.filter(r => r.f.pts).length, pts = near.length - lines;
    $('gr-count').textContent = near.length ? (mode === 'tx' ? `${lines} lines · ${pts} substations` : `${lines} pipelines${pts ? ` · ${pts} LNG terminals` : ''}`) : 'Nothing nearby';
    if (!near.length) return empty('Nothing within this radius.');
    $('gr-rows').innerHTML = near.map(({ f, d }) => `<tr data-c="${f.id}" class="${focused === f.id ? 'is-sel' : ''}">
      ${cellsOf(f).map((v, i) => i ? `<td>${_esc(v)}</td>` : `<td title="${_esc(v)}"><i class="cp-gr-dot" style="background:${colorFeat(f)}"></i>${_esc(v)}</td>`).join('')}
      <td>${fmt(d, 2)}</td></tr>`).join('');
  }

  function popupOf(f) {
    const p = f.p, rowsOf = list => list.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${_esc(String(v))}<br>`).join('');
    let title, body;
    if (mode === 'tx' && f.pts) { title = p.name || 'Transmission line'; body = rowsOf([['Voltage', p.kv ? p.kv + ' kV' : ''], ['Description', p.desc], ['Length', p.km != null ? fmt(p.km, 1) + ' km' : '']]); }
    else if (mode === 'tx') { title = p.name || 'Substation'; body = rowsOf([['Voltage', p.kv ? p.kv + ' kV' : ''], ['Status', status(p.status)], ['Location', [p.mun, p.state].filter(Boolean).join(', ')]]); }
    else if (f.kind === 'sng') { title = 'SISTRANGAS pipeline'; body = rowsOf([['Diameter', p.diam ? p.diam + '"' : '']]); }
    else if (f.kind === 'priv') { title = p.name || 'Private pipeline'; body = rowsOf([['Company', p.company], ['Parent', p.parent], ['Status', status(p.status)], ['Diameter', p.diam], ['Length', p.km != null ? fmt(p.km) + ' km' : ''], ['In operation since', p.year], ['Part of SISTRANGAS', p.sistrangas ? 'Yes' : '']]); }
    else if (f.kind === 'usa') { title = p.operator || 'US pipeline'; body = rowsOf([['Type', p.type], ['Status', status(p.status)]]); }
    else { title = p.name || 'LNG terminal'; body = rowsOf([['Company', p.company], ['Parent', p.parent], ['Status', status(p.status)], ['Type', [p.kind, p.kind2].filter(Boolean).join(' · ')], ['Flow', p.flow], ['Location', [p.city, p.state].filter(Boolean).join(', ')], ['Start of operation', p.year]]); }
    const hit = point && near.find(r => r.f === f);
    const dist = point ? `Distance: <b>${fmt(hit ? hit.d : (f.ll ? distKm(point.lat, point.lon, f.ll[0], f.ll[1]) : lineDist(point.lat, point.lon, f.pts)), 2)} km</b>` : '';
    return `<div class="cp-gr-pop"><b>${_esc(title)}</b><br>${body}${dist}</div>`;
  }

  let focused = null;
  function focusFeat(id, fit, at) {
    const pk = packs[mode], f = pk && pk.feats[id]; if (!f) return;
    unfocus(); focused = id;
    if (f.pts) { f.layer.setStyle({ color: INK, weight: 4.5, opacity: 1 }); f.layer.bringToFront(); }
    else f.layer.setStyle({ color: INK, weight: 3, radius: (f.layer.options.base.radius || 5) + 3 });
    const b = f.pts ? f.layer.getBounds() : L.latLngBounds([f.ll, f.ll]);
    L.popup({ maxWidth: 300 }).setLatLng(at || (f.ll || b.getCenter())).setContent(popupOf(f)).openOn(map);
    if (fit) f.pts ? map.fitBounds(b, { padding: [30, 30], maxZoom: 14 }) : map.setView(f.ll, Math.max(map.getZoom(), 12));
    map.once('popupclose', () => { if (focused === id) { unfocus(); if (point) nearRows(); } });
    if (point) nearRows();
  }
  function unfocus() {
    const pk = packs[mode], f = pk && focused != null && pk.feats[focused];
    if (f) f.layer.setStyle(f.layer.options.base);
    focused = null;
  }

  /* ── Generation: power plants overlay (Power section) ── */
  const genVisible = () => genOn;
  const gasMode = () => mode === 'gas' && !!packs.gas;
  async function applyGen() {
    const vis = genVisible();
    $('gr-plants').hidden = !vis; $('gr-right').classList.toggle('has-plants', vis); legend();
    if (!map) return;
    if (!vis) { if (gen && map.hasLayer(gen.group)) { map.removeLayer(gen.group); if (genFocus != null) map.closePopup(); } return; }
    try { await ensureGen(); } catch (e) { $('gr-gcount').textContent = e.message; $('gr-gcount').classList.add('cp-gr-err'); return; }
    if (!genVisible()) return;
    $('gr-gcount').classList.remove('cp-gr-err');
    gen.group.addTo(map); genFilters(); filterGen();
  }

  let _genLoad = null;
  function ensureGen() {
    if (gen) return Promise.resolve(gen);
    return _genLoad || (_genLoad = (async () => {
      const r = await post('/capa', { name: 'generacion' });
      if (!r.ok) { let t = ''; try { t = (await r.json()).message; } catch {} throw new Error(t || 'The power plant layer is temporarily unavailable.'); }
      const pack = JSON.parse(await gunzip(new Uint8Array(await r.arrayBuffer())));
      // Plants draw on their own canvas above every network layer
      if (!map.getPane('plants')) map.createPane('plants').style.zIndex = 450;
      const rend = L.canvas({ pane: 'plants', padding: 0.3, tolerance: 4 }), group = L.layerGroup();
      const plants = pack.plants.map((p, id) => {
        const layer = L.circleMarker([p.lat, p.lon], { renderer: rend, pane: 'plants' })
          .on('click', ev => { L.DomEvent.stopPropagation(ev); focusPlant(id, false); });
        layer.bindTooltip(_esc(p.name));
        return { ...p, id, layer, shown: [], mw: 0 };
      });
      const opts = k => [...new Set(plants.flatMap(p => p.units.map(u => u[k])))].filter(Boolean).sort();
      gen = { plants, group, source: pack.source || '',
        opt: { tech: opts('tech'), fuel: opts('fuel'), status: GEN_STATUS.map(x => x.key).filter(k => plants.some(p => p.units.some(u => u.status === k))),
          state: [...new Set(plants.map(p => p.state))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es')) } };
      genFilters(); filterGen();
      return gen;
    })().finally(() => { _genLoad = null; }));
  }

  function genFilters() {
    const sel = (k, label, list) => `<label class="cp-pr-f"><span>${label}</span><select data-f="${k}"><option value="">All</option>${list.map(v => `<option ${genF[k] === v ? 'selected' : ''}>${_esc(v)}</option>`).join('')}</select></label>`;
    $('gr-gfilters').innerHTML = `
      <label class="cp-pr-f cp-gr-fq"><span>Plant or company</span><input type="search" data-f="q" value="${_esc(genF.q)}" placeholder="Name, owner, city"></label>
      <label class="cp-pr-f"><span>Min MW</span><input type="number" inputmode="decimal" min="0" data-f="min" value="${_esc(genF.min)}"></label>
      <label class="cp-pr-f"><span>Max MW</span><input type="number" inputmode="decimal" min="0" data-f="max" value="${_esc(genF.max)}"></label>
      ${sel('tech', 'Technology', gen.opt.tech)}${sel('status', 'Status', gen.opt.status)}
      ${sel('fuel', 'Fuel', gen.opt.fuel)}${sel('state', 'State', gen.opt.state)}
      ${sel('acc', 'Location', ['Exact', 'Approximate'])}
      ${gasMode() ? `<label class="cp-pr-f"><span>Pipeline within</span><select data-f="pipe"><option value="">Any</option>${PIPE_KM.map(k => `<option value="${k}" ${String(genF.pipe) === String(k) ? 'selected' : ''}>${k} km</option>`).join('')}</select></label>` : ''}`;
    $('gr-gfilters').querySelectorAll('[data-f]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => { genF[el.dataset.f] = el.value; filterGen(); }));
  }

  // A plant shows when any of its units passes the unit filters; its MW is the sum of those units
  function filterGen() {
    if (!gen) return;
    const f = genF, q = f.q.trim().toLowerCase(), min = f.min === '' ? null : Number(f.min), max = f.max === '' ? null : Number(f.max);
    for (const p of gen.plants) {
      const placeOk = (!f.state || p.state === f.state) && (!f.acc || (f.acc === 'Exact') === p.exact) &&
        (!q || [p.name, p.local, p.other, p.owner, p.parent, p.operator, p.city, p.state].some(v => (v || '').toLowerCase().includes(q)));
      p.shown = placeOk ? p.units.filter(u => (!f.tech || u.tech === f.tech) && (!f.status || u.status === f.status) && (!f.fuel || u.fuel === f.fuel)) : [];
      p.mw = p.shown.reduce((a, u) => a + (u.mw || 0), 0);
      if (p.shown.length && ((min != null && p.mw < min) || (max != null && p.mw > max))) p.shown = [];
      if (p.shown.length && f.pipe && gasMode()) { const np = nearestPipe(p); if (!np || np.d > Number(f.pipe)) p.shown = []; }
      // Plant status: the most advanced among the shown units (any operating unit makes it Operating)
      p.status = (GEN_PRIORITY.find(k => p.shown.some(u => u.status === k)) || (p.shown[0] && p.shown[0].status)) || '';
      const color = genColor(p.status), radius = 4 + Math.min(10, Math.sqrt(p.mw || 0) / 3.2);
      const style = p.exact ? { radius, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: .95 }
        : { radius, color, weight: 2, fillColor: color, fillOpacity: .28, dashArray: null };
      p.layer.setStyle(style); p.layer.options.base = style;
      const on = p.shown.length > 0;
      if (on && !gen.group.hasLayer(p.layer)) gen.group.addLayer(p.layer);
      if (!on && gen.group.hasLayer(p.layer)) { gen.group.removeLayer(p.layer); if (genFocus === p.id) map.closePopup(); }
    }
    genRows();
  }

  function genRows() {
    if (!gen) return;
    const list = gen.plants.filter(p => p.shown.length);
    for (const p of list) p.d = point ? distKm(point.lat, point.lon, p.lat, p.lon) : null;
    list.sort(point ? (a, b) => a.d - b.d : (a, b) => b.mw - a.mw);
    const mw = list.reduce((a, p) => a + p.mw, 0);
    $('gr-gcount').textContent = `${list.length} plant${list.length === 1 ? '' : 's'} · ${fmt(mw)} MW${point ? ' · sorted by distance' : ''}`;
    const gas = gasMode();
    const cols = ['Plant', 'State', 'Technology', 'MW', 'Status'].concat(gas ? ['Nearest pipeline', 'Pipe km'] : [], point ? ['Dist. km'] : []);
    $('gr-ghead').innerHTML = `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
    if (!list.length) { $('gr-grows').innerHTML = `<tr><td colspan="${cols.length}" class="cp-gr-empty">No plants match these filters.</td></tr>`; return; }
    const techOf = p => { const t = [...new Set(p.shown.map(u => u.tech))]; return t.length > 1 ? 'Mixed' : t[0]; };
    $('gr-grows').innerHTML = list.map(p => `<tr data-g="${p.id}" class="${genFocus === p.id ? 'is-sel' : ''}">
      <td title="${_esc(p.name)}"><i class="cp-gr-dot ${p.exact ? '' : 'cp-gr-dot--approx'}" style="--c:${genColor(p.status)}"></i>${_esc(p.name)}</td>
      <td>${_esc(p.state || '—')}</td><td>${_esc(techOf(p) || '—')}</td><td>${fmt(p.mw)}</td><td>${_esc(p.status)}</td>
      ${gas ? (np => np ? `<td title="${_esc(pipeName(np.f))}">${_esc(pipeName(np.f))}</td><td>${fmt(np.d, 1)}</td>` : `<td>None within ${PIPE_MAX} km</td><td>—</td>`)(nearestPipe(p)) : ''}
      ${point ? `<td>${fmt(p.d, 1)}</td>` : ''}</tr>`).join('');
  }

  // Nearest pipeline to a plant (any gas line layer), searched within PIPE_MAX km; cached per plant
  const PIPE_MAX = 50;
  function nearestPipe(p) {
    const pk = packs.gas; if (!pk) return null;
    if (p.pipe !== undefined) return p.pipe;
    const dLat = PIPE_MAX / 111.32, dLon = PIPE_MAX / (111.32 * Math.cos(p.lat * Math.PI / 180));
    let best = null;
    for (const f of pk.feats) {
      if (!f.pts) continue;
      const [a, b, c, e] = f.bbox;
      if (a > p.lat + dLat || b < p.lat - dLat || c > p.lon + dLon || e < p.lon - dLon) continue;
      const d = lineDist(p.lat, p.lon, f.pts);
      if (d <= PIPE_MAX && (!best || d < best.d)) best = { d, f };
    }
    return (p.pipe = best);
  }
  function pipeName(f) {
    const p = f.p;
    if (f.kind === 'sng') return 'SISTRANGAS' + (p.diam ? ' ' + p.diam + '"' : '');
    if (f.kind === 'priv') return p.name || 'Private pipeline';
    return (p.operator || 'US pipeline') + ' (US)';
  }

  function focusPlant(id, fit) {
    const p = gen && gen.plants[id]; if (!p) return;
    unfocusPlant(); genFocus = id;
    p.layer.setStyle({ color: INK, weight: 3 }); p.layer.bringToFront();
    // In Natural Gas, highlight the pipeline that reaches it
    const np = gasMode() && nearestPipe(p);
    if (np) { genPipe = np.f; np.f.layer.setStyle({ color: INK, weight: 4.5, opacity: 1 }); np.f.layer.bringToFront(); }
    const yrs = [...new Set(p.shown.map(u => u.start).filter(Boolean))].sort();
    const units = p.shown.map(u => `<tr><td>${_esc(u.unit || '—')}</td><td>${fmt(u.mw)}</td><td>${_esc(u.tech)}</td><td>${_esc(u.status)}</td><td>${u.start || '—'}</td></tr>`).join('');
    const line = (k, v) => v ? `${k}: ${_esc(String(v))}<br>` : '';
    const html = `<div class="cp-gr-pop"><b>${_esc(p.name)}</b>${p.other ? ` <span class="cp-gr-pop-alt">(${_esc(p.other)})</span>` : ''}<br>
      Capacity: <b>${fmt(p.mw)} MW</b>${p.shown.length < p.units.length ? ` of ${fmt(p.units.reduce((a, u) => a + (u.mw || 0), 0))} MW (filtered)` : ''}<br>
      ${line('Status', p.status)}${line('Fuel', [...new Set(p.shown.map(u => u.fuel))].join(', '))}
      ${line('Start', yrs.length ? (yrs.length > 1 ? yrs[0] + '–' + yrs[yrs.length - 1] : yrs[0]) : '')}
      ${line('Owner', p.owner)}${p.parent && p.parent !== p.owner ? line('Parent', p.parent) : ''}${line('Operator', p.operator)}
      ${line('Location', [p.city, p.state].filter(Boolean).join(', ') + (p.exact ? '' : ' (approximate)'))}
      ${packs.gas ? (np => np ? `Nearest pipeline: <b>${_esc(pipeName(np.f))}</b>, ${fmt(np.d, 1)} km<br>` : `No pipeline within ${PIPE_MAX} km<br>`)(nearestPipe(p)) : ''}
      ${point ? `Distance: <b>${fmt(distKm(point.lat, point.lon, p.lat, p.lon), 1)} km</b><br>` : ''}
      <table class="cp-gr-units"><tr><th>Unit</th><th>MW</th><th>Technology</th><th>Status</th><th>Start</th></tr>${units}</table></div>`;
    L.popup({ maxWidth: 360 }).setLatLng([p.lat, p.lon]).setContent(html).openOn(map);
    if (fit) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 10));
    map.once('popupclose', () => { if (genFocus === id) { unfocusPlant(); genRows(); } });
    genRows();
  }
  function unfocusPlant() {
    const p = gen && genFocus != null && gen.plants[genFocus];
    if (p) p.layer.setStyle(p.layer.options.base);
    if (genPipe) { genPipe.layer.setStyle(genPipe.layer.options.base); genPipe = null; }
    genFocus = null;
  }

  return { init, show };
})();
