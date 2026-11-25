// Service Worker — Hermes Motorista PWA (Network-First + Web Push)
// v3: quebra o cache antigo do celular (o sw.js anterior segurava a interface velha).
//     - CACHE_NAME com versão nova -> o cache antigo é apagado no 'activate'
//     - skipWaiting() + clients.claim() -> o novo SW assume o controle na hora
const CACHE_NAME = 'hermes-motorista-v5';
const STATIC_ASSETS = [
  '/motorista',
  '/styles.css?v=5',
  '/motorista.js?v=3',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // Assume o controle imediatamente: não espera todas as abas fecharem.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      // Apaga QUALQUER cache anterior (inclusive o v1/v2 do telefone).
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Permite forçar a atualização a partir da página (botão "Atualizar agora").
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/motorista')))
  );
});

// Web Push em background
self.addEventListener('push', (event) => {
  let payload = { title: 'Hermes Frota', body: 'Nova atualização operacional disponível.' };
  if (event.data) {
    try { payload = event.data.json(); } catch { payload.body = event.data.text(); }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Hermes Frota', {
      body: payload.body || 'Nova corrida disponível na fila.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200, 100, 250],
      data: { url: payload.url || '/motorista' },
      tag: payload.tag || 'hermes-driver-' + Date.now(),
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/motorista';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes('/motorista') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
