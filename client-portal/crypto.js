/* ── Sentinels Client Portal · shared encryption helpers ─────────────
   The site is static (GitHub Pages), so every file in /client-portal/data
   is public. Client data is therefore encrypted in the browser with
   AES-GCM-256; keys are derived from passwords with PBKDF2-SHA256.

   data/meta.json            lookup salt, admin check, wrapped portal key
   data/admin-index.json     client list (encrypted with the admin key)
   data/clients/<id>.json    one vault per client:
                               client → data key wrapped with client password
                               admin  → data key wrapped with admin key
                               data   → profile, docs list, portal key
   data/docs/<rid>.bin       PDFs encrypted with the client's data key
   data/intel.json           market intelligence (encrypted with portal key)
   ──────────────────────────────────────────────────────────────────── */
const SP = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ITER = 600000;

  function b64(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

  async function deriveKey(password, salt, iter = ITER) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const importKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function seal(key, bytes) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function open(key, box) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)));
  }
  const sealJSON = (key, obj) => seal(key, enc.encode(JSON.stringify(obj)));
  const openJSON = async (key, box) => JSON.parse(dec.decode(await open(key, box)));

  // Binary files: iv (12 bytes) || ciphertext
  async function sealFile(key, bytes) {
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function openFile(key, bytes) {
    const b = new Uint8Array(bytes);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12)));
  }

  // Wrap a raw key with a password (own salt per wrap)
  async function wrapWithPassword(password, raw) {
    const salt = rand(16);
    const k = await deriveKey(password, salt);
    return { salt: b64(salt), iter: ITER, ...(await seal(k, raw)) };
  }
  async function unwrapWithPassword(password, w) {
    return open(await deriveKey(password, unb64(w.salt), w.iter), w);
  }

  async function clientId(email, lookupSalt) {
    const h = await crypto.subtle.digest('SHA-256', enc.encode(lookupSalt + ':' + email.trim().toLowerCase()));
    return hex(new Uint8Array(h).slice(0, 16));
  }

  // Unambiguous characters, rejection sampling to avoid modulo bias
  function genPassword(len = 16) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    while (out.length < len) {
      for (const x of rand(32)) if (x < 224 && out.length < len) out += A[x % A.length];
    }
    return out;
  }

  return { ITER, b64, unb64, rand, hex, deriveKey, importKey, seal, open, sealJSON, openJSON,
           sealFile, openFile, wrapWithPassword, unwrapWithPassword, clientId, genPassword,
           randomId: () => hex(rand(16)) };
})();
