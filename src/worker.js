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
      if (p.startsWith('/_blob/') && req.method === 'GET') return await blobRoute(env, p.slice(7));
      if (p.startsWith('/auth/') || p.startsWith('/api/')) {
        if (req.method !== 'GET' && !sameOrigin(req, url)) return json({ error: 'bad_origin' }, 403);
        if (p === '/auth/start' && req.method === 'POST') return await authStart(req, env);
        if (p === '/auth/verify' && req.method === 'POST') return await authVerify(req, env);
        if (p === '/auth/me') return await authMe(req, env);
        if (p === '/auth/login' && req.method === 'POST') return await authLogin(req, env);
        if (p === '/auth/logout' && req.method === 'POST') return await authLogout(req, env);
        const user = await currentUser(req, env);
        if (!user) return json({ error: 'not_signed_in', code: 'not_granted' }, 401);
        if (p === '/auth/delete' && req.method === 'POST') return await deleteAccount(env, user);
        if (p === '/auth/password' && req.method === 'POST') return await setPasswordRoute(req, env, user);
        if (p === '/api/doc') return await docRoute(req, env, user, url);
        if (p === '/api/query' && req.method === 'POST') return await queryRoute(req, env, user);
        if (p === '/api/batch' && req.method === 'POST') return await batchRoute(req, env, user);
        if (p === '/api/ai' && req.method === 'POST') return await aiRoute(req, env, user);
        if (p === '/api/upload' && req.method === 'POST') return await uploadRoute(req, env, user);
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
  const { email: raw, code: rc, password } = await body(req, 4096);
  if (password != null && pwProblem(password)) return json({ error: pwProblem(password) }, 400);
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
  if (password != null) {
    await env.DB.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPassword(password, env), user.id).run();
    await env.DB.prepare('DELETE FROM login_attempts WHERE email=?').bind(email).run();
  }
  return await startSession(env, user);
}
async function startSession(env, user) {
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
  const s = await env.DB.prepare('SELECT u.id, u.email, u.pw, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').bind(await sha256(t)).first();
  if (!s || s.expires < Date.now()) return null;
  return { id: s.id, email: s.email, hasPassword: !!s.pw };
}
async function authMe(req, env) {
  const u = await currentUser(req, env);
  return u ? json({ user: u }) : json({ user: null }, 200);
}
// ---------- passwords (PBKDF2-SHA256, salted; iteration count stored with each hash) ----------
function pwProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (p.length > 200) return 'That password is too long.';
  return null;
}
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(password, env) {
  const iter = Math.min(100000, Number(env.PBKDF2_ITER || 60000));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iter}$${b64(salt)}$${b64(await pbkdf2(password, salt, iter))}`;
}
async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
async function authLogin(req, env) {
  const { email: raw, password } = await body(req, 4096);
  const email = String(raw || '').trim().toLowerCase();
  const now = Date.now();
  const att = await env.DB.prepare('SELECT fails, window_start FROM login_attempts WHERE email=?').bind(email).first();
  const fails = att && now - att.window_start < 15 * 60e3 ? att.fails : 0;
  if (fails >= 8) return json({ error: 'Too many tries. Wait 15 minutes or sign in with an email code.' }, 429);
  const user = await env.DB.prepare('SELECT id, email, pw FROM users WHERE email=?').bind(email).first();
  if (!user || !user.pw || !(await checkPassword(String(password || ''), user.pw))) {
    await env.DB.prepare(`INSERT INTO login_attempts(email, fails, window_start) VALUES(?,1,?)
      ON CONFLICT(email) DO UPDATE SET fails=CASE WHEN ?-window_start<900000 THEN fails+1 ELSE 1 END, window_start=CASE WHEN ?-window_start<900000 THEN window_start ELSE ? END`).bind(email, now, now, now, now).run();
    return json({ error: user && !user.pw ? 'This account has no password yet. Sign in with an email code, then set one.' : 'Email or password is not right.' }, 400);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE email=?').bind(email).run();
  return await startSession(env, user);
}
async function setPasswordRoute(req, env, user) {
  const { password } = await body(req, 4096);
  if (pwProblem(password)) return json({ error: pwProblem(password) }, 400);
  await env.DB.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPassword(password, env), user.id).run();
  return json({ ok: true });
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
    // social footprint: own posts, follows, comments, likes, groups they own, requests and conversations they are part of
    env.DB.prepare("DELETE FROM docs WHERE path LIKE ? OR path LIKE ? OR (owner=? AND (path LIKE 'comments/%' OR path LIKE 'reactions/%' OR path LIKE 'groups/%' OR path LIKE 'friendreqs/%'))").bind(`posts/${uid}/%`, `follows/${uid}/%`, uid),
    env.DB.prepare("DELETE FROM docs WHERE path LIKE 'friendreqs/%' AND json_extract(data,'$.to')=?").bind(uid),
    env.DB.prepare("DELETE FROM docs WHERE path LIKE 'dms/%' AND (path LIKE ? OR path LIKE ?)").bind(`dms/${uid}~%`, `dms/%~${uid}%`),
    env.DB.prepare('DELETE FROM blobs WHERE owner=?').bind(uid),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM ai_usage WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM login_codes WHERE email=?').bind(user.email),
    env.DB.prepare('DELETE FROM login_attempts WHERE email=?').bind(user.email),
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
// ---- access rules ----
// Private: data/users/<uid>/... (owner only), friendreqs (sender + recipient), dms and their messages (members).
// Shared with signed-in members: players, usernames, clubs, posts, comments, reactions, follows.
const SHARED = ['usernames', 'players', 'clubs', 'posts', 'comments', 'reactions', 'follows', 'groups'];
function canReadPath(segs, uid) {
  if (segs[0] === 'data') return segs[1] === 'users' && segs[2] === uid;
  if (SHARED.includes(segs[0])) return true;
  if (segs[0] === 'friendreqs' && segs.length <= 2) return true;   // row-level check below
  if (segs[0] === 'dms') return segs.length <= 2 || uidInThread(segs[1], uid); // thread ids are "<uidA>~<uidB>"
  return false;
}
function uidInThread(tid, uid) { return String(tid).split('~').includes(uid); }
// Row-level read check for single documents.
function canReadDoc(segs, uid, data) {
  if (!canReadPath(segs, uid)) return false;
  if (!data) return true;
  if (segs[0] === 'friendreqs') return data.from === uid || data.to === uid;
  if (segs[0] === 'dms' && segs.length === 2) return Array.isArray(data.members) && data.members.includes(uid);
  return true;
}
// Anything under groups/<gid>/... (the group chat) is for current members only.
async function isGroupMember(env, gid, uid) {
  const row = await env.DB.prepare('SELECT data FROM docs WHERE path=?').bind('groups/' + gid).first();
  const g = row ? JSON.parse(row.data) : null;
  return !!(g && (g.owner === uid || (g.members || []).includes(uid)));
}
async function groupGate(env, segs, uid) { return segs[0] !== 'groups' || segs.length < 3 || await isGroupMember(env, segs[1], uid); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Returns null when allowed, else an error code.
async function writeRule(env, segs, uid, existing, data) {
  const old = existing ? JSON.parse(existing.data) : null;
  const mine = !existing || existing.owner === uid;
  const n = segs.length;
  switch (segs[0]) {
    case 'data': return segs[1] === 'users' && segs[2] === uid ? null : 'not_granted';
    case 'players': return n === 2 && segs[1] === uid ? null : 'not_granted';
    case 'usernames':
      if (n !== 2) return 'not_granted';
      if (existing && existing.owner !== uid) return 'taken';
      return data && data.uid !== uid ? 'not_granted' : null;
    case 'clubs': return n === 2 && mine ? null : 'not_granted';
    case 'posts':     // posts/<uid>/items/<id>
      if (n !== 4 || segs[1] !== uid || segs[2] !== 'items') return 'not_granted';
      return data && data.uid !== uid ? 'not_granted' : null;
    case 'follows':   // follows/<uid>/items/<target>
      return n === 4 && segs[1] === uid && segs[2] === 'items' ? null : 'not_granted';
    case 'comments':
    case 'reactions':
      if (n !== 2 || !mine) return 'not_granted';
      return data && data.uid !== uid ? 'not_granted' : null;
    case 'friendreqs': {
      if (n !== 2) return 'not_granted';
      if (!existing) return data && data.from === uid && typeof data.to === 'string' && data.to !== uid ? null : 'not_granted';
      if (old.from !== uid && old.to !== uid) return 'not_granted';
      if (!data) return null;                                  // either side may withdraw or clear
      if (data.from !== old.from || data.to !== old.to) return 'not_granted';
      if (data.status !== old.status && old.to !== uid && !['cancelled', 'pending'].includes(data.status)) return 'not_granted'; // only the recipient accepts/declines; the sender may resend or cancel
      return null;
    }
    case 'dms':
      if (n === 2) {
        if (!data) return old && old.members && old.members.includes(uid) ? null : 'not_granted';
        const m = data.members;
        if (!Array.isArray(m) || m.length !== 2 || !m.includes(uid) || [...m].sort().join('~') !== segs[1]) return 'not_granted';
        if (old && !same([...old.members].sort(), [...m].sort())) return 'not_granted';
        return null;
      }
      if (n === 4 && segs[2] === 'msgs' && uidInThread(segs[1], uid)) {
        if (!data) return mine ? null : 'not_granted';
        return data.from === uid && mine ? null : 'not_granted';
      }
      return 'not_granted';
    case 'groups': {  // groups/<gid>: {name, owner, members[], photo, last}; chat at groups/<gid>/msgs/<id>
      if (n === 4 && segs[2] === 'msgs') {
        if (!(await isGroupMember(env, segs[1], uid))) return 'not_granted';
        if (!data) return mine ? null : 'not_granted';
        return data.from === uid && mine && typeof data.text === 'string' && data.text.length <= 1000 ? null : 'not_granted';
      }
      if (n !== 2) return 'not_granted';
      if (!old) return data && data.owner === uid && Array.isArray(data.members) && same(data.members, [uid]) ? null : 'not_granted';
      if (old.owner === uid) return !data || (data.owner === uid && Array.isArray(data.members) && data.members.includes(uid)) ? null : 'not_granted';
      if (!data) return 'not_granted';
      if (data.owner !== old.owner || data.name !== old.name || data.photo !== old.photo || !Array.isArray(data.members)) return 'not_granted';
      // a member posting in the group chat updates the "last message" preview only
      if ((old.members || []).includes(uid) && same(data.members, old.members) && data.last && data.last.from === uid) return null;
      const was = new Set(old.members || []), now = new Set(data.members);
      const added = [...now].filter(x => !was.has(x)), removed = [...was].filter(x => !now.has(x));
      if (!added.length && removed.length === 1 && removed[0] === uid) return null;           // leaving
      if (!removed.length && added.length === 1 && added[0] === uid) {                         // joining needs an invite
        const inv = await env.DB.prepare('SELECT data FROM docs WHERE path=?').bind(`friendreqs/g~${segs[1]}~${uid}`).first();
        const d = inv ? JSON.parse(inv.data) : null;
        return d && d.to === uid && d.gid === segs[1] ? null : 'not_granted';
      }
      return 'not_granted';
    }
    default: return 'not_granted';
  }
}
async function readDoc(env, user, path) {
  const segs = parsePath(path, true);
  if (!segs) return { status: 400, body: { error: 'bad_path' } };
  if (!canReadPath(segs, user.id) || !(await groupGate(env, segs, user.id))) return { status: 403, body: { error: 'not_granted', code: 'not_granted' } };
  const row = await env.DB.prepare('SELECT data FROM docs WHERE path=?').bind(segs.join('/')).first();
  const d = row ? JSON.parse(row.data) : null;
  if (d && !canReadDoc(segs, user.id, d)) return { status: 403, body: { error: 'not_granted', code: 'not_granted' } };
  return { status: 200, body: d ? { exists: true, data: d } : { exists: false } };
}
// Many live views in one request: [{t:'doc', path} | {t:'q', collection, where, orderBy, limit}]
async function batchRoute(req, env, user) {
  const b = await body(req, 256 * 1024);
  const ops = Array.isArray(b.ops) ? b.ops.slice(0, 100) : [];
  const out = [];
  for (const op of ops) {
    try {
      const r = op && op.t === 'q' ? await runQuery(env, user, op) : await readDoc(env, user, op && op.path);
      out.push(r.status === 200 ? { ok: true, ...r.body } : { ok: false, status: r.status, ...r.body });
    } catch (e) { out.push({ ok: false, status: 500, error: 'failed' }); }
  }
  return json({ results: out });
}
async function docRoute(req, env, user, url) {
  if (req.method === 'GET') { const r = await readDoc(env, user, url.searchParams.get('path')); return json(r.body, r.status); }
  const b = await body(req, MAX_DOC_BYTES + 4096);
  const segs = parsePath(b.path, true);
  if (!segs) return json({ error: 'bad_path' }, 400);
  const path = segs.join('/');
  const existing = await env.DB.prepare('SELECT data, owner FROM docs WHERE path=?').bind(path).first();
  if (req.method === 'DELETE' || b.op === 'delete') {
    const err = await writeRule(env, segs, user.id, existing, null);
    if (err) return json({ error: err, code: 'not_granted' }, 403);
    await env.DB.prepare('DELETE FROM docs WHERE path=?').bind(path).run();
    if (segs[0] === 'groups' && segs.length === 2) await env.DB.prepare('DELETE FROM docs WHERE path LIKE ?').bind(path + '/%').run(); // deleting a group removes its chat
    return json({ ok: true });
  }
  if (req.method !== 'PUT' && req.method !== 'POST') return json({ error: 'method' }, 405);
  let data = b.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'bad_data' }, 400);
  if (b.op === 'update' && existing) data = { ...JSON.parse(existing.data), ...data };
  const err = await writeRule(env, segs, user.id, existing, data);
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
const FIELD = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,3}$/;
const sqlVal = v => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
async function queryRoute(req, env, user) {
  const r = await runQuery(env, user, await body(req, 64 * 1024));
  return json(r.body, r.status);
}
async function runQuery(env, user, q) {
  // Club activity: posts from every golfer, matched by course (a collection-group read; posts are shared with members)
  const group = q.collection === 'posts/*/items';
  const segs = group ? ['posts', '*', 'items'] : parsePath(q.collection, false);
  if (!segs) return { status: 400, body: { error: 'bad_path' } };
  if (!canReadPath(segs, user.id) || !(await groupGate(env, segs, user.id))) return { status: 403, body: { error: 'not_granted', code: 'not_granted' } };
  const where = group ? ["parent LIKE 'posts/%/items'"] : ['parent=?'], args = group ? [] : [segs.join('/')];
  if (group && !(q.where || []).length) return { status: 400, body: { error: 'bad_query' } };  // never dump every post
  // private collections: only rows this person may see
  if (segs[0] === 'friendreqs') { where.push("(json_extract(data,'$.from')=? OR json_extract(data,'$.to')=?)"); args.push(user.id, user.id); }
  if (segs[0] === 'dms' && segs.length === 1) { where.push("EXISTS (SELECT 1 FROM json_each(data,'$.members') WHERE value=?)"); args.push(user.id); }
  for (const [f, op, v] of (q.where || []).slice(0, 8)) {
    if (!FIELD.test(String(f))) return { status: 400, body: { error: 'bad_query' } };
    const col = `json_extract(data,'$.${f}')`;
    if (op === 'in') {
      const list = (Array.isArray(v) ? v : []).slice(0, 30);
      if (!list.length) return { status: 200, body: { docs: [] } };
      where.push(`${col} IN (${list.map(() => '?').join(',')})`); args.push(...list.map(sqlVal));
    } else if (op === 'array-contains') {
      where.push(`EXISTS (SELECT 1 FROM json_each(data,'$.${f}') WHERE value=?)`); args.push(sqlVal(v));
    } else if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      if (v === null && (op === '==' || op === '!=')) where.push(`${col} IS ${op === '==' ? '' : 'NOT '}NULL`);
      else { where.push(`${col} ${op === '==' ? '=' : op} ?`); args.push(sqlVal(v)); }
    } else return { status: 400, body: { error: 'bad_query' } };
  }
  const order = [];
  for (const [f, dir] of (q.orderBy || []).slice(0, 3)) {
    if (!FIELD.test(String(f))) return { status: 400, body: { error: 'bad_query' } };
    order.push(`json_extract(data,'$.${f}') ${dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  const lim = Math.max(1, Math.min(Number(q.limit) || 1000, 2000));
  const sql = `SELECT id, data FROM docs WHERE ${where.join(' AND ')}${order.length ? ' ORDER BY ' + order.join(', ') : ''} LIMIT ${lim}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return { status: 200, body: { docs: results.map(r => ({ id: r.id, data: JSON.parse(r.data) })) } };
}


// ---------- photos ----------
// Photos are shrunk in the browser, then stored in D1 (rows cap near 2 MB). Served by an unguessable id.
const BLOB_MAX = 1800 * 1024, BLOB_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
async function uploadRoute(req, env, user) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!BLOB_TYPES.includes(type)) return json({ error: 'Photos only for now (JPEG, PNG or WebP).', code: 'bad_type' }, 415);
  if (Number(req.headers.get('content-length') || 0) > BLOB_MAX) return json({ error: 'That photo is too large. Try a smaller one.', code: 'quota_exceeded' }, 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return json({ error: 'Empty file', code: 'bad_data' }, 400);
  if (buf.length > BLOB_MAX) return json({ error: 'That photo is too large. Try a smaller one.', code: 'quota_exceeded' }, 413);
  const day = new Date().toISOString().slice(0, 10);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE owner=? AND created>=?").bind(user.id, day).first();
  if (n && n.n >= 60) return json({ error: "You've hit today's photo limit.", code: 'rate_limited' }, 429);
  const id = randomId('b') + randomId('');
  await env.DB.prepare('INSERT INTO blobs(id, owner, type, data, size, created) VALUES(?,?,?,?,?,?)').bind(id, user.id, type, buf, buf.length, new Date().toISOString()).run();
  return json({ id, url: '/_blob/' + id, sizeBytes: buf.length, contentType: type });
}
async function blobRoute(env, id) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT type, data FROM blobs WHERE id=?').bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });
  const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
  return new Response(bytes, { headers: { 'content-type': row.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
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
