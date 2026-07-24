import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const catalogUi = await readFile(new URL('../src/features/crm/catalog/components/CatalogUi.tsx', import.meta.url), 'utf8')
const catalogStyles = await readFile(new URL('../src/features/crm/catalog/components/catalog-ui.css', import.meta.url), 'utf8')
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

test('catalog controls use CRM tokens instead of the legacy POS palette', () => {
  assert.match(catalogStyles, /\.crm-shell \.crm-primary-button \{ background: var\(--crm-blue\)/)
  assert.match(catalogStyles, /\.crm-shell \.crm-input \{[\s\S]*background: var\(--crm-input-bg\)/)
  assert.match(catalogStyles, /\.crm-status-pill-active \{ background: var\(--crm-green-soft\)/)
  assert.doesNotMatch(catalogStyles, /#8bec20/i)
})

test('the products table reserves a stable column for all row actions', () => {
  assert.match(productsPage, /crm-catalog-products-table/)
  assert.match(catalogStyles, /grid-template-columns:[^;]+168px/)
  assert.match(catalogStyles, /min-width: 940px !important/)
  assert.match(productsPage, /Duplicar \$\{summary\.product\.name\}/)
  assert.match(productsPage, /catalogAdminService\.duplicateProduct/)
})

test('product sorting lives in clickable column headers without manual reorder controls', () => {
  assert.match(productsPage, /function CatalogProductSortHeader/)
  assert.match(productsPage, /Ordenar por \$\{label\}/)
  assert.match(productsPage, /sortKey="product"/)
  assert.match(productsPage, /sortKey="price"/)
  assert.doesNotMatch(productsPage, /Ordenar productos|Subir producto|Bajar producto|\bmoveProduct\b/)
})
