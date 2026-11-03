// Service Worker: macht das Spiel installierbar und lädt es schnell / offline.
// Spielseite: erst Netz (damit Updates sofort ankommen), sonst Zwischenspeicher. Bibliotheken & Icons: Zwischenspeicher zuerst.
const CACHE = 'clutch-v4'; // Version erhöhen → alter Zwischenspeicher wird beim Update gelöscht
const GAME = ['/css/base.css', '/css/lowpoly.css', '/css/hud.css', '/css/mobile.css', '/css/theme-v.css', '/js/i18n.js', '/js/game.js']; // Spieldateien neben der Seite
const CORE = ['/', ...GAME, '/manifest.json', '/icon-192.png', '/icon-512.png', 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/av/')) return; // Accounts/Karten-API & Profilbilder nie zwischenspeichern (entfernte Bilder sollen verschwinden)
  const page = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (page) {
    e.respondWith(fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('/', cp)); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (url.origin === location.origin && GAME.includes(url.pathname)) { // Spiel-CSS/JS: wie die Seite erst Netz, damit Updates zusammen ankommen
    e.respondWith(fetch(req, { cache: 'no-store' }).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname, cp)); } return r; }).catch(() => caches.match(url.pathname)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return r;
  })));
});
