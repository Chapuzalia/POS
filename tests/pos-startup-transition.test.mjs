import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('la carga del TPV ocupa toda la pantalla y deja de usar una card', async () => {
  const screen = await readFile(new URL('../src/components/screens/StateScreens.tsx', import.meta.url), 'utf8')
  const normalizedScreen = screen.replaceAll('\r\n', '\n')
  const loadingScreen = normalizedScreen.match(/export function LoadingScreen[\s\S]*?\n}\n\ntype PosStartupRevealProps/)?.[0] ?? ''

  assert.match(loadingScreen, /role="status"/)
  assert.match(loadingScreen, /h-full min-h-0 w-full/)
  assert.match(loadingScreen, /pos-loading-orbit/)
  assert.match(loadingScreen, /pos-loading-progress/)
  assert.doesNotMatch(loadingScreen, /<section[^>]*max-w-md/)
})

test('el TPV aparece con zoom al terminar la carga y respeta movimiento reducido', async () => {
  const [screen, appShell, styles] = await Promise.all([
    readFile(new URL('../src/components/screens/StateScreens.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ])

  assert.match(screen, /prefers-reduced-motion: reduce/)
  assert.match(screen, /pos-shell-zoom-in/)
  assert.match(screen, /pos-loading-exit/)
  assert.match(appShell, /<PosStartupReveal><CashSessionGate/)
  assert.match(appShell, /<PosStartupReveal><PosPage/)
  assert.match(styles, /@keyframes pos-shell-zoom-in[\s\S]*scale\(\.92\)[\s\S]*scale\(1\)/)
})
