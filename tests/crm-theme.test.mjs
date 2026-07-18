import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/components/crm/crm.css', import.meta.url), 'utf8')

test('the CRM theme is scoped and persists independently from the POS theme', () => {
  assert.match(page, /data-crm-theme=\{crmTheme\}/)
  assert.match(page, /localStorage\.setItem\(CRM_THEME_STORAGE_KEY, nextTheme\)/)
  assert.match(styles, /\.crm-shell\[data-crm-theme='dark'\]/)
  assert.doesNotMatch(styles, /:root\[data-theme='club-night'\] \.crm-shell/)
})

test('the theme control is rendered beside logout', () => {
  assert.match(page, /crm-sidebar-footer[^\n]+!grid-cols-2/)
  assert.match(page, /Cambiar CRM a modo claro/)
  assert.match(page, /<span className="!truncate">Salir<\/span>/)
})

test('discount forms and modal headers use CRM theme tokens', () => {
  assert.match(page, /crm-editor-header[^\n]+!bg-transparent[^\n]+!text-\[var\(--crm-text\)\]/)
  assert.match(page, /crm-color-field/)
  assert.match(styles, /\.crm-shell \.crm-input \{[\s\S]*color: var\(--crm-text\)/)
})
