import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  calculateDiscountForLines,
  getAvailableVenueDiscounts,
  isLineEligibleForDiscount,
  isPromotionActive,
  resolveTicketDiscount,
  toAppliedDiscount,
  validateDiscountRule,
} from '../src/lib/discounts.ts'

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

test('calcula un descuento general y conserva la suma exacta por línea', () => {
  const result = calculateDiscountForLines(
    [line('a', null, 1000), line('b', null, 2000)],
    toAppliedDiscount(baseRule),
  )
  assert.equal(result.eligibleSubtotalCents, 3000)
  assert.equal(result.discountAmountCents, 300)
  assert.equal(result.totalCents, 2700)
  assert.deepEqual(result.lineAllocations.map((item) => item.discountAmountCents), [100, 200])
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

test('el importe fijo por unidad respeta el ámbito y el redondeo final', () => {
  const rule = {
    ...baseRule,
    type: 'fixed',
    value: 100,
    fixedApplication: 'unit',
    roundingIncrementCents: 50,
    scope: 'specific',
    targets: [{ productId: 'a', variantId: null }],
  }
  const result = calculateDiscountForLines(
    [line('a', null, 333), line('a', null, 666), line('b', null, 1000)],
    toAppliedDiscount(rule),
  )

  assert.equal(result.eligibleSubtotalCents, 999)
  assert.equal(result.discountAmountCents, 199)
  assert.equal(result.lineAllocations[2].discountAmountCents, 0)
  assert.equal(result.lineAllocations.reduce((sum, item) => sum + item.discountAmountCents, 0), 199)
})

test('el redondeo de un importe por unidad mantiene cada línea entre cero y su bruto', () => {
  const rule = { ...baseRule, type: 'fixed', value: 1, fixedApplication: 'unit', roundingIncrementCents: 100 }
  const result = calculateDiscountForLines(
    [line('a', null, 50), line('b', null, 50)],
    toAppliedDiscount(rule),
  )

  assert.equal(result.discountAmountCents, 0)
  assert.deepEqual(result.lineAllocations.map((item) => item.netCents), [50, 50])
  assert.ok(result.lineAllocations.every((item) => item.netCents >= 0 && item.netCents <= item.grossCents))
})

test('distingue variantes del mismo producto y productos completos', () => {
  const targets = [{ productId: 'a', variantId: 'large' }]
  assert.equal(isLineEligibleForDiscount(line('a', 'large', 500), 'specific', targets), true)
  assert.equal(isLineEligibleForDiscount(line('a', 'small', 500), 'specific', targets), false)
  assert.equal(isLineEligibleForDiscount(line('a', null, 500), 'specific', targets), false)
  assert.equal(isLineEligibleForDiscount(line('a', 'small', 500), 'specific', [{ productId: 'a', variantId: null }]), true)
})

test('maneja varias unidades, cambios de cantidad, eliminación y redondeo sin tocar líneas no elegibles', () => {
  const rule = {
    ...baseRule,
    value: 12.5,
    roundingIncrementCents: 5,
    scope: 'specific',
    targets: [{ productId: 'a', variantId: null }],
  }
  const twoUnits = calculateDiscountForLines(
    [line('a', null, 666), line('b', null, 1000)],
    toAppliedDiscount(rule),
  )
  const threeUnits = calculateDiscountForLines(
    [line('a', null, 999), line('b', null, 1000)],
    toAppliedDiscount(rule),
  )
  const afterRemoval = calculateDiscountForLines([line('b', null, 1000)], toAppliedDiscount(rule))
  assert.equal(twoUnits.lineAllocations[1].netCents, 1000)
  assert.equal(threeUnits.discountAmountCents, 124)
  assert.equal(threeUnits.lineAllocations.reduce((sum, item) => sum + item.discountAmountCents, 0), 124)
  assert.equal(afterRemoval.discountAmountCents, 0)
  assert.equal(afterRemoval.totalCents, 1000)
})

const promotion = {
  ...baseRule,
  id: 'promo',
  name: 'Noche',
  ruleKind: 'promotion',
  activeWeekdays: [6],
  startsAt: '22:00',
  endsAt: '02:00',
}

test('activa promociones por día, hora, cruce de medianoche y día operativo', () => {
  const madrid = { dayChangeTime: '05:00', timeZone: 'Europe/Madrid' }
  assert.equal(isPromotionActive(promotion, { ...madrid, now: new Date('2026-08-01T20:30:00Z') }), true)
  assert.equal(isPromotionActive(promotion, { ...madrid, now: new Date('2026-08-01T23:00:00Z') }), true)
  assert.equal(isPromotionActive(promotion, { ...madrid, now: new Date('2026-08-02T01:30:00Z') }), false)
  assert.equal(isPromotionActive({ ...promotion, activeWeekdays: [5] }, { ...madrid, now: new Date('2026-08-01T20:30:00Z') }), false)
})

test('usa la zona horaria del local y se mantiene estable durante el cambio de horario de verano', () => {
  const nyPromotion = { ...promotion, activeWeekdays: [6], startsAt: '17:00', endsAt: '19:00' }
  assert.equal(isPromotionActive(nyPromotion, {
    dayChangeTime: '04:00',
    timeZone: 'America/New_York',
    now: new Date('2026-08-01T22:00:00Z'),
  }), true)

  const dstPromotion = { ...promotion, activeWeekdays: [7], startsAt: '02:00', endsAt: '04:00' }
  const madrid = { dayChangeTime: '00:00', timeZone: 'Europe/Madrid' }
  assert.equal(isPromotionActive(dstPromotion, { ...madrid, now: new Date('2026-10-25T00:30:00Z') }), true)
  assert.equal(isPromotionActive(dstPromotion, { ...madrid, now: new Date('2026-10-25T01:30:00Z') }), true)
})

test('aplica, conserva sin duplicar y retira una promoción automática en cada reevaluación', () => {
  const automatic = { ...promotion, autoApply: true, scope: 'specific', targets: [{ productId: 'a', variantId: null }] }
  const activeContext = {
    dayChangeTime: '05:00',
    timeZone: 'Europe/Madrid',
    now: new Date('2026-08-01T20:30:00Z'),
  }
  const first = resolveTicketDiscount(null, [automatic], 'venue', activeContext)
  const recovered = resolveTicketDiscount(first, [automatic], 'venue', activeContext)
  const outside = resolveTicketDiscount(recovered, [automatic], 'venue', {
    ...activeContext,
    now: new Date('2026-08-02T10:00:00Z'),
  })
  assert.equal(first?.discountId, automatic.id)
  assert.equal(first?.automatic, true)
  assert.equal(recovered?.discountId, automatic.id)
  assert.equal(outside, null)
  const calculation = calculateDiscountForLines(
    [line('a', null, 1000), line('b', null, 1000)],
    first,
  )
  assert.equal(calculation.discountAmountCents, 100)
})

test('permite descartar la promoción automática solo para la comanda actual', () => {
  const automatic = { ...promotion, autoApply: true }
  const secondAutomatic = { ...automatic, id: 'promo-2', name: 'Segunda', sortOrder: 1 }
  const activeContext = {
    dayChangeTime: '05:00',
    timeZone: 'Europe/Madrid',
    now: new Date('2026-08-01T20:30:00Z'),
  }

  const dismissed = resolveTicketDiscount(null, [automatic], 'venue', activeContext, [automatic.id])
  const nextActivePromotion = resolveTicketDiscount(
    null,
    [automatic, secondAutomatic],
    'venue',
    activeContext,
    [automatic.id],
  )
  const allDismissed = resolveTicketDiscount(
    null,
    [automatic, secondAutomatic],
    'venue',
    activeContext,
    [automatic.id, secondAutomatic.id],
  )
  const nextOrder = resolveTicketDiscount(null, [automatic], 'venue', activeContext)

  assert.equal(dismissed, null)
  assert.equal(nextActivePromotion?.discountId, secondAutomatic.id)
  assert.equal(allDismissed, null)
  assert.equal(nextOrder?.discountId, automatic.id)
  assert.equal(nextOrder?.automatic, true)
})

test('muestra la promoción automática en el selector solo mientras está activa', () => {
  const automatic = { ...promotion, autoApply: true }
  const activeContext = {
    dayChangeTime: '05:00',
    timeZone: 'Europe/Madrid',
    now: new Date('2026-08-01T20:30:00Z'),
  }
  const inactiveContext = {
    ...activeContext,
    now: new Date('2026-08-02T10:00:00Z'),
  }

  assert.deepEqual(
    getAvailableVenueDiscounts([automatic], 'venue', activeContext).map((discount) => discount.id),
    [automatic.id],
  )
  assert.deepEqual(getAvailableVenueDiscounts([automatic], 'venue', inactiveContext), [])
})

test('el botón de quitar usa la exclusión de la comanda en escritorio y móvil', async () => {
  const posPage = await readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8')
  assert.equal(posPage.match(/onRemoveDiscount=\{quickSale\.removeDiscount\}/g)?.length, 2)
  assert.match(posPage, /quickSale\.applyDiscount\(discount\)/)
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

test('el selector de programación aclara que utiliza el horario operativo del local', async () => {
  const crmPage = await readFile(new URL('../src/features/crm/discounts/pages/DiscountsPage.tsx', import.meta.url), 'utf8')
  assert.match(crmPage, /Utilizando horario operativo del local/)
})

test('el editor y el TPV exponen la aplicación por ticket o por unidad para importes fijos', async () => {
  const [crmPage, modal, crmService, catalogLoader, migration, consolidated] = await Promise.all([
    readFile(new URL('../src/features/crm/discounts/pages/DiscountsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/modals/DiscountModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/discounts/services/discountService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/data/load-pos-catalog.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260815140000_apply_fixed_discounts_per_unit.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  assert.match(crmPage, /Aplicación del importe/)
  assert.match(crmPage, /Por ticket/)
  assert.match(crmPage, /Por unidad/)
  assert.doesNotMatch(crmPage, /Por producto/)
  assert.match(crmPage, /fixedApplication: type === "fixed" \? fixedApplication : "ticket"/)
  assert.match(modal, /discount\.fixedApplication === "unit"/)
  assert.doesNotMatch(modal, /Por producto/)
  assert.match(crmService, /fixed_application/)
  assert.match(catalogLoader, /fixed_application/)
  assert.match(migration, /fixed_application in \('ticket', 'unit'\)/)
  assert.match(migration, /fixed_value_cents::bigint \* line_quantity/)
  assert.match(migration, /fixed_value_cents::bigint \* tl\.quantity/)
  assert.match(migration, /'fixedApplication', fixed_application/)
  assert.match(consolidated, /Migration: 20260815140000_apply_fixed_discounts_per_unit\.sql/)
})

test('el modal exige validar antes de seleccionar y nunca persiste el PIN', async () => {
  const modal = await readFile(new URL('../src/components/modals/DiscountModal.tsx', import.meta.url), 'utf8')
  const domain = await readFile(new URL('../src/types/domain.ts', import.meta.url), 'utf8')
  assert.match(modal, /NumericKeypadModal/)
  assert.match(modal, /PIN incorrecto/)
  assert.match(modal, /await validatePin/)
  const appliedSnapshot = domain.slice(domain.indexOf('export type AppliedDiscount'), domain.indexOf('export type TenantRole'))
  assert.doesNotMatch(appliedSnapshot, /\bpin\b/i)
  assert.doesNotMatch(domain, /pinHash/)
})

test('la migración normaliza objetivos, aísla hashes y conserva snapshots por línea', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260802120000_add_discount_promotions.sql', import.meta.url), 'utf8')
  assert.match(sql, /create table if not exists public\.discount_targets/)
  assert.match(sql, /create table if not exists public\.discount_secrets/)
  assert.match(sql, /extensions\.crypt\(p_pin/)
  assert.match(sql, /revoke all on public\.discount_secrets/)
  assert.match(sql, /discount_snapshot jsonb/)
  assert.match(sql, /discount_amount_cents integer not null default 0/)
  assert.match(sql, /net_total_cents integer/)
  assert.match(sql, /resolve_ticket_discount_for_lines/)
  assert.match(sql, /discount_rule_is_active_at/)
})


test('el descuento manual libre admite PIN sin exponer el secreto y lo exige al crear el ticket', async () => {
  const [migration, consolidated, modal, crmPage, catalogLoader] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260802130000_add_manual_discount_pin.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/modals/DiscountModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/discounts/pages/DiscountsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/data/load-pos-catalog.ts', import.meta.url), 'utf8'),
  ])

  assert.match(migration, /manual_discount_requires_pin boolean not null default false/)
  assert.match(migration, /create table if not exists public\.manual_discount_secrets/)
  assert.match(migration, /extensions\.crypt\(p_pin/)
  assert.match(migration, /revoke all on public\.manual_discount_secrets/)
  assert.match(migration, /validate_manual_discount_pin/)
  assert.match(migration, /before insert on public\.tickets/)
  assert.match(migration, /delete from public\.manual_discount_pin_grants/)
  assert.match(consolidated, /create table if not exists public\.manual_discount_secrets/)
  assert.match(catalogLoader, /manualDiscountRequiresPin: Boolean/)
  assert.match(crmPage, /type="password"/)
  assert.match(crmPage, /saveManualDiscountSettings/)
  assert.match(modal, /pendingManualDiscount/)
  assert.match(modal, /await validateManualPin\(venueId, pin\)/)
  assert.match(modal, /setPendingManualDiscount\(null\)/)
  assert.ok(modal.indexOf('await validateManualPin(venueId, pin)') < modal.indexOf('onSelect(pendingManualDiscount)'))
  assert.doesNotMatch(catalogLoader, /pin_hash|pinHash/)
})


test('el teclado numérico conserva un initialValue vacío', async () => {
  const keypad = await readFile(new URL('../src/components/ui/NumericKeypadModal.tsx', import.meta.url), 'utf8')
  assert.match(keypad, /if \(value === ""\) return ""/)
  assert.ok(keypad.indexOf('if (value === "") return ""') < keypad.indexOf('|| "0"'))
})

test('el descuento manual introduce su valor mediante el teclado numérico', async () => {
  const modal = await readFile(new URL('../src/components/modals/DiscountModal.tsx', import.meta.url), 'utf8')
  assert.match(modal, /manualValueKeypadOpen/)
  assert.match(modal, /initialValue=\{manualValue\}/)
  assert.match(modal, /setManualValue\(value\)/)
  assert.match(modal, /showCloseButton=\{false\}/)
  assert.doesNotMatch(modal, /<UiInput/)
})

