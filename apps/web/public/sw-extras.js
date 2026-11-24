/*
 * Additions to the generated service worker (imported first, see vite.config.ts).
 */

// The first install controls the open page right away, so it works offline and as a share
// target without a reload. Updates still wait for every tab to close (no skipWaiting).
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/*
 * Web Share Target (docs/UX.md § Send: Pick). The OS share sheet POSTs the files here;
 * they are parked in a private cache and the app picks them up from `?shared`
 * (lib/state/shared-files.ts), then deletes them. Nothing leaves the device.
 */
const SHARE_CACHE = 'e2e-transfer-share';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !url.pathname.endsWith('/share-target')) return;
  event.respondWith(
    (async () => {
      const scope = self.registration.scope;
      try {
        const form = await event.request.formData();
        const files = form.getAll('files').filter((f) => typeof f === 'object' && 'name' in f);
        await caches.delete(SHARE_CACHE);
        const cache = await caches.open(SHARE_CACHE);
        await Promise.all(
          files.map((file, i) =>
            cache.put(
              new URL(`__shared/${i}`, scope).href,
              new Response(file, {
                headers: {
                  'content-type': file.type || 'application/octet-stream',
                  'x-file-name': encodeURIComponent(file.name),
                },
              }),
            ),
          ),
        );
      } catch {
        // Shown as an empty pick screen; the user can still choose files by hand.
      }
      return Response.redirect(new URL('./?shared', scope).href, 303);
    })(),
  );
});
