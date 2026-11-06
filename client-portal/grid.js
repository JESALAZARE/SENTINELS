/* ── Sentinels Client Portal · Grid Map ──────────────────────────────
   CFE medium-voltage distribution lines around a point the user types
   (an address or place found with Esri's geocoder through the Worker, or
   latitude, longitude) with each circuit's distributed-generation hosting
   capacity. The national grid is private: it sits in Cloudflare R2 behind
   the Sentinel One Worker, which checks the client's signed pass (ME.ai)
   and returns only the 0.1° cells around the point (gzip JSON each, see
   the Worker's gridArea). Leaflet is loaded on first use, pinned with SRI.
   Hosting capacity figures are kept in the data (they drive the line
   colours) but hidden from the page while SHOW_CAPACITY is false.
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
  const RADII = [1, 2, 5, 10, 15], CELL = 0.1, Q = 1e5;
  // Capacity figures (MW, %, CRE limit) stay hidden; set to true to show them again
  const SHOW_CAPACITY = false;
  const COLS = SHOW_CAPACITY ? 7 : 5;
  // Colour by share of hosting capacity still available
  const BANDS = [
    { min: 50, color: '#1F9D55', label: '≥ 50% available' },
    { min: 20, color: '#D69E2E', label: '20–50%' },
    { min: 0, color: '#C53030', label: '< 20%' }
  ];
  const GREY = '#8A94A0', NODATA = '#5B7DB1';

  const cfg = () => (typeof ME !== 'undefined' && ME && ME.ai && ME.ai.enabled && ME.ai.url && ME.ai.token) ? ME.ai : null;
  const $ = id => document.getElementById(id);
  const fmt = (v, d = 0) => v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('sp_grid_' + MY_ID)) || {}; } catch { return {}; } },
    set(v) { try { localStorage.setItem('sp_grid_' + MY_ID, JSON.stringify(v)); } catch {} }
  };

  let L = null, _leaflet = null, map = null, base = null, layers = null, renderer = null;
  let data = null, selected = null, built = false, busy = false, baseKind = 'map';
  let sugs = [], sugActive = -1, picked = null, sugTimer = 0, sugSeq = 0;

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

  function build() {
    const last = store.get();
    $('grid-root').innerHTML = `
      <div class="cp-card cp-gr-card">
        <form class="cp-pr-row" id="gr-form" autocomplete="off">
          <div class="cp-pr-f cp-gr-coord"><label for="gr-coord"><span>Address, place or coordinates</span></label>
            <div class="cp-gr-search">
              <input id="gr-coord" type="search" enterkeyhint="search" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="gr-sug"
                placeholder="Parque Industrial Stiva, Apodaca · 25.6866, -100.3161" value="${_esc(last.coord || '')}">
              <ul class="cp-gr-sug" id="gr-sug" role="listbox" hidden></ul>
            </div></div>
          <label class="cp-pr-f"><span>Radius</span>
            <select id="gr-km">${RADII.map(k => `<option value="${k}" ${k === (last.km || 5) ? 'selected' : ''}>${k} km</option>`).join('')}</select></label>
          <button type="submit" class="cp-btn-dark cp-gr-go" id="gr-go">Load area</button>
          <button type="button" class="cp-pr-dl cp-gr-loc" id="gr-loc" title="Use this device's location">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>My location</button>
          <button type="button" class="cp-pr-dl cp-gr-clear" id="gr-clear" title="Clear the search, the map and the table">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>Clear</button>
        </form>
        <div class="cp-pr-note cp-gr-hint" id="gr-msg">Search an address, industrial park or company, or type coordinates (you can paste a Google Maps link), and choose a radius. You can also click the map to pick a point.</div>
      </div>
      <div class="cp-gr-main">
        <div class="cp-card cp-gr-mapcard">
          <div class="cp-gr-map" id="gr-map"></div>
          <div class="cp-gr-legend" id="gr-legend">
            ${BANDS.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('')}
            <span><i style="background:${GREY}"></i>Out of service</span><span><i style="background:${NODATA}"></i>No data</span>
            <span><i class="cp-gr-dash"></i>Underground</span><span><i class="cp-gr-sub"></i>Substation</span>
            <button type="button" class="cp-pr-dl cp-gr-base" id="gr-base">Satellite</button>
          </div>
        </div>
        <div class="cp-card cp-gr-side">
          <div class="cp-gr-sidehead">
            <div><div class="cp-widget-title">Nearby circuits</div><div class="cp-pr-note" id="gr-count">—</div></div>
          </div>
          <div class="cp-pr-scroll cp-gr-scroll"><table class="cp-mini-table cp-gr-table">
            <thead><tr><th>Circuit</th><th>Substation</th><th>Zone</th><th>kV</th>${SHOW_CAPACITY ? '<th>Avail. MW</th><th>Avail.</th>' : ''}<th>Nearest line km</th></tr></thead>
            <tbody id="gr-rows"><tr><td colspan="${COLS}" class="cp-gr-empty">Load an area to see its circuits.</td></tr></tbody>
          </table></div>
        </div>
      </div>`;
    $('gr-form').addEventListener('submit', e => { e.preventDefault(); if (sugActive >= 0) pick(sugActive); else { hideSug(); load(); } });
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
    $('gr-rows').addEventListener('click', e => { const tr = e.target.closest('tr[data-c]'); if (tr) select(tr.dataset.c, true); });
    built = true;
  }

  async function show() {
    if (!built) build();
    try { await loadLeaflet(); } catch { msg('The map library could not be loaded. Check your connection and reload the page.', true); return; }
    if (!map) {
      renderer = L.canvas({ padding: 0.3, tolerance: 6 });
      map = L.map('gr-map', { preferCanvas: true, zoomControl: true, attributionControl: true }).setView([23.6, -102.5], 5);
      setBase('map');
      layers = L.layerGroup().addTo(map);
      map.on('click', e => {
        if (busy) return;
        $('gr-coord').value = e.latlng.lat.toFixed(6) + ', ' + e.latlng.lng.toFixed(6); picked = null; hideSug();
        msg('Point selected. Press <b>Load area</b> to see the circuits around it.');
      });
      if (store.get().coord) load();
    }
    setTimeout(() => map.invalidateSize(), 0);
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
    store.set({ km: Number($('gr-km').value) });
    data = null; selected = null;
    if (map) { map.closePopup(); layers.clearLayers(); map.setView([23.6, -102.5], 5); }
    $('gr-rows').innerHTML = `<tr><td colspan="${COLS}" class="cp-gr-empty">Load an area to see its circuits.</td></tr>`;
    $('gr-count').textContent = '—';
    msg('Search an address, industrial park or company, or type coordinates, and choose a radius.');
    $('gr-coord').focus();
  }

  /* ── Address search (Esri, through the Worker) ── */
  const post = (path, body) => { const c = cfg();
    return fetch(c.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: MY_ID, token: c.token, ...body }) }); };
  // Bias results toward what the map shows once it has a point
  const near = () => data ? { lat: data.lat, lon: data.lon } : {};

  async function suggest() {
    const text = $('gr-coord').value.trim(), seq = ++sugSeq;
    if (!cfg() || text.length < 3 || parse(text)) { hideSug(); return; }
    try {
      const r = await post('/geo/suggest', { text, ...near() });
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
    const r = await post('/geo/find', { text, magicKey: picked && picked.text === text ? picked.magicKey : undefined, ...near() });
    const d = await r.json().catch(() => ({}));
    if (r.status === 503) throw new Error('Address search is not enabled yet. Type the coordinates as latitude, longitude.');
    if (!r.ok) throw new Error(d.message || 'Address search is temporarily unavailable.');
    if (!(d.lat >= 14 && d.lat <= 33.5 && d.lon >= -118.5 && d.lon <= -86)) throw new Error('That place is outside Mexico.');
    return { lat: d.lat, lon: d.lon, label: d.label || text };
  }

  /* ── Data ─────────────────────────────────────── */
  async function fetchArea(lat, lon, km) {
    const r = await post('/red', { lat, lon, km });
    if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch {} throw new Error(m || 'The grid map is temporarily unavailable.'); }
    const buf = new Uint8Array(await r.arrayBuffer()), dv = new DataView(buf.buffer), cells = [];
    for (let o = 0; o + 4 <= buf.length;) {
      const n = dv.getUint32(o); o += 4;
      const text = await new Response(new Blob([buf.subarray(o, o + n)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      cells.push(JSON.parse(text)); o += n;
    }
    return { cells, updated: r.headers.get('X-Grid-Updated') || '' };
  }

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
        const pts = []; let x = s[2], y = s[3], near = Infinity;
        for (let k = 2; k < s.length; k += 2) {
          if (k > 2) { x += s[k]; y += s[k + 1]; }
          const la = y / Q, lo = x / Q; pts.push([la, lo]);
          const d = distKm(lat, lon, la, lo); if (d < near) near = d;
        }
        if (near > km) continue;
        const c = circ.get(code) || circ.set(code, { info, near: Infinity, lines: [[], [], [], []] }).get(code);
        c.lines[s[1]].push(pts);  // flag: 1 underground, 2 trunk
        if (near < c.near) c.near = near;
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

  async function load() {
    if (busy) return;
    if (!cfg()) { msg('The grid map is not enabled for your account. Contact your Sentinel advisor.', true); return; }
    const text = $('gr-coord').value.trim(), km = Number($('gr-km').value);
    if (!text) { msg('Search an address or place, or type coordinates as <b>latitude, longitude</b>, e.g. 25.6866, -100.3161.', true); return; }
    store.set({ coord: text, km });
    busy = true; $('gr-go').disabled = true; $('gr-go').textContent = 'Loading…';
    msg(parse(text) ? `Loading the grid within ${km} km…` : 'Finding the place…');
    try {
      const p = await resolve(text);
      if (p.label) msg(`Loading the grid within ${km} km of <b>${_esc(p.label)}</b>…`);
      const { cells, updated } = await fetchArea(p.lat, p.lon, km);
      data = { ...assemble(cells, p.lat, p.lon, km), lat: p.lat, lon: p.lon, km, updated, label: p.label };
      draw();
      const n = data.list.length, where = p.label ? `<b>${_esc(p.label)}</b> (${p.lat.toFixed(5)}, ${p.lon.toFixed(5)})` : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      msg(n ? `<b>${n}</b> circuit${n === 1 ? '' : 's'} within ${km} km of ${where}. Click a line or a row to highlight its circuit.`
        : `No CFE medium-voltage lines within ${km} km of this point. Try a larger radius.`);
    } catch (e) {
      msg(_esc(e.message || 'The grid map could not be loaded.'), true);
    } finally {
      busy = false; $('gr-go').disabled = false; $('gr-go').textContent = 'Load area';
    }
  }

  /* ── Drawing ──────────────────────────────────── */
  function draw() {
    layers.clearLayers(); selected = null;
    const { lat, lon, km } = data;
    L.circle([lat, lon], { radius: km * 1000, renderer, color: '#0F1B2D', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(layers);
    for (const c of data.list) {
      const color = colorOf(c);
      c.layers = c.lines.map((ls, flag) => ls.length ? L.polyline(ls, {
        renderer, color, weight: flag & 2 ? 3.2 : 2, opacity: .9, dashArray: flag & 1 ? '5 4' : null, base: { color, weight: flag & 2 ? 3.2 : 2, opacity: .9 }
      }).on('click', ev => { L.DomEvent.stopPropagation(ev); select(c.code, false, ev.latlng); }).addTo(layers) : null).filter(Boolean);
    }
    for (const s of data.subs) {
      L.circleMarker([s.lat, s.lon], { renderer, radius: 6, color: '#0F1B2D', weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`<b>${_esc(s.code)}</b> ${_esc(s.name || '')}`).addTo(layers);
    }
    L.circleMarker([lat, lon], { renderer, radius: 7, color: '#fff', weight: 2, fillColor: '#0F1B2D', fillOpacity: 1 })
      .bindTooltip(data.label ? _esc(data.label) : 'Selected point').addTo(layers);
    map.fitBounds(L.latLng(lat, lon).toBounds(km * 2000), { padding: [10, 10] });
    rows();
  }

  function rows() {
    const list = data.list;
    const mw = SHOW_CAPACITY ? ` · ${fmt(list.reduce((s, c) => s + (c.out ? 0 : c.avail || 0), 0) / 1000, 1)} MW available` : '';
    $('gr-count').textContent = list.length ? `${list.length} circuit${list.length === 1 ? '' : 's'}${mw}` : 'No circuits';
    $('gr-rows').innerHTML = list.length ? list.map(c => `<tr data-c="${_esc(c.code)}" class="${selected === c.code ? 'is-sel' : ''}">
        <td><i class="cp-gr-dot" style="background:${colorOf(c)}"></i>${_esc(c.code)}</td>
        <td title="${_esc(c.subName)}">${_esc(c.sub || '')}${c.subName ? ' · ' + _esc(c.subName) : ''}</td>
        <td>${_esc(c.division || '—')}</td><td>${fmt(c.kv, 1)}</td>
        ${SHOW_CAPACITY ? `<td>${c.out ? 'Out' : fmt(c.avail / 1000, 2)}</td><td>${c.pct == null ? '—' : fmt(c.pct) + '%'}</td>` : ''}
        <td>${fmt(c.near, 2)}</td></tr>`).join('')
      : `<tr><td colspan="${COLS}" class="cp-gr-empty">No circuits in this area.</td></tr>`;
  }

  function select(code, fit, at) {
    const c = data && data.list.find(x => x.code === code); if (!c) return;
    selected = code;
    for (const x of data.list) x.layers.forEach(l => l.setStyle({ ...l.options.base, opacity: x === c ? 1 : .35 }));
    c.layers.forEach(l => { l.setStyle({ color: '#0F1B2D', weight: 4.5 }); l.bringToFront(); });
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
    for (const x of data.list) x.layers.forEach(l => l.setStyle(l.options.base));
    rows();
  }

  return { init, show };
})();
