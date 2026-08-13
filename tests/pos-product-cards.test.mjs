import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [catalogPanel, productDialog, productCard, mixerCard, categoryCard, catalogTab, paymentPanel] = await Promise.all([
  readFile(new URL('../src/components/pos/CatalogPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/modals/ProductDialog.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosProductCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosMixerCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosCategoryCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PosCatalogTab.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/pos/PaymentPanel.tsx', import.meta.url), 'utf8'),
])

test('catalog tabs keep icon and label inside bordered fixed-height cards', () => {
  assert.match(catalogPanel, /<PosCatalogTab/)
  assert.ok(catalogPanel.includes('auto-cols-[minmax(4.75rem,1fr)]'))
  assert.ok(catalogPanel.includes('md:auto-cols-[minmax(5.25rem,1fr)]'))
  assert.ok(catalogPanel.includes('touch-pan-x'))
  assert.ok(catalogPanel.includes('overscroll-x-contain'))
  assert.ok(catalogTab.includes('h-14 min-h-14'))
  assert.ok(catalogTab.includes('border-[var(--separator)]'))
  assert.ok(catalogTab.includes('bg-[var(--accent)]'))
  assert.ok(catalogTab.includes('text-[var(--accent-foreground)]'))
})

test('payment actions reuse the large catalog tab visual language', () => {
  assert.equal((paymentPanel.match(/<PosCatalogTab/g) ?? []).length, 2)
  assert.ok(catalogTab.includes('h-20 min-h-20'))
  assert.ok(catalogTab.includes('tone === "danger"'))
  assert.ok(paymentPanel.includes("tone={discount ? 'danger' : 'default'}"))
})

test('POS products use a dedicated card instead of the generic UI button', () => {
  assert.match(catalogPanel, /<PosProductCard/)
  assert.match(productCard, /<button/)
  assert.ok(productCard.includes('min-h-[228px]'))
  assert.match(productCard, /aspect-square/)
  assert.match(productCard, /object-cover/)
  assert.match(productCard, /alt={item.product.name}/)
})

test('POS categories share the product card footprint and responsive grid', () => {
  assert.match(catalogPanel, /<PosCategoryCard/)
  assert.ok(catalogPanel.includes('grid grid-cols-3 gap-3 md:grid-cols-4 2xl:grid-cols-5'))
  assert.ok(categoryCard.includes('min-h-[98px]'))
})

test('mixer choices use the reference three-column horizontal selector', () => {
  assert.match(productDialog, /<PosMixerCard/)
  assert.ok(productDialog.includes('maxWidth={isChoosingMixer ? 1024 : 576}'))
  assert.ok(productDialog.includes('grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3'))
  assert.match(mixerCard, /<button/)
  assert.match(mixerCard, /h-28 min-h-28/)
  assert.ok(mixerCard.includes('grid-cols-[6rem_minmax(0,1fr)]'))
  assert.match(mixerCard, /object-cover/)
  assert.match(mixerCard, /aria-pressed={selected}/)
  assert.match(mixerCard, /{supplementCents \? \(/)
})
