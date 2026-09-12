import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const productsPage = await readFile(new URL('../src/features/crm/catalog/pages/CatalogProductsPage.tsx', import.meta.url), 'utf8')

test('the products table reserves a stable column for all row actions', () => {
  assert.match(productsPage, /<DataTable[\s\S]*aria-label="Productos del catálogo"/)
  assert.match(productsPage, /aria-label="Acciones"[\s\S]*data-sortable="false"/)
  assert.match(productsPage, /<Dropdown>/)
})

test('product sorting lives in clickable column headers without manual reorder controls', () => {
  assert.match(productsPage, /sortDescriptor=\{\{ column: sortKey/)
  assert.match(productsPage, /data-column-key="product"/)
  assert.match(productsPage, /data-column-key="price"/)
  assert.match(productsPage, /onSortChange=/)
  assert.doesNotMatch(productsPage, /Ordenar productos|Subir producto|Bajar producto|\bmoveProduct\b/)
})
