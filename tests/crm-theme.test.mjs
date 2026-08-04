import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const sidebar = await readFile(new URL('../src/features/crm/layout/CrmSidebar.tsx', import.meta.url), 'utf8')
const productForm = await readFile(new URL('../src/features/crm/catalog/forms/CatalogProductEditor.tsx', import.meta.url), 'utf8')
const select = await readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the CRM theme is scoped and persists independently from the POS theme', () => {
  assert.match(shell, /data-crm-theme={crmTheme}/)
  assert.ok(shell.includes('localStorage.setItem(CRM_THEME_STORAGE_KEY, nextTheme)'))
  assert.ok(styles.includes(".crm-shell[data-crm-theme='dark']"))
  assert.ok(!styles.includes(":root[data-theme='club-night'] .crm-shell"))
})

test('the theme control is rendered beside logout', () => {
  assert.ok(sidebar.includes('<footer className="!grid !grid-cols-2'))
  assert.match(sidebar, /Cambiar CRM a modo claro/)
  assert.ok(sidebar.includes('<span>Salir</span>'))
})

test('catalog forms and modal headers own Tailwind styles backed by CRM tokens', () => {
  assert.match(productForm, /CrmModal/)
  assert.ok(productForm.includes('var(--crm-border-subtle)'))
  assert.ok(productForm.includes('var(--crm-text-muted)'))
  assert.ok(productForm.includes('bg-[var(--crm-input-bg)]'))
  assert.ok(productForm.includes('text-[var(--crm-text)]'))
  assert.doesNotMatch(styles, /\.crm-input\b/)
})

test('light theme separates the canvas, cards and form controls through tokens', () => {
  assert.match(styles, /--crm-canvas: #f3f5f7/)
  assert.match(styles, /--crm-surface: #ffffff/)
  assert.match(styles, /--crm-input-border: #cfd6df/)
  assert.match(styles, /--crm-shadow-card: 0 0 0 1px/)
  assert.ok(select.includes('border-[var(--crm-input-border)]'))
  assert.ok(select.includes('bg-[var(--crm-input-bg)]'))
  assert.ok(styles.includes(":root:has(.crm-shell:not([data-crm-theme='dark']))"))
  assert.match(styles, /:root:has\(\.crm-shell:not\(\[data-crm-theme='dark'\]\)\) \{[\s\S]*?--background: #f3f5f7/)
  assert.match(styles, /:root:has\(\.crm-shell\[data-crm-theme='dark'\]\) \{[\s\S]*?--background: #000000/)
})
