import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [catalogPanel, productDialog, productCard, mixerCard] = await Promise.all([
  readFile(new URL('../src/components/pos/CatalogPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosProductCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosMixerCard.tsx', import.meta.url), 'utf8'),
])

test('POS products use a dedicated card instead of the generic UI button', () => {
  assert.match(catalogPanel, /<PosProductCard/)
  assert.match(productCard, /<button/)
  assert.ok(productCard.includes('min-h-[228px]'))
  assert.match(productCard, /aspect-square/)
  assert.match(productCard, /object-cover/)
  assert.match(productCard, /alt={item.product.name}/)
})

test('mixer choices use the same vertical square-image card anatomy as products', () => {
  assert.match(productDialog, /<PosMixerCard/)
  assert.ok(productDialog.includes('!w-[calc(100vw-32px)]'))
  assert.ok(productDialog.includes('2xl:grid-cols-8'))
  assert.match(mixerCard, /<button/)
  assert.ok(mixerCard.includes('min-h-[228px]'))
  assert.match(mixerCard, /aspect-square/)
  assert.ok(mixerCard.includes('min-h-[88px]'))
  assert.match(mixerCard, /object-cover/)
  assert.match(mixerCard, /aria-pressed={selected}/)
})
