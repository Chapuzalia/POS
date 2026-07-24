import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const productForm = await readFile(new URL('../src/features/crm/catalog/forms/CatalogProductEditor.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/components/crm/crm.css', import.meta.url), 'utf8')

test('the CRM theme is scoped and persists independently from the POS theme', () => {
  assert.match(shell, /data-crm-theme=\{crmTheme\}/)
  assert.match(shell, /localStorage\.setItem\(CRM_THEME_STORAGE_KEY, nextTheme\)/)
  assert.match(styles, /\.crm-shell\[data-crm-theme='dark'\]/)
  assert.doesNotMatch(styles, /:root\[data-theme='club-night'\] \.crm-shell/)
})

test('the theme control is rendered beside logout', () => {
  assert.match(shell, /crm-sidebar-footer[^\n]+!grid-cols-2/)
  assert.match(shell, /Cambiar CRM a modo claro/)
  assert.match(shell, /<span className="!truncate">Salir<\/span>/)
})

test('catalog forms and modal headers continue using CRM theme tokens', () => {
  assert.match(productForm, /CrmModal/)
  assert.match(productForm, /var\(--crm-border-subtle\)/)
  assert.match(productForm, /var\(--crm-text-muted\)/)
  assert.match(styles, /\.crm-shell \.crm-input \{[\s\S]*color: var\(--crm-text\)/)
})

test('light theme separates the canvas, cards and form controls', () => {
  assert.match(styles, /--crm-canvas: #f3f5f7/)
  assert.match(styles, /--crm-surface: #ffffff/)
  assert.match(styles, /--crm-input-border: #cfd6df/)
  assert.match(styles, /\.crm-shell:not\(\[data-crm-theme='dark'\]\) \.crm-input,[\s\S]*border-color: var\(--crm-input-border\) !important/)
  assert.match(styles, /--crm-shadow-card: 0 0 0 1px/)
})
