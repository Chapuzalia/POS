import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the POS viewport disables native browser scaling on iPad', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /maximum-scale=1/)
  assert.match(html, /user-scalable=no/)
  assert.match(html, /viewport-fit=cover/)
})

test('the POS locks Safari gestures while preserving the custom table-map viewport', async () => {
  const [hook, styles, mapStyles, viewport] = await Promise.all([
    readFile(new URL('../src/app/usePosViewportLock.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/components/map-viewport.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/tables/useMapViewport.ts', import.meta.url), 'utf8'),
  ])

  assert.match(hook, /gesturestart/)
  assert.match(hook, /event\.touches\.length > 1/)
  assert.match(hook, /passive: false/)
  assert.match(styles, /html\.pos-viewport-locked[\s\S]+overscroll-behavior: none[\s\S]+touch-action: pan-x pan-y/)
  assert.match(styles, /body\.pos-viewport-locked[\s\S]+position: fixed/)
  assert.match(mapStyles, /\.table-map-canvas\{cursor:grab;touch-action:none\}/)
  assert.match(viewport, /pinchRef/)
  assert.match(viewport, /zoomAtPoint/)
})
