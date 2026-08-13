import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  filterDiscountTargetOptions,
  getDiscountTargetCategoryOptions,
  getDiscountTargetVariantOptions,
} from '../src/features/crm/discounts/discountTargetFilters.ts'

const options = [
  {
    id: 'absolut',
    name: 'Absolut',
    categories: [{ id: 'spirits', name: 'Destilados' }],
    variants: [{ id: 'shot', name: 'Chupito' }, { id: 'long', name: 'Cubata' }],
  },
  {
    id: 'water',
    name: 'Agua',
    categories: [{ id: 'soft', name: 'Sin alcohol' }],
    variants: [{ id: 'refreshment', name: 'Refresco' }],
  },
]

test('filtra productos de descuento por búsqueda, categoría y variante sin alterar la selección original', () => {
  assert.deepEqual(
    filterDiscountTargetOptions(options, { categoryId: 'all', query: 'cúb', variantName: 'all' })
      .map((product) => [product.id, product.variants.map((variant) => variant.name)]),
    [['absolut', ['Cubata']]],
  )
  assert.deepEqual(
    filterDiscountTargetOptions(options, { categoryId: 'soft', query: '', variantName: 'all' })
      .map((product) => product.id),
    ['water'],
  )
  assert.deepEqual(
    filterDiscountTargetOptions(options, { categoryId: 'all', query: '', variantName: 'chupito' })
      .map((product) => [product.id, product.variants.map((variant) => variant.name)]),
    [['absolut', ['Chupito']]],
  )
  assert.equal(options[0].variants.length, 2)
})

test('deduplica y ordena las opciones compactas de categoría y variante', () => {
  assert.deepEqual(getDiscountTargetCategoryOptions(options), [
    { label: 'Categoría', value: 'all' },
    { label: 'Destilados', value: 'spirits' },
    { label: 'Sin alcohol', value: 'soft' },
  ])
  assert.deepEqual(getDiscountTargetVariantOptions(options), [
    { label: 'Variante', value: 'all' },
    { label: 'Chupito', value: 'chupito' },
    { label: 'Cubata', value: 'cubata' },
    { label: 'Refresco', value: 'refresco' },
  ])
})

test('el editor ocupa la altura disponible y conserva la barra de filtros fuera del scroll de productos', async () => {
  const page = await readFile(new URL('../src/features/crm/discounts/pages/DiscountsPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /className="flex h-full min-h-0 flex-col"/)
  assert.match(page, /className="grid min-h-0 flex-1 content-start[^"]*overflow-y-auto/)
  assert.doesNotMatch(page, /max-h-\[78svh\]/)
  assert.match(page, /aria-label="Buscar productos o variantes"/)
  assert.match(page, /ariaLabel="Filtrar por categoría"/)
  assert.match(page, /ariaLabel="Filtrar por variante"/)
})
