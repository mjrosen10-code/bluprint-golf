// BluPrint Golf — Cloudflare Worker
// Serves the app (static assets) and a small API:
//   /auth/*  email one-time-code sign in, sessions in D1, HttpOnly cookie
//   /api/doc, /api/query   a per-user document store in D1 with ownership rules
//   /api/ai  proxy to the Anthropic Messages API (the key never reaches the browser)
// Secrets (set in the Cloudflare dashboard): ANTHROPIC_API_KEY, RESEND_API_KEY
// Vars (wrangler.jsonc): MAIL_FROM, AI_DAILY_LIMIT, MODEL_DEFAULT, MODEL_QUICK

const SESSION_DAYS = 60;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const MAX_DOC_BYTES = 200 * 1024;
const enc = new TextEncoder();

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/auth/') || p.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req, url)) return json({ error: 'bad_origin' }, 403);
        if (p === '/auth/start' && req.method === 'POST') return await authStart(req, env);
        if (p === '/auth/verify' && req.method === 'POST') return await authVerify(req, env);
        if (p === '/auth/me') return await authMe(req, env);
        if (p === '/auth/logout' && req.method === 'POST') return await authLogout(req, env);
        const user = await currentUser(req, env);
        if (!user) return json({ error: 'not_signed_in', code: 'not_granted' }, 401);
        if (p === '/auth/delete' && req.method === 'POST') return await deleteAccount(env, user);
        if (p === '/api/doc') return await docRoute(req, env, user, url);
        if (p === '/api/query' && req.method === 'POST') return await queryRoute(req, env, user);
        if (p === '/api/ai' && req.method === 'POST') return await aiRoute(req, env, user);
        return json({ error: 'not_found' }, 404);
      }
      const res = await env.ASSETS.fetch(req);
      return withSecurityHeaders(res);
    } catch (e) {
      console.error(e && e.stack || e);
      return json({ error: 'server_error' }, 500);
    }
  }
};

// ---------- helpers ----------
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
function sameOrigin(req, url) {
  const o = req.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === url.host; } catch { return false; }
}
function withSecurityHeaders(res) {
  const h = new Headers(res.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'DENY');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomId(prefix) { return prefix + randomToken(12).replace(/[-_]/g, 'x'); }
function cookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}
async function body(req, max = 1024 * 1024) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error('too_large'), { status: 413 });
  return t ? JSON.parse(t) : {};
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

// ---------- auth ----------
async function authStart(req, env) {
  const { email: raw } = await body(req, 4096);
  const email = String(raw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT sent_count, window_start FROM login_codes WHERE email=?').bind(email).first();
  let sent = 0, windowStart = now;
  if (row && now - row.window_start < 3600e3) { sent = row.sent_count; windowStart = row.window_start; }
  if (sent >= MAX_CODES_PER_HOUR) return json({ error: 'Too many codes requested. Try again in an hour.' }, 429);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const hash = await sha256(email + ':' + code);
  await env.DB.prepare(`INSERT INTO login_codes(email, code_hash, expires, attempts, sent_count, window_start) VALUES(?,?,?,0,?,?)
    ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires=excluded.expires, attempts=0, sent_count=excluded.sent_count, window_start=excluded.window_start`)
    .bind(email, hash, now + CODE_TTL_MS, sent + 1, windowStart).run();
  if (!env.RESEND_API_KEY) {
    if (env.DEV_SHOW_CODE === '1') return json({ ok: true, devCode: code });
    return json({ error: 'Email sign-in is not set up yet.' }, 503);
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'BluPrint Golf <login@bluprintgolf.com>',
      to: [email],
      subject: `${code} is your BluPrint Golf code`,
      text: `Your BluPrint Golf sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#0D0F0F">
        <p style="font-weight:700;letter-spacing:.12em;margin:0 0 20px">BLUPRINT<span style="color:#1FB866">GOLF</span></p>
        <p style="margin:0 0 8px">Your sign-in code:</p>
        <p style="font-size:34px;font-weight:700;letter-spacing:.3em;margin:0 0 16px;font-family:Menlo,monospace">${code}</p>
        <p style="color:#555;font-size:13px;margin:0">It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p></div>`
    })
  });
  if (!r.ok) { console.error('resend', r.status, await r.text()); return json({ error: 'Could not send the email. Try again.' }, 502); }
  return json({ ok: true });
}

async function authVerify(req, env) {
  const { email: raw, code: rc } = await body(req, 4096);
  const email = String(raw || '').trim().toLowerCase();
  const code = String(rc || '').replace(/\D/g, '');
  const row = await env.DB.prepare('SELECT code_hash, expires, attempts FROM login_codes WHERE email=?').bind(email).first();
  if (!row || row.expires < Date.now()) return json({ error: 'That code expired. Request a new one.' }, 400);
  if (row.attempts >= MAX_CODE_ATTEMPTS) return json({ error: 'Too many tries. Request a new code.' }, 429);
  if ((await sha256(email + ':' + code)) !== row.code_hash) {
    await env.DB.prepare('UPDATE login_codes SET attempts=attempts+1 WHERE email=?').bind(email).run();
    return json({ error: 'That code is not right. Check the email and try again.' }, 400);
  }
  await env.DB.prepare('UPDATE login_codes SET expires=0 WHERE email=?').bind(email).run();
  let user = await env.DB.prepare('SELECT id, email FROM users WHERE email=?').bind(email).first();
  if (!user) {
    user = { id: randomId('u'), email };
    await env.DB.prepare('INSERT INTO users(id, email, created) VALUES(?,?,?)').bind(user.id, email, new Date().toISOString()).run();
  }
  const token = randomToken(32);
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, expires) VALUES(?,?,?)').bind(await sha256(token), user.id, expires).run();
  return json({ user: { id: user.id, email: user.email }, token }, 200, {
    'set-cookie': `bp_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`
  });
}

function sessionToken(req) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return cookie(req, 'bp_s');
}
async function currentUser(req, env) {
  const t = sessionToken(req);
  if (!t) return null;
  const s = await env.DB.prepare('SELECT u.id, u.email, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').bind(await sha256(t)).first();
  if (!s || s.expires < Date.now()) return null;
  return { id: s.id, email: s.email };
}
async function authMe(req, env) {
  const u = await currentUser(req, env);
  return u ? json({ user: u }) : json({ user: null }, 200);
}
async function authLogout(req, env) {
  const t = sessionToken(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(t)).run();
  return json({ ok: true }, 200, { 'set-cookie': 'bp_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}
async function deleteAccount(env, user) {
  const uid = user.id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM docs WHERE path LIKE ? OR path=? OR (path LIKE 'usernames/%' AND owner=?)").bind(`data/users/${uid}/%`, `players/${uid}`, uid),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM ai_usage WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM login_codes WHERE email=?').bind(user.email),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid)
  ]);
  return json({ ok: true }, 200, { 'set-cookie': 'bp_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

// ---------- document store ----------
// Paths look like "data/users/<uid>/profile/rounds/<id>". Odd segment counts are collections.
const SEG = /^[A-Za-z0-9_.~@-]{1,128}$/;
function parsePath(path, wantDoc) {
  const segs = String(path || '').split('/');
  if (!segs.length || segs.length > 12 || !segs.every(s => SEG.test(s) && s !== '.' && s !== '..')) return null;
  if (wantDoc !== undefined && (segs.length % 2 === 0) !== wantDoc) return null;
  return segs;
}
function canRead(segs, uid) {
  if (segs[0] === 'data') return segs[1] === 'users' && segs[2] === uid;
  return ['usernames', 'players', 'clubs'].includes(segs[0]);
}
// Returns null when allowed, else an error code.
function writeRule(segs, uid, existing, data) {
  if (segs[0] === 'data') return segs[1] === 'users' && segs[2] === uid ? null : 'not_granted';
  if (segs[0] === 'players') return segs.length === 2 && segs[1] === uid ? null : 'not_granted';
  if (segs[0] === 'usernames' && segs.length === 2) {
    if (existing && existing.owner !== uid) return 'taken';
    if (data && data.uid !== uid) return 'not_granted';
    return null;
  }
  if (segs[0] === 'clubs' && segs.length === 2) return existing && existing.owner !== uid ? 'not_granted' : null;
  return 'not_granted';
}
async function docRoute(req, env, user, url) {
  if (req.method === 'GET') {
    const segs = parsePath(url.searchParams.get('path'), true);
    if (!segs) return json({ error: 'bad_path' }, 400);
    if (!canRead(segs, user.id)) return json({ error: 'not_granted', code: 'not_granted' }, 403);
    const row = await env.DB.prepare('SELECT data FROM docs WHERE path=?').bind(segs.join('/')).first();
    return json(row ? { exists: true, data: JSON.parse(row.data) } : { exists: false });
  }
  const b = await body(req, MAX_DOC_BYTES + 4096);
  const segs = parsePath(b.path, true);
  if (!segs) return json({ error: 'bad_path' }, 400);
  const path = segs.join('/');
  const existing = await env.DB.prepare('SELECT data, owner FROM docs WHERE path=?').bind(path).first();
  if (req.method === 'DELETE' || b.op === 'delete') {
    const err = writeRule(segs, user.id, existing, null);
    if (err) return json({ error: err, code: 'not_granted' }, 403);
    await env.DB.prepare('DELETE FROM docs WHERE path=?').bind(path).run();
    return json({ ok: true });
  }
  if (req.method !== 'PUT' && req.method !== 'POST') return json({ error: 'method' }, 405);
  let data = b.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'bad_data' }, 400);
  if (b.op === 'update' && existing) data = { ...JSON.parse(existing.data), ...data };
  const err = writeRule(segs, user.id, existing, data);
  if (err) return json({ error: err, code: err === 'taken' ? 'already_exists' : 'not_granted' }, 403);
  const text = JSON.stringify(data);
  if (text.length > MAX_DOC_BYTES) return json({ error: 'too_large', code: 'quota_exceeded' }, 413);
  await env.DB.prepare(`INSERT INTO docs(path, parent, id, data, owner, updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated`)
    .bind(path, segs.slice(0, -1).join('/'), segs[segs.length - 1], text, existing ? existing.owner : user.id, new Date().toISOString()).run();
  return json({ ok: true });
}
function getField(o, f) { return String(f).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }
function cmp(a, b) { if (a === b) return 0; if (a === undefined || a === null) return -1; if (b === undefined || b === null) return 1; return a < b ? -1 : 1; }
async function queryRoute(req, env, user) {
  const q = await body(req, 64 * 1024);
  const segs = parsePath(q.collection, false);
  if (!segs) return json({ error: 'bad_path' }, 400);
  if (!canRead(segs, user.id)) return json({ error: 'not_granted', code: 'not_granted' }, 403);
  const { results } = await env.DB.prepare('SELECT id, data FROM docs WHERE parent=? LIMIT 5000').bind(segs.join('/')).all();
  let docs = results.map(r => ({ id: r.id, data: JSON.parse(r.data) }));
  for (const [f, op, v] of (q.where || []).slice(0, 8)) {
    docs = docs.filter(d => {
      const x = getField(d.data, f);
      switch (op) {
        case '==': return x === v; case '!=': return x !== v;
        case '<': return cmp(x, v) < 0; case '<=': return cmp(x, v) <= 0;
        case '>': return cmp(x, v) > 0; case '>=': return cmp(x, v) >= 0;
        case 'in': return Array.isArray(v) && v.includes(x);
        case 'array-contains': return Array.isArray(x) && x.includes(v);
        default: return false;
      }
    });
  }
  for (const [f, dir] of (q.orderBy || []).slice(0, 3).reverse()) docs.sort((a, b) => cmp(getField(a.data, f), getField(b.data, f)) * (dir === 'desc' ? -1 : 1));
  const lim = Math.min(Number(q.limit) || 1000, 2000);
  return json({ docs: docs.slice(0, lim) });
}

// ---------- AI ----------
async function aiRoute(req, env, user) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI is not set up yet.', code: 'unavailable' }, 503);
  const q = await body(req, 12 * 1024 * 1024);
  const day = new Date().toISOString().slice(0, 10);
  const limit = Number(env.AI_DAILY_LIMIT || 60);
  const use = await env.DB.prepare('SELECT calls FROM ai_usage WHERE user_id=? AND day=?').bind(user.id, day).first();
  if (use && use.calls >= limit) return json({ error: "You've hit today's AI limit. It resets tomorrow.", code: 'rate_limited' }, 429);
  await env.DB.prepare('INSERT INTO ai_usage(user_id, day, calls) VALUES(?,?,1) ON CONFLICT(user_id, day) DO UPDATE SET calls=calls+1').bind(user.id, day).run();

  let messages = Array.isArray(q.messages) ? q.messages.slice(-40) : [{ role: 'user', content: String(q.messages || '') }];
  messages = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 40000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_input' }, 400);
  const imgs = (q.images || []).slice(0, 4).filter(i => i && /^image\/(png|jpeg|webp|gif)$/.test(i.media_type) && typeof i.data === 'string');
  if (imgs.length) {
    const last = messages[messages.length - 1];
    last.content = [...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })), { type: 'text', text: last.content }];
  }
  const model = q.tier === 'quick' ? (env.MODEL_QUICK || 'claude-haiku-5-5') : (env.MODEL_DEFAULT || 'claude-sonnet-5-5');
  const payload = {
    model, max_tokens: q.json ? 2000 : 1200, messages,
    system: (q.json ? 'Reply with only valid JSON, no prose and no code fences. ' : '') + 'You are the coaching engine inside BluPrint Golf, a golf stats and handicap app.',
    stream: !!q.stream
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) { console.error('anthropic', r.status, await r.text()); return json({ error: 'The AI service is busy. Try again.', code: 'unavailable' }, 502); }
  if (!q.stream) {
    const d = await r.json();
    return json({ text: (d.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), truncated: d.stop_reason === 'max_tokens' });
  }
  // Re-stream only the text deltas as plain text.
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  (async () => {
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) await w.write(enc.encode(ev.delta.text)); } catch {}
        }
      }
    } finally { await w.close(); }
  })();
  return new Response(readable, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
