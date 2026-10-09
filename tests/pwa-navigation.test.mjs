import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const origin = 'https://tickit.example'

test('initial HTML identifies separate installable apps with valid same-origin manifest URLs', () => {
  const apps = [
    ['index.html', 'manifest.webmanifest', '/', '/'],
    ['crm/index.html', 'crm.webmanifest', '/crm/', '/crm/'],
  ]
  const ids = new Set()
  for (const [entry, filename, start, scope] of apps) {
    const html = read(entry)
    const manifestLinks = [...html.matchAll(/<link\s+rel="manifest"\s+href="([^"]+)"/g)]
    assert.equal(manifestLinks.length, 1)
    assert.equal(manifestLinks[0][1], `/${filename}`)
    const manifest = JSON.parse(read(`public/${filename}`))
    assert.equal(manifest.start_url, start)
    assert.equal(manifest.scope, scope)
    assert.equal(manifest.display, 'standalone')
    const idUrl = new URL(manifest.id, origin)
    const startUrl = new URL(manifest.start_url, origin)
    const scopeUrl = new URL(manifest.scope, origin)
    assert.equal(idUrl.origin, origin)
    assert.equal(startUrl.origin, origin)
    assert.equal(scopeUrl.origin, origin)
    assert.ok(startUrl.pathname.startsWith(scopeUrl.pathname))
    assert.ok(!ids.has(idUrl.href))
    ids.add(idUrl.href)
    for (const icon of manifest.icons) {
      assert.ok(existsSync(new URL(`../public${icon.src}`, import.meta.url)))
      assert.match(icon.sizes, /^\d+x\d+$/)
      assert.equal(icon.type, 'image/png')
    }
    assert.ok(html.includes('/src/main.tsx'))
    assert.ok(!html.includes('configureManifest'))
    if (start === '/crm/') {
      assert.equal(manifest.name, 'Tickit CRM')
      assert.ok(html.includes('<title>Tickit CRM</title>'))
      assert.ok(html.includes('name="apple-mobile-web-app-title" content="Tickit CRM"'))
    }
  }
})

function worker() {
  const handlers = new Map()
  const entries = new Map()
  let offline = false
  const cache = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => entries.set(key, response.clone()),
    addAll: async (paths) => {
      for (const path of paths) {
        const response = await fetchResponse(path)
        if (!response.ok) throw new Error(`Cannot cache ${path}`)
        entries.set(path, response)
      }
    },
  }
  async function fetchResponse(request) {
    if (offline) throw new TypeError('Network unavailable')
    const path = new URL(typeof request === 'string' ? request : request.url, origin).pathname
    if (path === '/offline-assets.json') return new Response('[]')
    const entry = path === '/crm' || path.startsWith('/crm/') ? 'crm/index.html' : 'index.html'
    return new Response(read(entry), { headers: { 'Content-Type': 'text/html' } })
  }
  vm.runInNewContext(read('public/sw.js'), {
    URL, Response, fetch: fetchResponse,
    caches: { open: async () => cache },
    self: { location: { href: `${origin}/sw.js?v=test`, origin },
      addEventListener: (name, handler) => handlers.set(name, handler) },
  })
  return {
    entries, offline: () => { offline = true },
    install: async () => {
      let pending
      handlers.get('install')({ waitUntil: (promise) => { pending = promise } })
      await pending
    },
    navigate: async (path) => {
      let pending
      handlers.get('fetch')({
        request: { url: new URL(path, origin).href, method: 'GET', mode: 'navigate' },
        respondWith: (promise) => { pending = promise },
      })
      return pending
    },
  }
}

test('worker precaches both HTML entries and does not mix them across online and offline navigation', async () => {
  const app = worker()
  await app.install()
  assert.ok(app.entries.has('/crm/index.html'))
  assert.ok(app.entries.has('/index.html'))
  // Visit CRM last: the old worker overwrote the POS fallback with its HTML.
  await app.navigate('/')
  await app.navigate('/crm/?install=1')
  app.offline()
  for (const path of ['/', '/superadmin', '/crm/', '/crm/?install=1']) {
    const response = await app.navigate(path)
    assert.equal(response.status, 200)
    const html = await response.text()
    const manifest = path.startsWith('/crm') ? '/crm.webmanifest' : '/manifest.webmanifest'
    assert.ok(html.includes(`href="${manifest}"`), path)
  }
})

test('controlled CRM navigation canonicalizes the legacy URL offline and preserves its query', async () => {
  const app = worker()
  await app.install()
  app.offline()
  const redirect = await app.navigate('/crm?install=1')
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.get('Location'), `${origin}/crm/?install=1`)
  const html = await (await app.navigate(redirect.headers.get('Location'))).text()
  assert.ok(html.includes('href="/crm.webmanifest"'))
})

test('missing CRM cache fails rather than installing CRM with the POS manifest', async () => {
  const app = worker()
  await app.install()
  app.entries.delete('/crm/index.html')
  app.offline()
  assert.equal((await app.navigate('/crm/')).type, 'error')
  assert.equal((await app.navigate('/')).status, 200)
})
