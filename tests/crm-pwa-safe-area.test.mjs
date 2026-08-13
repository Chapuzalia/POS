import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the installed CRM PWA keeps its header below the iOS status area', () => {
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="default"/)
  assert.doesNotMatch(html, /black-translucent/)
  assert.ok(shell.includes('[.pwa-standalone_&]:!pt-[calc(0.625rem+env(safe-area-inset-top,0px))]'))
  assert.doesNotMatch(styles, /\.pwa-standalone\s+\.crm-/)
})

test('standalone mode is detected through both the standard and iOS APIs', () => {
  assert.ok(main.includes('navigator as Navigator & { standalone?: boolean }'))
  assert.ok(main.includes("matchMedia('(display-mode: standalone)')"))
  assert.ok(main.includes("document.documentElement.classList.add('pwa-standalone')"))
})

test('the installed CRM sidebar also clears the iOS status area', () => {
  assert.ok(sidebar.includes('[.pwa-standalone_&]:!pt-[env(safe-area-inset-top,0px)]'))
})

test('the iPhone CRM drawer keeps active submenu labels visible', () => {
  assert.match(sidebar, /const itemClass = '[^']*!flex[^']*!min-w-0/)
  assert.ok(sidebar.includes('<span className="!min-w-0 !flex-1 !truncate">{item.label}</span>'))
  assert.match(sidebar, /!grid !gap-0.5 !border-l/)
})

test('the mobile CRM drawer can be closed from its header or backdrop', () => {
  assert.match(sidebar, /<div[\s\S]*aria-hidden="true"[\s\S]*onClick=\{onClose\}/)
  assert.ok(sidebar.includes('aria-label="Cerrar menú de navegación"'))
  assert.ok(sidebar.includes('<X className="!size-5" />'))
})
