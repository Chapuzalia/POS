import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/components/crm/crm.css', import.meta.url), 'utf8')

test('the installed CRM PWA keeps its header below the iOS status area', () => {
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="default"/)
  assert.doesNotMatch(html, /black-translucent/)
  assert.match(styles, /\.pwa-standalone \.crm-dashboard-shell \.crm-topbar \{[\s\S]*padding-top: calc\(0\.625rem \+ env\(safe-area-inset-top, 0px\)\) !important/)
})

test('standalone mode is detected through both the standard and iOS APIs', () => {
  assert.match(main, /navigator as Navigator & \{ standalone\?: boolean \}/)
  assert.match(main, /matchMedia\('\(display-mode: standalone\)'\)/)
  assert.match(main, /document\.documentElement\.classList\.add\('pwa-standalone'\)/)
})

test('the installed CRM sidebar also clears the iOS status area', () => {
  assert.match(styles, /\.pwa-standalone \.crm-dashboard-shell \.crm-sidebar \{[\s\S]*padding-top: calc\(1\.5rem \+ env\(safe-area-inset-top, 0px\)\) !important/)
})
