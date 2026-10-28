import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateDiscountForLines, toAppliedDiscount, validateDiscountRule } from '../src/lib/discounts.ts'

const baseRule = {
  id: 'rule-1',
  tenantId: 'tenant',
  venueId: 'venue',
  name: 'Regla',
  type: 'percentage',
  value: 10,
  fixedApplication: 'ticket',
  roundingIncrementCents: null,
  color: null,
  isActive: true,
  sortOrder: 0,
  ruleKind: 'discount',
  scope: 'general',
  targets: [],
  requiresPin: false,
  activeWeekdays: [],
  startsAt: null,
  endsAt: null,
  autoApply: false,
}

const line = (productId, variantId, grossCents, quantity = 1) => ({ productId, variantId, grossCents, quantity })

test('redondea un descuento porcentual de forma independiente en cada linea', () => {
  const rule = { ...baseRule, value: 20, roundingIncrementCents: 50 }
  const result = calculateDiscountForLines(
    [line('absolut', null, 800), line('brugal', null, 1400, 2)],
    toAppliedDiscount(rule),
  )

  assert.equal(result.eligibleSubtotalCents, 2200)
  assert.deepEqual(result.lineAllocations.map((item) => item.discountAmountCents), [150, 300])
  assert.deepEqual(result.lineAllocations.map((item) => item.netCents), [650, 1100])
  assert.equal(result.discountAmountCents, 450)
  assert.equal(result.totalCents, 1750)
})

test('solo descuenta el producto específico en un ticket mixto', () => {
  const rule = { ...baseRule, scope: 'specific', targets: [{ productId: 'a', variantId: null }] }
  const result = calculateDiscountForLines(
    [line('a', 'a-large', 1000), line('b', null, 2000)],
    toAppliedDiscount(rule),
  )
  assert.deepEqual(result.lineAllocations, [
    { eligible: true, grossCents: 1000, discountAmountCents: 100, netCents: 900 },
    { eligible: false, grossCents: 2000, discountAmountCents: 0, netCents: 2000 },
  ])
  assert.equal(result.totalCents, 2900)
})

test('el importe fijo puede aplicarse una vez por ticket o una vez por cada unidad elegible', () => {
  const fixedRule = { ...baseRule, type: 'fixed', value: 200 }
  const lines = [line('a', null, 1000, 2), line('a', null, 150), line('b', null, 900)]
  const perTicket = calculateDiscountForLines(lines, toAppliedDiscount(fixedRule))
  const perUnit = calculateDiscountForLines(
    lines,
    toAppliedDiscount({ ...fixedRule, fixedApplication: 'unit' }),
  )

  assert.equal(perTicket.discountAmountCents, 200)
  assert.equal(perUnit.discountAmountCents, 750)
  assert.deepEqual(perUnit.lineAllocations.map((item) => item.discountAmountCents), [400, 150, 200])
  assert.equal(perUnit.totalCents, 1300)
})

test('rechaza configuración automática con PIN y valida los campos de promoción', () => {
  assert.throws(() => validateDiscountRule({
    name: 'Auto PIN',
    type: 'percentage',
    value: 10,
    ruleKind: 'promotion',
    scope: 'general',
    targets: [],
    requiresPin: true,
    pin: '1234',
    activeWeekdays: [1],
    startsAt: '09:00',
    endsAt: '10:00',
    autoApply: true,
  }), /automática.*PIN/i)
  assert.throws(() => validateDiscountRule({
    name: 'Sin horario',
    type: 'percentage',
    value: 10,
    ruleKind: 'promotion',
    scope: 'general',
    targets: [],
    requiresPin: false,
    pin: null,
    activeWeekdays: [],
    startsAt: '09:00',
    endsAt: '09:00',
    autoApply: false,
  }), /día|franja/i)
})
