// BluPrint Golf service worker: fast repeat opens and a working scorecard on a weak course signal.
// The page itself is network-first (so updates show up right away); static files are served from cache and refreshed in the background.
// Accounts, data and photos (/api, /auth, /_blob) always go to the network.
const VERSION = 'bp-2026-10-18';
const STATIC = /^\/(games\.js|bp-runtime\.js|manifest\.webmanifest|courses\.json|brand\/|fonts\/|tees\/)/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(['/', '/games.js', '/bp-runtime.js'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|auth|_blob)\//.test(url.pathname)) return;
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(networkFirst(req));
  } else if (STATIC.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, e));
  }
});
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 5000))]);
    if (res && res.ok) cache.put('/', res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match('/');
    if (hit) return hit;
    return fetch(req);
  }
}
async function staleWhileRevalidate(req, e) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  return (await net) || new Response('', { status: 504 });
}
