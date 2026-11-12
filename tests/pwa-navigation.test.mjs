import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const origin = 'https://tickit.example'

function worker({ assets = [], assetType = 'text/javascript' } = {}) {
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
    if (path === '/offline-assets.json') return new Response(JSON.stringify(assets))
    if (path.startsWith('/assets/')) return new Response(assetType === 'text/html' ? read('index.html') : 'export {}', { headers: { 'Content-Type': assetType } })
    if (path.startsWith('/legal/')) return new Response(`Legal document ${path}`, { headers: { 'Content-Type': 'text/html' } })
    const entry = path === '/crm' || path.startsWith('/crm/') ? 'crm/index.html' : 'index.html'
    return new Response(read(entry), { headers: { 'Content-Type': 'text/html' } })
  }
  vm.runInNewContext(read('public/sw.js'), {
    URL, Response, fetch: fetchResponse,
    caches: { open: async () => cache, match: async (key) => cache.match(key) },
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
    request: async (path, destination) => {
      let pending
      handlers.get('fetch')({
        request: { url: new URL(path, origin).href, method: 'GET', mode: 'cors', destination },
        respondWith: (promise) => { pending = promise },
      })
      return pending
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
  for (const path of ['/', '/superadmin', '/crm/', '/crm/?install=1', '/crm/products']) {
    const response = await app.navigate(path)
    assert.equal(response.status, 200)
    const html = await response.text()
    const manifest = path.startsWith('/crm') ? '/crm.webmanifest' : '/manifest.webmanifest'
    assert.ok(html.includes(`href="${manifest}"`), path)
  }
})

test('worker never stores the SPA fallback HTML as a JavaScript chunk', async () => {
  const healthy = worker({ assets: ['/assets/main-abc.js'] })
  await healthy.install()
  assert.ok(healthy.entries.has('/assets/main-abc.js'))

  // A rollout or CDN served index.html for a chunk: keep the current worker instead.
  const poisoned = worker({ assets: ['/assets/main-abc.js'], assetType: 'text/html' })
  await assert.rejects(poisoned.install(), /Recurso offline no válido: \/assets\/main-abc\.js/)
  assert.equal(poisoned.entries.has('/assets/main-abc.js'), false)
  await poisoned.request('/assets/lazy-def.js', 'script')
  assert.equal([...poisoned.entries.keys()].some((key) => String(key?.url ?? key).includes('lazy-def')), false)
})

test('legal documents keep their own offline copy and never replace the POS or CRM shell', async () => {
  const app = worker()
  await app.install()
  const path = '/legal/2026-11-12/condiciones-saas.html'
  assert.equal(await (await app.navigate(path)).text(), `Legal document ${path}`)
  app.offline()
  assert.equal(await (await app.navigate(path)).text(), `Legal document ${path}`)
  assert.ok((await (await app.navigate('/')).text()).includes('href="/manifest.webmanifest"'))
  assert.ok((await (await app.navigate('/crm/')).text()).includes('href="/crm.webmanifest"'))
  assert.equal((await app.navigate('/legal/missing.html')).type, 'error')
})
