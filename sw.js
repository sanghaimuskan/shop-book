// Service worker: makes the app open and work with no internet.
// Bump VERSION whenever you deploy changes, so phones pick up the update.
const VERSION = "shopbook-v8";
const SHELL = [
  "./", "index.html", "app.css", "manifest.webmanifest",
  "js/app.js", "js/db.js", "js/sync.js", "js/config.js",
  "vendor/supabase.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png",
];
const FONTS = "shopbook-fonts";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== FONTS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: keep a copy so bills look right offline
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // Everything else from other sites (Supabase, WhatsApp) goes straight to the network
  if (url.origin !== self.location.origin) return;

  // Pages: try the network briefly, fall back to the saved app
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        return res;
      } catch {
        return (await caches.match("index.html", { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // App files: serve the saved copy instantly (updates arrive via a new VERSION)
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
