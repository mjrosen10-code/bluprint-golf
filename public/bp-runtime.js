// BluPrint Golf web runtime: gives the app the same small API it uses inside Claude
// (db, user, sample, downloads), backed by this site's Worker.
(function () {
  'use strict';
  window.BP_WEB = { clubhouse: false };
  const api = async (method, url, payload) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: payload ? { 'content-type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: (d && d.code) || (r.status === 401 ? 'not_granted' : 'unavailable'), message: (d && d.error) || 'Request failed', status: r.status };
    return d;
  };

  // ---- auth ----
  let session = null;
  const auth = {
    async me() { if (session !== null) return session; try { const d = await api('GET', '/auth/me'); session = d.user || false; } catch (e) { session = false; } return session; },
    start: email => api('POST', '/auth/start', { email }),
    async verify(email, code) { const d = await api('POST', '/auth/verify', { email, code }); session = d.user; return d.user; },
    async logout() { try { await api('POST', '/auth/logout', {}); } catch (e) {} session = false; },
    async deleteAccount() { await api('POST', '/auth/delete', {}); session = false; }
  };
  window.BP_AUTH = auth;

  // ---- document store with live-ish snapshots ----
  const listeners = new Set();
  let refreshTimer = null;
  const refreshAll = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => listeners.forEach(l => l.run()), 60); };
  setInterval(() => { if (document.visibilityState === 'visible') listeners.forEach(l => l.run()); }, 45000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(); });

  const docSnap = (id, d) => ({ id, exists: !!d.exists, data: () => (d.exists ? JSON.parse(JSON.stringify(d.data)) : undefined) });
  const qSnap = docs => { const ds = docs.map(x => ({ id: x.id, exists: true, data: () => JSON.parse(JSON.stringify(x.data)) })); return { docs: ds, size: ds.length, empty: !ds.length, forEach: f => ds.forEach(f) }; };
  const listen = (fetcher, cb, err) => {
    let last = null, alive = true;
    const l = { run: async () => { if (!alive) return; try { const s = await fetcher(); const sig = JSON.stringify(s.sig); if (sig !== last) { last = sig; cb(s.snap); } } catch (e) { if (err) err(e); } } };
    listeners.add(l); l.run();
    return () => { alive = false; listeners.delete(l); };
  };

  class DocRef {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    collection(name) { return new Query(this.path + '/' + name); }
    async get() { return docSnap(this.id, await api('GET', '/api/doc?path=' + encodeURIComponent(this.path))); }
    async set(data) { await api('PUT', '/api/doc', { path: this.path, data }); refreshAll(); }
    async update(data) { await api('PUT', '/api/doc', { path: this.path, data, op: 'update' }); refreshAll(); }
    async delete() { await api('POST', '/api/doc', { path: this.path, op: 'delete' }); refreshAll(); }
    async acquire() { return { acquired: true, release: async () => {} }; }
    onSnapshot(cb, err) { return listen(async () => { const d = await api('GET', '/api/doc?path=' + encodeURIComponent(this.path)); return { sig: d, snap: docSnap(this.id, d) }; }, cb, err); }
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
    onSnapshot(cb, err) { return listen(async () => { const docs = await this._run(); return { sig: docs, snap: qSnap(docs) }; }, cb, err); }
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
    const r = await fetch('/api/ai', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, stream: true }), signal: opts.signal });
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

  window.claude = {
    async use(name) {
      if (name === 'downloads') return downloads;
      const u = await auth.me();
      if (!u) return null;
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'sample') return sample;
      return null;
    }
  };
})();
