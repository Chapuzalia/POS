import test from 'node:test'
import assert from 'node:assert/strict'
import { getLineAdditionNames, isUuid, splitLegacyMixerModifiers } from '../src/lib/mixers.ts'
import { buildRestaurantOrderLinesPayload } from '../src/features/tables/order-line-payload.ts'
import { getLineSignature } from '../src/lib/format.ts'

const productId = 'd6435545-4036-4879-b57c-cbad7626a077'
const modifierId = '7a82d221-b234-41c8-98e7-a9cb3649f725'
const lineId = '01f51071-a795-4ac2-bdf5-b8fca6e49fa8'

function orderWith(line) {
  return { lines: [line] }
}

test('separa el mixer sintetico historico de los modificadores reales', () => {
  const result = splitLegacyMixerModifiers([
    { id: modifierId, groupId: 'g', name: 'Hielo', priceCents: 0 },
    { id: `mixer:${productId}`, groupId: 'mixer', name: 'Coca-Cola', priceCents: 50 },
  ])
  assert.deepEqual(result.modifiers.map((modifier) => modifier.id), [modifierId])
  assert.equal(result.mixerProductId, productId)
  assert.deepEqual(result.mixer, { productId, name: 'Coca-Cola', priceCents: 50 })
})

test('el payload de comanda envia el mixer separado y solo UUID reales en modifierIds', () => {
  const [payload] = buildRestaurantOrderLinesPayload(orderWith({
    id: lineId, productId, variantId: productId, quantity: 2, note: null,
    modifiers: [{ id: modifierId, groupId: 'g', name: 'Hielo', priceCents: 0 }],
    mixerProductId: productId,
  }))
  assert.deepEqual(payload.modifierIds, [modifierId])
  assert.equal(payload.mixerProductId, productId)
  assert.ok(payload.modifierIds.every(isUuid))
})

test('el payload de comanda rechaza mixers sinteticos e IDs no UUID', () => {
  const base = { id: lineId, productId, variantId: productId, quantity: 1, note: null, mixerProductId: null }
  assert.throws(() => buildRestaurantOrderLinesPayload(orderWith({ ...base, modifiers: [
    { id: `mixer:${productId}`, groupId: 'mixer', name: 'Cola', priceCents: 0 },
  ]})), /mixer no puede guardarse/)
  assert.throws(() => buildRestaurantOrderLinesPayload(orderWith({ ...base, modifiers: [
    { id: 'no-es-uuid', groupId: 'g', name: 'Hielo', priceCents: 0 },
  ]})), /modificador no valido/)
})

test('la presentacion muestra modificadores y mixer sin mezclarlos en el modelo', () => {
  assert.deepEqual(getLineAdditionNames(
    [{ id: modifierId, groupId: 'g', name: 'Hielo', priceCents: 0 }],
    { productId, name: 'Coca-Cola', priceCents: 50 },
  ), ['Hielo', 'Coca-Cola'])
})

test('la firma agrupa mixers iguales y mantiene separados mixers distintos', () => {
  const base = { productId, variantId: productId, modifiers: [] }
  assert.equal(getLineSignature({ ...base, mixerProductId: productId }), getLineSignature({ ...base, mixerProductId: productId }))
  assert.notEqual(getLineSignature({ ...base, mixerProductId: productId }), getLineSignature({ ...base, mixerProductId: modifierId }))
  assert.notEqual(getLineSignature({ ...base, mixerProductId: productId }), getLineSignature({ ...base, mixerProductId: null }))
})

test('el payload admite lineas sin mixer y varios modificadores reales', () => {
  const [payload] = buildRestaurantOrderLinesPayload(orderWith({
    id: lineId, productId, variantId: productId, quantity: 1, note: null, mixerProductId: null,
    modifiers: [
      { id: modifierId, groupId: 'g', name: 'Hielo', priceCents: 0 },
      { id: lineId, groupId: 'g', name: 'Limon', priceCents: 20 },
    ],
  }))
  assert.deepEqual(payload.modifierIds, [modifierId, lineId])
  assert.equal(payload.mixerProductId, null)
})

test('el payload rechaza mixerProductId que no sea UUID', () => {
  assert.throws(() => buildRestaurantOrderLinesPayload(orderWith({
    id: lineId, productId, variantId: productId, quantity: 1, note: null,
    modifiers: [], mixerProductId: `mixer:${productId}`,
  })), /mixer no valido/)
})
