import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const catalogUi = await readFile(new URL('../src/features/crm/catalog/components/CatalogUi.tsx', import.meta.url), 'utf8')
const themeStyles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const productsPage = await readFile(new URL('../src/features/crm/catalog/pages/CatalogProductsPage.tsx', import.meta.url), 'utf8')

test('catalog pages share the CRM panel, header, status and checkbox primitives', () => {
  assert.match(catalogUi, /export function CatalogPanel/)
  assert.match(catalogUi, /export function CatalogPanelHeader/)
  assert.match(catalogUi, /export function CatalogStatus/)
  assert.match(catalogUi, /export function CatalogCheckbox/)
  assert.match(productsPage, /<CatalogPanel>/)
  assert.match(productsPage, /<CatalogPanelHeader/)
  assert.match(productsPage, /<CatalogStatus active=/)
  assert.match(productsPage, /<CatalogCheckbox/)
})

test('catalog components own their Tailwind styles and consume only CRM theme tokens', () => {
  assert.ok(catalogUi.includes('bg-[var(--crm-surface)]'))
  assert.ok(catalogUi.includes('border-[var(--crm-border-subtle)]'))
  assert.ok(catalogUi.includes('bg-[var(--crm-green-soft)]'))
  assert.ok(productsPage.includes('bg-[var(--crm-blue)]'))
  assert.doesNotMatch(themeStyles, /\.crm-(?:primary-button|input|status-pill|catalog-panel)\b/)
  assert.doesNotMatch(catalogUi, /#8bec20/i)
})

test('the products table reserves a stable column for all row actions', () => {
  assert.match(productsPage, /<DataTable[\s\S]*aria-label="Productos del catálogo"/)
  assert.ok(productsPage.includes('min-w-[940px]'))
  assert.match(productsPage, /aria-label="Acciones"[\s\S]*data-sortable="false"/)
  assert.ok(productsPage.includes('Duplicar ${summary.product.name}'))
  assert.match(productsPage, /<Dropdown>/)
  assert.match(productsPage, /Duplicar aquí/)
  assert.match(productsPage, /Duplicar en \{venue\.name\}/)
})

test('product sorting lives in clickable column headers without manual reorder controls', () => {
  assert.match(productsPage, /sortDescriptor=\{\{ column: sortKey/)
  assert.match(productsPage, /data-column-key="product"/)
  assert.match(productsPage, /data-column-key="price"/)
  assert.match(productsPage, /onSortChange=/)
  assert.doesNotMatch(productsPage, /Ordenar productos|Subir producto|Bajar producto|\bmoveProduct\b/)
})
