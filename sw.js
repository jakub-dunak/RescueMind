/*
  RescueMind Service Worker (PWA‑lite)
  - Precache app shell for offline (HTML/CSS/JS)
  - Runtime cache: incidents manifest/files (cache-first), other GET requests (stale-while-revalidate)
  - Skips caching API calls (e.g., /api/plan) and third-party model/tiles
*/

const VERSION = 'v1';
const SHELL_CACHE = `rescuemind-shell-${VERSION}`;
const RUNTIME_CACHE = `rescuemind-runtime-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './authority.html',
  './styles.css?v=1',
  './app.js?v=1',
  './authority.js?v=4',
  './data/incidents/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, RUNTIME_CACHE].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return; // only cache GET
  // Bypass caching for API calls and external domains (OpenRouter, OSM tiles, etc.)
  if (/\/api\//.test(url.pathname) || url.origin !== self.location.origin) return;

  // Cache-first for incident JSON
  if (url.pathname.startsWith('/data/incidents/')) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // App shell + others: stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

