import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const productForm = await readFile(new URL('../src/features/crm/catalog/forms/ProductForm.tsx', import.meta.url), 'utf8')
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

test('forms and modal headers continue using CRM theme tokens', () => {
  assert.match(productForm, /crm-editor-header[^\n]+!bg-transparent[^\n]+!text-\[var\(--crm-text\)\]/)
  assert.match(productForm, /crm-color-field/)
  assert.match(styles, /\.crm-shell \.crm-input \{[\s\S]*color: var\(--crm-text\)/)
})
