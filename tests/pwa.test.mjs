import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const projectRoot = new URL('../', import.meta.url)

async function readProjectFile(path, encoding = 'utf8') {
  return readFile(new URL(path, projectRoot), encoding)
}

function readPngDimensions(buffer) {
  const pngSignature = '89504e470d0a1a0a'
  assert.equal(buffer.subarray(0, 8).toString('hex'), pngSignature)

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

test('PWA manifest cumple los requisitos de instalacion de Chrome', async () => {
  const manifest = JSON.parse(await readProjectFile('public/manifest.webmanifest'))

  assert.equal(manifest.id, '/')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.prefer_related_applications, false)

  const iconsBySize = new Map(manifest.icons.map((icon) => [icon.sizes, icon]))
  assert.equal(iconsBySize.get('192x192')?.type, 'image/png')
  assert.equal(iconsBySize.get('512x512')?.type, 'image/png')
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'))
})

test('los iconos PWA tienen las dimensiones declaradas', async () => {
  const icons = [
    ['public/icons/pwa-192x192.png', 192],
    ['public/icons/pwa-512x512.png', 512],
    ['public/icons/pwa-maskable-512x512.png', 512],
  ]

  for (const [path, expectedSize] of icons) {
    const dimensions = readPngDimensions(await readProjectFile(path, null))
    assert.deepEqual(dimensions, { width: expectedSize, height: expectedSize })
  }
})

test('la pagina enlaza el manifest y registra un service worker con soporte offline', async () => {
  const [html, entrypoint, serviceWorker] = await Promise.all([
    readProjectFile('index.html'),
    readProjectFile('src/main.tsx'),
    readProjectFile('public/sw.js'),
  ])

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(entrypoint, /registerServiceWorker\(\)/)
  assert.match(serviceWorker, /addEventListener\('install'/)
  assert.match(serviceWorker, /addEventListener\('fetch'/)
  assert.match(serviceWorker, /request\.mode === 'navigate'/)
})

test('primera instalación cachea shell, JS y CSS antes de abrir la PWA offline', async () => {
  const listeners = new Map()
  const responses = new Map()
  let online = true
  const assets = ['/assets/index-build.js', '/assets/PosPage-build.js', '/assets/PosPage-build.css']
  const key = (request) => new URL(typeof request === 'string' ? request : request.url, 'https://pos.test').pathname
  const fetch = async (request) => {
    if (!online) throw new TypeError('Failed to fetch')
    const path = key(request)
    return new Response(path === '/offline-assets.json' ? JSON.stringify(assets) : path.endsWith('.js') ? '/* POS chunk */' : 'app shell')
  }
  const cache = {
    addAll: async (requests) => { for (const request of requests) responses.set(key(request), await fetch(request)) },
    put: async (request, response) => responses.set(key(request), response),
    match: async (request) => responses.get(key(request))?.clone(),
  }
  const serviceWorker = await readProjectFile('public/sw.js')
  vm.runInNewContext(serviceWorker, {
    self: { location: { href: 'https://pos.test/sw.js?v=build-test', origin: 'https://pos.test' }, addEventListener: (type, callback) => listeners.set(type, callback) },
    caches: { open: async () => cache, match: cache.match }, fetch, URL, Response,
  })
  let installed
  listeners.get('install')({ waitUntil: (promise) => { installed = promise } })
  await installed
  online = false
  for (const [url, mode, destination] of [['/pos', 'navigate', 'document'], ...assets.map((asset) => [asset, 'cors', asset.endsWith('.css') ? 'style' : 'script'])]) {
    let result
    listeners.get('fetch')({ request: { url: `https://pos.test${url}`, method: 'GET', mode, destination }, respondWith: (promise) => { result = promise } })
    assert.equal((await result).ok, true, `${url} must be available without a second online visit`)
  }
  let intercepted = false
  listeners.get('fetch')({ request: { url: 'https://supabase.test/auth/v1/token', method: 'GET' }, respondWith: () => { intercepted = true } })
  assert.equal(intercepted, false, 'Auth responses must not be served from the PWA cache')

  listeners.get('fetch')({ request: { url: 'https://pos.test/app-version.json', method: 'GET', mode: 'cors', destination: '' }, respondWith: () => { intercepted = true } })
  assert.equal(intercepted, false, 'The remote version policy must always bypass the PWA cache')
  assert.doesNotMatch(serviceWorker, /skipWaiting|clients\.claim/)
})

test('Vercel impide cachear la política de versión y el manifiesto offline', async () => {
  const config = JSON.parse(await readProjectFile('vercel.json'))
  const headers = new Map(config.headers.map((entry) => [entry.source, entry.headers]))

  for (const path of ['/app-version.json', '/offline-assets.json']) {
    assert.match(headers.get(path)?.find((header) => header.key === 'Cache-Control')?.value ?? '', /no-store/)
  }
})
