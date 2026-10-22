// JudgeFlow service worker (SPEC §9): keeps the app shell and built assets available offline
// so the Judge Desk reloads without a network. The cache name and the precache
// list are injected at build time by the `service-worker` plugin in vite.config.ts.
const CACHE = '__CACHE__'
const PRECACHE = JSON.parse('__PRECACHE__')
const SHELL = '/index.html'
const NAVIGATION_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// Network first with a short timeout: fresh deploys win, flaky venue Wi-Fi falls back to the shell.
async function navigate(request) {
  const cache = await caches.open(CACHE)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS)
  try {
    const response = await fetch(request, { signal: controller.signal })
    if (response.ok) {
      cache.put(SHELL, response.clone())
      return response
    }
    // A proxy error page (502/503 during a deploy) must not replace a working cached shell.
    return (await cache.match(SHELL)) ?? response
  } catch {
    const shell = await cache.match(SHELL)
    if (shell) return shell
    throw new Error('offline and no cached app shell')
  } finally {
    clearTimeout(timer)
  }
}

// Hashed assets are immutable, so cache-first is safe.
async function asset(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Never touch the API (incl. SSE streams); only same-origin static files are cached.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
  } else if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(asset(request))
  }
})
