/* ── Sentinel One · AI assistant tab ─────────────────────────────────
   Chat with Claude (through the Sentinel One Cloudflare Worker) grounded
   only in this client's portal data. The client can train it (standing
   instructions), it keeps a memory (the model saves facts with a tool, the
   client can add/remove them) and keeps the chat history. All of it is
   encrypted here with the client's data key before it is synced through
   the Worker, which cannot read it.
   Uses globals from index.html: ME, DEK, MY_ID, PORTAL_KEY, INTEL, SP, DATA,
   _esc, _date, _fmtDate, goTo. */
const S1 = (() => {
  const esc = s => _esc(s);
  const MAX_ATTACH = 10 * 1024 * 1024;
  let state = null, current = null, busy = false, abort = null, saveT = null, attach = [], ready = false;
  const cfg = () => (ME && ME.ai && ME.ai.enabled && ME.ai.url && ME.ai.token) ? ME.ai : null;
  const uid = () => SP.hex(SP.rand(8));
  const $ = id => document.getElementById(id);

  /* ── Platform data → plain-text context ───────── */
  const LABELS = {
    company: 'Company', account_id: 'Account number', contact_name: 'Contact name', contact_role: 'Contact role',
    rate: 'Active rate (MXN/kWh)', cfe_rate: 'CFE GDMTH reference rate (MXN/kWh)', savings_monthly: 'Estimated monthly savings (MXN)', ytd_gwh: 'Year-to-date consumption (GWh)',
    contract_id: 'Contract ID', contract_title: 'Contract type', contract_start: 'Contract start', contract_end: 'Contract end',
    counterparty: 'Counterparty', counterparty_note: 'Counterparty note', volume_gwh: 'Annual contracted volume (GWh)', volume_note: 'Volume note',
    base_price: 'Base price (MXN/kWh)', price_note: 'Price note', escalation: 'Price escalation', escalation_note: 'Escalation note',
    mem_portion: 'MEM-indexed portion', mem_note: 'MEM note', billed_label: 'Last billing period', billed_gwh: 'Last billed volume (GWh)', billed_note: 'Billing note',
    renewal_note: 'Renewal note', advisor_name: 'Advisor name', advisor_email: 'Advisor email'
  };
  function buildContext() {
    const p = ME.profile || {}, L = [];
    const field = k => p[k] != null && p[k] !== '' ? `${LABELS[k]}: ${p[k]}` : null;
    const group = (title, keys) => { const rows = keys.map(field).filter(Boolean); if (rows.length) L.push(`## ${title}`, ...rows, ''); };
    group('Client', ['company', 'account_id', 'contact_name', 'contact_role']);
    group('Key figures', ['rate', 'cfe_rate', 'savings_monthly', 'ytd_gwh']);
    const calc = [];
    if (p.rate && p.cfe_rate) calc.push(`Rate below CFE: ${((p.cfe_rate - p.rate) / p.cfe_rate * 100).toFixed(1)}% (${(p.cfe_rate - p.rate).toFixed(3)} MXN/kWh)`);
    if (p.savings_monthly) calc.push(`Estimated annual savings (monthly × 12): ${Math.round(p.savings_monthly * 12).toLocaleString('en-US')} MXN`);
    const s = _date(p.contract_start), e = _date(p.contract_end);
    if (e) calc.push(`Months remaining in contract as of today: ${Math.max(0, Math.round((e - new Date()) / (1000 * 60 * 60 * 24 * 30.44)))}`);
    if (s && e) calc.push(`Contract term elapsed as of today: ${Math.min(100, Math.max(0, (new Date() - s) / (e - s) * 100)).toFixed(0)}%`);
    if (calc.length) L.push('## Values computed by the portal from the data above', ...calc, '');
    group('Contract', ['contract_id', 'contract_title', 'contract_start', 'contract_end', 'counterparty', 'counterparty_note', 'volume_gwh', 'volume_note', 'base_price', 'price_note', 'escalation', 'escalation_note', 'mem_portion', 'mem_note', 'billed_label', 'billed_gwh', 'billed_note', 'renewal_note']);
    group('Advisor', ['advisor_name', 'advisor_email']);
    const pts = (ME.chart || []).filter(x => x && isFinite(x.rate));
    if (pts.length) {
      L.push('## Monthly history', 'Month | Sentinel rate (MXN/kWh) | CFE GDMTH (MXN/kWh) | Consumption (GWh)');
      pts.forEach(x => L.push(`${x.label} | ${x.rate} | ${isFinite(x.cfe) && x.cfe != null ? x.cfe : '—'} | ${isFinite(x.gwh) && x.gwh != null ? x.gwh : '—'}`));
      L.push('');
    }
    const docs = ME.docs || [];
    L.push('## Documents shared with the client (their content is only available when the client attaches them)');
    L.push(...(docs.length ? docs.map(d => `- ${d.name} (${d.type || 'document'}, ${d.date}${d.filename ? ', ' + d.filename : ''})`) : ['(none)']), '');
    L.push('## Market Intelligence updates from the advisory team');
    L.push(...((INTEL || []).length ? INTEL.map(i => `- [${i.date}] [${i.tag || 'Update'}] ${i.title}: ${i.summary || ''}${(i.files || []).length ? ` (attachments: ${i.files.map(f => f.name).join(', ')})` : ''}`) : ['(none)']));
    return L.join('\n');
  }

  /* ── State (encrypted, synced through the Worker) ─ */
  const LOCAL = () => 'sp_s1_' + MY_ID;
  const fresh = () => ({ v: 1, instructions: '', memories: [], chats: [] });
  async function api(path, body, signal) {
    const c = cfg();
    return fetch(c.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: MY_ID, token: c.token, ...body }), signal });
  }
  async function loadState() {
    let box = null;
    try { const r = await api('/state/get', {}); if (r.ok) box = (await r.json()).state; } catch {}
    if (!box) { try { box = JSON.parse(localStorage.getItem(LOCAL())); } catch {} }
    try { state = box ? await SP.openJSON(DEK, box) : fresh(); } catch { state = fresh(); }
    state = Object.assign(fresh(), state);
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      // Keep the synced blob small: at most 40 conversations
      state.chats = state.chats.sort((a, b) => b.updated - a.updated).slice(0, 40);
      const box = await SP.sealJSON(DEK, state);
      try { localStorage.setItem(LOCAL(), JSON.stringify(box)); } catch {}
      try { await api('/state/put', { state: box }); } catch {}
    }, 1200);
  }

  /* ── Markdown (escaped first, then a small safe subset) ── */
  function md(src) {
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    const lines = String(src || '').split('\n'), out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^```/.test(l)) { const buf = []; while (++i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i]); out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const head = row(l); i++;
        const body = [];
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) body.push(row(lines[++i]));
        out.push(`<div class="s1-table"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^#{1,4}\s/.test(l)) { out.push(`<div class="s1-h">${inline(l.replace(/^#+\s/, ''))}</div>`); continue; }
      if (/^\s*[-*•]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
        const ordered = /^\s*\d+[.)]\s+/.test(l), items = [];
        i--;
        while (i + 1 < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i + 1])) items.push(lines[++i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (!l.trim()) { out.push(''); continue; }
      out.push(`<p>${inline(l)}</p>`);
    }
    return out.join('');
  }

  /* ── Rendering ────────────────────────────────── */
  const chat = () => state.chats.find(c => c.id === current);
  const textOf = m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';

  function suggestions() {
    const p = ME.profile || {}, s = [];
    if (p.savings_monthly || (p.rate && p.cfe_rate)) s.push('How much am I saving compared with CFE?');
    if (p.contract_end) s.push('When does my contract end and how far along am I?');
    if ((ME.chart || []).length >= 3) s.push('Summarize how my rate has moved in recent months.');
    if ((INTEL || []).length) s.push('What did the latest market update say?');
    s.push('Give me an executive summary of my account.');
    return s.slice(0, 4);
  }

  function renderLog() {
    const log = $('s1-log'), c = chat();
    if (!c || !c.messages.length) {
      log.innerHTML = `<div class="s1-welcome"><div class="s1-avatar s1-avatar--lg">${SPARK}</div>
        <h2>Hi${ME.profile && ME.profile.contact_name ? ', ' + esc(ME.profile.contact_name.split(' ')[0]) : ''}. I'm Sentinel One.</h2>
        <p>Ask me anything about your contract, rates, savings, documents and market updates. I answer only with the information in your portal.</p>
        <div class="s1-sugs">${suggestions().map(q => `<button class="s1-sug">${esc(q)}</button>`).join('')}</div></div>`;
      log.querySelectorAll('.s1-sug').forEach(b => b.onclick = () => send(b.textContent));
      return;
    }
    log.innerHTML = c.messages.map(renderMsg).join('');
    log.scrollTop = log.scrollHeight;
  }
  function renderMsg(m) {
    if (m.role === 'user') {
      if (Array.isArray(m.content) && m.content.every(b => b.type === 'tool_result')) return '';
      const docs = Array.isArray(m.content) ? m.content.filter(b => b.type === 'doc_ref') : [];
      return `<div class="s1-msg s1-msg--user"><div class="s1-bubble">${docs.map(d => `<span class="s1-chip">📎 ${esc(d.name)}</span>`).join('')}${esc(textOf(m)).replace(/\n/g, '<br>')}</div></div>`;
    }
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const body = blocks.map(b => b.type === 'text' ? md(b.text)
      : b.type === 'tool_use' && b.name === 'save_memory' ? `<div class="s1-note">🧠 Saved to memory: ${esc(b.input && b.input.memory)}</div>` : '').join('');
    return `<div class="s1-msg s1-msg--ai"><div class="s1-avatar">${SPARK}</div><div class="s1-bubble">${body}${m.note ? `<div class="s1-note">${esc(m.note)}</div>` : ''}
      ${blocks.some(b => b.type === 'text' && b.text.trim()) ? `<button class="s1-copy" title="Copy" onclick="S1.copy(this)">Copy</button>` : ''}</div></div>`;
  }

  function renderSide() {
    const chats = state.chats.slice().sort((a, b) => b.updated - a.updated);
    $('s1-chats').innerHTML = chats.length ? chats.map(c => `<div class="s1-chat-item ${c.id === current ? 'on' : ''}" data-id="${c.id}">
        <span>${esc(c.title || 'New conversation')}</span><button title="Delete" data-del="${c.id}">×</button></div>`).join('')
      : '<p class="s1-empty">No conversations yet.</p>';
    $('s1-chats').querySelectorAll('.s1-chat-item').forEach(el => el.onclick = ev => {
      if (ev.target.dataset.del) { removeChat(ev.target.dataset.del); return; }
      current = el.dataset.id; renderSide(); renderLog(); toggleSide(false);
    });
    $('s1-instructions').value = state.instructions || '';
    $('s1-instr-count').textContent = (state.instructions || '').length + ' / 4000';
    const mems = state.memories.slice().sort((a, b) => b.date - a.date);
    $('s1-memories').innerHTML = mems.length ? mems.map(m => `<div class="s1-mem"><div><span>${esc(m.text)}</span><small>${m.by === 'ai' ? 'Saved by Sentinel One' : 'Added by you'} · ${new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small></div><button title="Forget" data-id="${m.id}">×</button></div>`).join('')
      : '<p class="s1-empty">Nothing saved yet. Ask Sentinel One to remember something, or add it here.</p>';
    $('s1-memories').querySelectorAll('button[data-id]').forEach(b => b.onclick = () => { state.memories = state.memories.filter(m => m.id !== b.dataset.id); save(); renderSide(); });
  }
  function setUsage(spent, limit) {
    if (!isFinite(spent) || !isFinite(limit) || !limit) return;
    const pct = Math.min(100, spent / limit * 100);
    $('s1-usage').innerHTML = `<div class="s1-usage-l">Monthly allowance <b>${pct.toFixed(0)}% used</b></div><div class="s1-usage-bar"><i style="width:${pct}%"></i></div>`;
  }

  /* ── Attachments (documents & intelligence files) ─ */
  function attachables() {
    const ok = m => m === 'application/pdf' || /^image\/(png|jpeg|webp|gif)$/.test(m || '');
    const docs = (ME.docs || []).filter(d => ok(d.mime || 'application/pdf')).map(d => ({ kind: 'doc', file: d.file, name: d.name, mime: d.mime || 'application/pdf' }));
    const intel = (INTEL || []).flatMap(i => (i.files || []).filter(f => ok(f.mime)).map(f => ({ kind: 'intel', file: f.file, name: f.name, mime: f.mime })));
    return docs.concat(intel);
  }
  function toggleAttachMenu(show) {
    const menu = $('s1-attach-menu'), list = attachables();
    if (show === false || !menu.hidden) { menu.hidden = true; return; }
    menu.innerHTML = list.length ? list.map((a, i) => `<button type="button" data-i="${i}">${a.mime === 'application/pdf' ? '📄' : '🖼️'} ${esc(a.name)}<small>${a.kind === 'doc' ? 'Document' : 'Market update file'}</small></button>`).join('')
      : '<p class="s1-empty">There are no PDFs or images in your portal yet.</p>';
    menu.querySelectorAll('button').forEach(b => b.onclick = () => {
      const a = list[+b.dataset.i];
      if (!attach.some(x => x.file === a.file)) attach.push(a);
      renderAttach(); menu.hidden = true;
    });
    menu.hidden = false;
  }
  function renderAttach() {
    $('s1-attached').innerHTML = attach.map((a, i) => `<span class="s1-chip">📎 ${esc(a.name)}<button type="button" data-i="${i}" title="Remove">×</button></span>`).join('');
    $('s1-attached').querySelectorAll('button').forEach(b => b.onclick = () => { attach.splice(+b.dataset.i, 1); renderAttach(); });
  }
  async function hydrate(ref) {
    const res = await fetch(DATA + (ref.kind === 'doc' ? 'docs/' : 'intel-files/') + ref.file + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    const bytes = await SP.openFile(ref.kind === 'doc' ? DEK : PORTAL_KEY, await res.arrayBuffer());
    if (bytes.length > MAX_ATTACH) throw new Error('too_large');
    const data = SP.b64(bytes);
    return ref.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: ref.name }
      : { type: 'image', source: { type: 'base64', media_type: ref.mime, data } };
  }

  // History sent to Claude: last ~40 messages, starting at a plain user turn;
  // attachments re-sent only for the most recent turns
  async function requestMessages(c) {
    let msgs = c.messages.slice(-40);
    while (msgs.length && !(msgs[0].role === 'user' && Array.isArray(msgs[0].content) && msgs[0].content.some(b => b.type === 'text'))) msgs = msgs.slice(1);
    const recent = msgs.length - 6;
    const out = [];
    for (const [i, m] of msgs.entries()) {
      if (m.role === 'assistant') {
        // A tool call is only valid when the next turn carries its result
        const next = msgs[i + 1], answered = new Set(next && Array.isArray(next.content) ? next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []);
        out.push({ role: 'assistant', content: m.content.filter(b => b.type === 'text' ? b.text : b.type === 'tool_use' && answered.has(b.id)) });
        continue;
      }
      const content = [];
      for (const b of m.content) {
        if (b.type !== 'doc_ref') { content.push(b); continue; }
        if (i >= recent) { try { content.push(await hydrate(b)); continue; } catch {} }
        content.push({ type: 'text', text: `[Attachment "${b.name}" was shared earlier in this conversation.]` });
      }
      out.push({ role: 'user', content });
    }
    // An assistant turn left empty (e.g. an interrupted answer) is not valid input
    return out.filter(m => m.content.length);
  }

  /* ── Conversation ─────────────────────────────── */
  function newChat() {
    const c = { id: uid(), title: '', created: Date.now(), updated: Date.now(), messages: [] };
    state.chats.push(c); current = c.id;
    renderSide(); renderLog(); toggleSide(false);
    $('s1-input').focus();
    return c;
  }
  function removeChat(id) {
    if (!confirm('Delete this conversation?')) return;
    state.chats = state.chats.filter(c => c.id !== id);
    if (current === id) current = null;
    save(); renderSide(); renderLog();
  }

  async function send(text) {
    text = (text || '').trim();
    if (busy || (!text && !attach.length)) return;
    const c = chat() || newChat();
    tidy(c);
    const content = attach.map(a => ({ type: 'doc_ref', ...a }));
    content.push({ type: 'text', text: text || 'Please review the attached file.' });
    c.messages.push({ role: 'user', content });
    if (!c.title) c.title = (text || attach[0].name).slice(0, 60);
    c.updated = Date.now();
    attach = []; renderAttach();
    $('s1-input').value = ''; autoGrow();
    renderSide(); renderLog();
    await run(c);
  }

  async function run(c, depth = 0) {
    busy = true; setBusy(true);
    const log = $('s1-log');
    const live = document.createElement('div');
    live.className = 's1-msg s1-msg--ai';
    live.innerHTML = `<div class="s1-avatar">${SPARK}</div><div class="s1-bubble"><span class="s1-typing"><i></i><i></i><i></i></span></div>`;
    log.appendChild(live); log.scrollTop = log.scrollHeight;
    const bubble = live.querySelector('.s1-bubble');
    abort = new AbortController();
    const blocks = [];
    let stop = null, errorMsg = null;
    try {
      const res = await api('/chat', {
        company: (ME.profile || {}).company || '', context: buildContext(), instructions: state.instructions,
        memories: state.memories.map(m => m.text), messages: await requestMessages(c)
      }, abort.signal);
      setUsage(parseFloat(res.headers.get('X-Usage-Spent')), parseFloat(res.headers.get('X-Usage-Limit')));
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.message || 'Sentinel One could not answer.'), { code: j.error }); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', frame = 0;
      const paint = () => { frame = 0; bubble.innerHTML = blocks.map(b => b.type === 'text' ? md(b.text) : '').join('') || '<span class="s1-typing"><i></i><i></i><i></i></span>'; log.scrollTop = log.scrollHeight; };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === 'content_block_start') blocks[ev.index] = ev.content_block.type === 'tool_use' ? { ...ev.content_block, input: {}, _json: '' } : { ...ev.content_block };
          else if (ev.type === 'content_block_delta' && blocks[ev.index]) {
            if (ev.delta.type === 'text_delta') blocks[ev.index].text += ev.delta.text;
            if (ev.delta.type === 'input_json_delta') blocks[ev.index]._json += ev.delta.partial_json;
          } else if (ev.type === 'content_block_stop' && blocks[ev.index] && blocks[ev.index].type === 'tool_use') {
            const b = blocks[ev.index];
            try { b.input = JSON.parse(b._json || '{}'); } catch { b.input = {}; }
            delete b._json;
          } else if (ev.type === 'message_delta') stop = ev.delta && ev.delta.stop_reason;
          else if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'Sentinel One could not answer.');
          if (!frame) frame = requestAnimationFrame(paint);
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') stop = 'stopped';
      else errorMsg = e.code === 'budget' ? e.message : (e.message || 'Sentinel One could not answer. Please try again.');
    }
    live.remove();
    const kept = blocks.filter(b => b && (b.type === 'text' ? b.text.trim() : b.type === 'tool_use'));
    if (errorMsg && !kept.length) {
      c.messages.push({ role: 'assistant', content: [{ type: 'text', text: '' }], note: errorMsg, error: true });
    } else {
      const msg = { role: 'assistant', content: kept.length ? kept : [{ type: 'text', text: '' }] };
      if (stop === 'refusal') msg.note = "Sentinel One can't help with that request.";
      if (stop === 'max_tokens') msg.note = 'The answer was cut short. Ask me to continue.';
      if (stop === 'stopped') msg.note = 'Stopped.';
      if (errorMsg) msg.note = errorMsg;
      c.messages.push(msg);
    }
    c.updated = Date.now();
    renderLog(); save();
    busy = false; setBusy(false); abort = null;

    // The model asked to save a memory: store it and let it finish its answer
    const tools = kept.filter(b => b.type === 'tool_use');
    if (stop === 'tool_use' && tools.length && depth < 3) {
      const results = tools.map(t => {
        const text = String((t.input && t.input.memory) || '').trim().slice(0, 500);
        if (text && !state.memories.some(m => m.text.toLowerCase() === text.toLowerCase())) state.memories.push({ id: uid(), text, date: Date.now(), by: 'ai' });
        return { type: 'tool_result', tool_use_id: t.id, content: text ? 'Saved to memory.' : 'Nothing to save.' };
      });
      c.messages.push({ role: 'user', content: results });
      renderSide(); save();
      await run(c, depth + 1);
    }
  }

  // Remove the failed/empty assistant turns before the next request
  function tidy(c) { c.messages = c.messages.filter(m => !m.error); }

  function setBusy(on) {
    $('s1-send').hidden = on; $('s1-stop').hidden = !on;
    $('s1-input').disabled = false;
  }
  function autoGrow() { const t = $('s1-input'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; }
  function toggleSide(open) { $('s1').classList.toggle('s1--side', open == null ? !$('s1').classList.contains('s1--side') : open); }
  function showPane(p) {
    document.querySelectorAll('.s1-tab').forEach(t => t.classList.toggle('on', t.dataset.p === p));
    document.querySelectorAll('.s1-pane').forEach(x => x.hidden = x.dataset.p !== p);
  }

  /* ── Public ───────────────────────────────────── */
  function init() {
    const nav = document.querySelector('.cp-nav-item[data-section="assistant"]');
    if (nav) nav.style.display = cfg() ? '' : 'none';
  }
  async function onShow() {
    if (!cfg()) return;
    if (!ready) {
      ready = true;
      $('s1-log').innerHTML = '<div class="s1-welcome"><span class="s1-typing"><i></i><i></i><i></i></span></div>';
      await loadState();
      const last = state.chats.slice().sort((a, b) => b.updated - a.updated)[0];
      current = last ? last.id : null;
      // Wire the UI once
      $('s1-form').onsubmit = ev => { ev.preventDefault(); send($('s1-input').value); };
      $('s1-input').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send($('s1-input').value); } });
      $('s1-input').addEventListener('input', autoGrow);
      $('s1-stop').onclick = () => abort && abort.abort();
      $('s1-attach-btn').onclick = ev => { ev.stopPropagation(); toggleAttachMenu(); };
      document.addEventListener('click', ev => { if (!ev.target.closest('#s1-attach-menu')) toggleAttachMenu(false); });
      document.querySelectorAll('.s1-tab').forEach(t => t.onclick = () => showPane(t.dataset.p));
      $('s1-instructions').addEventListener('input', () => { $('s1-instr-count').textContent = $('s1-instructions').value.length + ' / 4000'; });
      $('s1-instr-save').onclick = () => { state.instructions = $('s1-instructions').value.slice(0, 4000); save(); $('s1-instr-status').textContent = 'Saved ✓'; setTimeout(() => $('s1-instr-status').textContent = '', 2500); };
      document.querySelectorAll('.s1-preset').forEach(b => b.onclick = () => {
        const t = $('s1-instructions'); t.value = (t.value.trim() ? t.value.trim() + '\n' : '') + b.dataset.t;
        t.dispatchEvent(new Event('input'));
      });
      $('s1-mem-form').onsubmit = ev => {
        ev.preventDefault();
        const v = $('s1-mem-input').value.trim().slice(0, 500);
        if (!v) return;
        state.memories.push({ id: uid(), text: v, date: Date.now(), by: 'user' });
        $('s1-mem-input').value = ''; save(); renderSide();
      };
      showPane('chats');
    }
    const c = chat(); if (c) tidy(c);
    renderSide(); renderLog();
  }
  function copy(btn) {
    const text = btn.closest('.s1-bubble').innerText.replace(/\s*Copy\s*$/, '');
    navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy', 1500); }).catch(() => {});
  }
  return { init, onShow, newChat, toggleSide, copy };
})();
