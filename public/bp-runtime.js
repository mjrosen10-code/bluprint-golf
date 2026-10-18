// BluPrint Golf web runtime: gives the app the same small API it uses inside Claude
// (db, user, sample, downloads), backed by this site's Worker.
(function () {
  'use strict';
  window.BP_WEB = { clubhouse: true };
  // Session: an HttpOnly cookie, plus the same token kept on this device for browsers that drop the cookie.
  const TK = 'bp_t';
  const getTok = () => { try { return localStorage.getItem(TK) || ''; } catch (e) { return ''; } };
  const setTok = t => { try { t ? localStorage.setItem(TK, t) : localStorage.removeItem(TK); } catch (e) {} };
  const authHeaders = () => { const t = getTok(); return t ? { authorization: 'Bearer ' + t } : {}; };
  const api = async (method, url, payload) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { ...authHeaders(), ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: (d && d.code) || (r.status === 401 ? 'not_granted' : 'unavailable'), message: (d && d.error) || 'Request failed', status: r.status };
    return d;
  };

  // ---- auth ----
  let session = null;
  const auth = {
    async me() { if (session !== null) return session; try { const d = await api('GET', '/auth/me'); session = d.user || false; } catch (e) { session = false; } return session; },
    start: email => api('POST', '/auth/start', { email }),
    async verify(email, code, password) { const d = await api('POST', '/auth/verify', { email, code, ...(password != null ? { password } : {}) }); if (d.token) setTok(d.token); session = d.user; return d.user; },
    async login(email, password) { const d = await api('POST', '/auth/login', { email, password }); if (d.token) setTok(d.token); session = d.user; return d.user; },
    setPassword: password => api('POST', '/auth/password', { password }),
    async logout() { try { await api('POST', '/auth/logout', {}); } catch (e) {} setTok(''); session = false; },
    async deleteAccount() { await api('POST', '/auth/delete', {}); setTok(''); session = false; }
  };
  window.BP_AUTH = auth;

  // ---- document store with live-ish snapshots ----
  // Every live view on screen is refreshed together in ONE request (/api/batch):
  // every 4s while a conversation is open, 15s otherwise, paused when the tab is hidden.
  const listeners = new Set();
  let refreshTimer = null, pollTimer = null, inFlight = false, again = false;
  const fastPath = l => /^dms\/[^/]+\/msgs$/.test(l.spec.collection || '') || /^groups\/[^/]+\/msgs$/.test(l.spec.collection || '');
  async function pollAll() {
    if (inFlight) { again = true; return; }
    const ls = [...listeners];
    if (!ls.length) return;
    inFlight = true;
    try {
      for (let i = 0; i < ls.length; i += 100) {
        const chunk = ls.slice(i, i + 100);
        const d = await api('POST', '/api/batch', { ops: chunk.map(l => l.spec) });
        chunk.forEach((l, k) => l.apply((d.results || [])[k]));
      }
    } catch (e) { ls.forEach(l => l.fail(e)); }
    inFlight = false;
    if (again) { again = false; pollAll(); }
  }
  const refreshAll = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(pollAll, 60); };
  let nextAt = 0;
  // Keep the running countdown: views re-subscribing must not push the next refresh back.
  // Only move it sooner (e.g. a conversation just opened and needs the 4s rate).
  function schedule(force) {
    const wait = [...listeners].some(fastPath) ? 4000 : 15000, due = Date.now() + wait;
    if (!force && pollTimer && nextAt <= due) return;
    clearTimeout(pollTimer); nextAt = due;
    pollTimer = setTimeout(() => { pollTimer = null; if (document.visibilityState === 'visible') pollAll(); schedule(true); }, wait);
  }
  schedule();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(); });
  window.addEventListener('focus', refreshAll);

  const docSnap = (id, d) => ({ id, exists: !!d.exists, data: () => (d.exists ? JSON.parse(JSON.stringify(d.data)) : undefined) });
  const qSnap = docs => { const ds = docs.map(x => ({ id: x.id, exists: true, data: () => JSON.parse(JSON.stringify(x.data)) })); return { docs: ds, size: ds.length, empty: !ds.length, forEach: f => ds.forEach(f) }; };
  const listen = (spec, toSnap, cb, err) => {
    let last = null, alive = true;
    const l = {
      spec,
      apply(r) { if (!alive || !r) return; if (!r.ok) { if (err) err({ code: r.code || 'not_granted', message: r.error, status: r.status }); return; }
        const sig = JSON.stringify(r); if (sig !== last) { last = sig; cb(toSnap(r)); } },
      fail(e) { if (alive && err) err(e); }
    };
    listeners.add(l); refreshAll(); schedule();
    return () => { alive = false; listeners.delete(l); schedule(); };
  };

  class DocRef {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    collection(name) { return new Query(this.path + '/' + name); }
    async get() { return docSnap(this.id, await api('GET', '/api/doc?path=' + encodeURIComponent(this.path))); }
    async set(data) { await api('PUT', '/api/doc', { path: this.path, data }); refreshAll(); }
    async update(data) { await api('PUT', '/api/doc', { path: this.path, data, op: 'update' }); refreshAll(); }
    async delete() { await api('POST', '/api/doc', { path: this.path, op: 'delete' }); refreshAll(); }
    async acquire() { return { acquired: true, release: async () => {} }; }
    onSnapshot(cb, err) { return listen({ t: 'doc', path: this.path }, r => docSnap(this.id, r), cb, err); }
  }
  class Query {
    constructor(path, q) { this.path = path; this.q = q || { where: [], orderBy: [], limit: null }; }
    _with(k, v) { const q = { ...this.q, where: [...this.q.where], orderBy: [...this.q.orderBy] }; if (k === 'limit') q.limit = v; else q[k].push(v); return new Query(this.path, q); }
    where(f, op, v) { return this._with('where', [f, op, v]); }
    orderBy(f, dir) { return this._with('orderBy', [f, dir || 'asc']); }
    limit(n) { return this._with('limit', n); }
    doc(id) { return new DocRef(this.path + '/' + id); }
    async _run() { return (await api('POST', '/api/query', { collection: this.path, ...this.q })).docs; }
    async get() { return qSnap(await this._run()); }
    onSnapshot(cb, err) { return listen({ t: 'q', collection: this.path, ...this.q }, r => qSnap(r.docs || []), cb, err); }
  }
  const db = { doc: p => new DocRef(p), collection: p => new Query(p) };

  // ---- AI ----
  const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function shrink(blob) {
    try {
      const bmp = await createImageBitmap(blob); const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    } catch (e) { return blob; }
  }
  const toMessages = input => (Array.isArray(input) ? input : [{ role: 'user', content: String(input) }]);
  async function prep(input, opts) {
    const images = [];
    for (const b of (opts && opts.images) || []) { const s = await shrink(b); images.push({ media_type: s.type || 'image/jpeg', data: await toB64(s) }); }
    return { messages: toMessages(input), images, tier: opts && opts.modelTier === 'quick' ? 'quick' : 'default' };
  }
  async function sample(input, opts) {
    opts = opts || {};
    const p = await prep(input, opts);
    if (!opts.onText) { const d = await api('POST', '/api/ai', p); return { text: d.text, truncated: !!d.truncated }; }
    const r = await fetch('/api/ai', { method: 'POST', credentials: 'same-origin', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ ...p, stream: true }), signal: opts.signal });
    if (!r.ok) { let d = null; try { d = await r.json(); } catch (e) {} throw { code: (d && d.code) || 'unavailable', message: (d && d.error) || 'AI request failed' }; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let text = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; const delta = dec.decode(value, { stream: true }); text += delta; try { opts.onText({ text, delta }); } catch (e) {} }
    return { text, truncated: false };
  }
  sample.json = async (input, opts) => {
    const p = await prep(input, opts || {});
    const d = await api('POST', '/api/ai', { ...p, json: true });
    const t = String(d.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(t); } catch (e) { const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw { code: 'bad_output', message: 'Could not read the AI reply.' }; }
  };
  sample.limits = async () => ({ images: true });

  // ---- user ----
  const user = {
    id: async () => { const u = await auth.me(); return u ? u.id : null; },
    me: async () => { const u = await auth.me(); return u ? { id: u.id, name: u.email.split('@')[0], email: u.email } : { id: null, name: '' }; },
    isOwner: async () => false, canEdit: async () => true, can: async () => true,
    profiles: async () => ({}), search: async () => []
  };

  // ---- downloads ----
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename || 'download'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  };


  // ---- photos (videos need separate storage; not on the web yet) ----
  const assets = {
    async upload(blob, opts) {
      const type = String((opts && opts.type) || blob.type || '').toLowerCase();
      if (type.startsWith('video/')) throw { code: 'bad_type', message: 'Video posts are coming soon. Photos work now.' };
      const r = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { ...authHeaders(), 'content-type': type || 'image/jpeg' }, body: blob });
      let d = null; try { d = await r.json(); } catch (e) {}
      if (!r.ok) throw { code: (d && d.code) || 'unavailable', message: (d && d.error) || 'Upload failed', status: r.status };
      return d;
    }
  };

  window.claude = {
    async use(name) {
      if (name === 'downloads') return downloads;
      const u = await auth.me();
      if (!u) return null;
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'sample') return sample;
      if (name === 'assets') return assets;
      return null;
    }
  };
})();
