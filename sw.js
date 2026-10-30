/* Service worker: guarda la app en el celular para que abra sin internet.
 * Al publicar cambios en GitHub, suba el número de VERSION para que los celulares descarguen la nueva. */
const VERSION = 'pp-v1.0.0';
const ARCHIVOS = [
  './', './index.html', './manifest.webmanifest', './vendor/chart.umd.js', './fonts/fonts.css',
  './fonts/bricolage-latin.woff2', './fonts/bricolage-latin-ext.woff2',
  './fonts/onest-400.woff2', './fonts/onest-500.woff2', './fonts/onest-600.woff2', './fonts/onest-700.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Solo archivos de la propia app; la sincronización con Google siempre va por la red.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Primero lo guardado (abre al instante y sin internet); se actualiza en segundo plano.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const guardado = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
                     (req.mode === 'navigate' ? await cache.match('./index.html') : null);
    const red = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => guardado);
    return guardado || red;
  }));
});
