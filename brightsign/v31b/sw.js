const CACHE_NAME = 'sf-v31-media';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', event => {
  const url = event.request.url;
  if (!url.startsWith('http')) return;
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  if (!['jpg','jpeg','png','gif','webp'].includes(ext)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && response.type === 'basic') cache.put(event.request, response.clone());
          return response;
        });
      })
    )
  );
});