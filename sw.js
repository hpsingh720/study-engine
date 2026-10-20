// Offline support: cache the app shell and libraries; never cache API calls.
const CACHE = 'study-engine-v75';
const LIBS = 'study-engine-libs'; // libraries kept across app updates
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'util.js', 'seed.js', 'db.js', 'semantic.js', 'quality.js', 'embed-worker.js', 'ai.js', 'providers.js', 'engine.js', 'review.js', 'sync.js', 'practice.js', 'planner.js', 'notes.js', 'views.js', 'app.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.3.11.174/pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.3.11.174/pdf.worker.min.js'];
// App files go in the versioned cache; libraries go in the permanent one, and are only fetched if not already saved
// (so a WiFi blip during an update can never leave the app without its PDF reader).
self.addEventListener('install', e => {
  const isLib = u => /^https:/.test(u);
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => Promise.allSettled(SHELL.filter(u => !isLib(u)).map(u => c.add(u)))),
    caches.open(LIBS).then(c => Promise.allSettled(SHELL.filter(isLib).map(async u => { if (await c.match(u)) return; const old = await caches.match(u); if (old) return c.put(u, old); await c.add(u); }) /* reuse the copy an older version saved */))
  ]));
  self.skipWaiting();
});
// Only old app-shell caches are removed — never the libraries or the offline AI model (transformers-cache).
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('study-engine-v') && k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || /googleapis\.com|supabase\.co|huggingface\.co|hf\.co/.test(u.hostname)) return; // the AI model caches itself
  // App files: network first (so updates arrive), cache fallback offline. Libraries: cache first.
  const lib = /cdnjs|jsdelivr|unpkg|tessdata/.test(u.hostname);
  e.respondWith(lib
    ? caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok) { const c = res.clone(); caches.open(LIBS).then(k => k.put(e.request, c)); } return res; }))
    : fetch(u.origin === location.origin ? new Request(e.request, { cache: 'no-cache' }) : e.request).then(res => { if (res.ok && u.origin === location.origin) { const c = res.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return res; })
        .catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
