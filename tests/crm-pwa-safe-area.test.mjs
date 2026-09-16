import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8')

test('the installed CRM PWA keeps its header below the iOS status area', () => {
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /apple-mobile-web-app-status-bar-style"[^>]*content="default"/)
  assert.doesNotMatch(html, /black-translucent/)
  assert.ok(shell.includes('[.pwa-standalone_&]:!pt-') || shell.includes('pwa-standalone'))
})

test('standalone mode is detected through both the standard and iOS APIs', () => {
  assert.ok(main.includes('navigator as Navigator & { standalone?: boolean }'))
  assert.ok(main.includes("matchMedia('(display-mode: standalone)')"))
  assert.ok(main.includes("document.documentElement.classList.add('pwa-standalone')"))
})

test('the installed CRM sidebar also clears the iOS status area', () => {
  assert.ok(sidebar.includes('pwa-standalone'))
  assert.ok(sidebar.includes('safe-area-inset-top'))
})

test('the iPhone CRM drawer keeps active submenu labels visible', () => {
  assert.ok(sidebar.includes('!min-w-0'))
  assert.ok(sidebar.includes('!flex-1'))
  assert.ok(sidebar.includes('!truncate'))
})

test('the mobile CRM drawer can be closed from its header or backdrop', () => {
  assert.ok(sidebar.includes('onClick={onClose}'))
  assert.ok(sidebar.includes('aria-label="Cerrar menú de navegación"'))
})
