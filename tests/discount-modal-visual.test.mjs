import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [discountModal, discountOptionRow] = await Promise.all([
  readFile(new URL('../src/components/modals/DiscountModal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/modals/DiscountOptionRow.tsx', import.meta.url), 'utf8'),
])

test('discount modal matches the centered compact reference layout', () => {
  assert.ok(discountModal.includes('placement="center"'))
  assert.ok(discountModal.includes('max-w-xl'))
  assert.match(discountModal, /<DiscountOptionRow/)
  assert.ok(discountModal.includes('h-11 min-h-11'))
})

test('discount options are dedicated bordered rows with aligned value metadata', () => {
  assert.match(discountOptionRow, /<button/)
  assert.ok(discountOptionRow.includes('min-h-14'))
  assert.ok(discountOptionRow.includes('justify-between'))
  assert.ok(discountOptionRow.includes('items-end'))
  assert.ok(discountOptionRow.includes('backgroundColor: color'))
})
