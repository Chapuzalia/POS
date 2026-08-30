import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

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
