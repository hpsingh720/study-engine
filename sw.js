// Offline support: cache the app shell and libraries; never cache API calls.
const CACHE = 'study-engine-v53';
const LIBS = 'study-engine-libs'; // libraries kept across app updates
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'util.js', 'seed.js', 'db.js', 'semantic.js', 'embed-worker.js', 'ai.js', 'providers.js', 'engine.js', 'sync.js', 'practice.js', 'planner.js', 'notes.js', 'views.js', 'app.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.3.11.174/pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.3.11.174/pdf.worker.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u))))); self.skipWaiting(); });
// Only old app-shell caches are removed — never the libraries or the offline AI model (transformers-cache).
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('study-engine-v') && k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || /googleapis\.com|supabase\.co|huggingface\.co|hf\.co/.test(u.hostname)) return; // the AI model caches itself
  // App files: network first (so updates arrive), cache fallback offline. Libraries: cache first.
  const lib = /cdnjs|jsdelivr|tessdata/.test(u.hostname);
  e.respondWith(lib
    ? caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res.ok) { const c = res.clone(); caches.open(LIBS).then(k => k.put(e.request, c)); } return res; }))
    : fetch(e.request).then(res => { if (res.ok && u.origin === location.origin) { const c = res.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); } return res; })
        .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
