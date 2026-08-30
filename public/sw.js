const CACHE_PREFIX = 'tickit-pos'
const CACHE_VERSION = 'v1'
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/apple-touch-icon.png',
  '/icons/pwa-192x192.png',
  '/icons/pwa-512x512.png',
  '/icons/pwa-maskable-512x512.png',
]
const CACHEABLE_DESTINATIONS = new Set(['font', 'image', 'script', 'style', 'worker'])

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith(`${CACHE_PREFIX}-`) && cacheName !== STATIC_CACHE)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

async function networkFirstNavigation(request) {
  const cache = await caches.open(STATIC_CACHE)

  try {
    const response = await fetch(request)
    if (response.ok) await cache.put('/index.html', response.clone())
    return response
  } catch {
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error()
  }
}

async function cacheFirstStaticAsset(request) {
  const cachedResponse = await caches.match(request)
  if (cachedResponse) return cachedResponse

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (CACHEABLE_DESTINATIONS.has(request.destination)) {
    event.respondWith(cacheFirstStaticAsset(request))
  }
})
