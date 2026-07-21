import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateNetTotalToLines,
  assertValidTicketPayment,
  calculateDiscount,
  getActiveVenueDiscounts,
  validateDiscountDefinition,
} from '../src/lib/discounts.ts'

test('calcula porcentajes y redondea siempre a centimos', () => {
  assert.deepEqual(calculateDiscount(3000, 'percentage', 20), {
    discountAmountCents: 600,
    totalCents: 2400,
  })
  assert.deepEqual(calculateDiscount(900, 'percentage', 100), {
    discountAmountCents: 900,
    totalCents: 0,
  })
  assert.deepEqual(calculateDiscount(999, 'percentage', 12.5), {
    discountAmountCents: 125,
    totalCents: 874,
  })
})

test('redondea el total final al incremento configurado y nunca supera el subtotal', () => {
  assert.deepEqual(calculateDiscount(3137, 'percentage', 20, 50), {
    discountAmountCents: 637,
    totalCents: 2500,
  })
  assert.deepEqual(calculateDiscount(999, 'percentage', 20, 100), {
    discountAmountCents: 199,
    totalCents: 800,
  })
  assert.deepEqual(calculateDiscount(99, 'percentage', 1, 100), {
    discountAmountCents: 0,
    totalCents: 99,
  })
  assert.throws(() => calculateDiscount(1000, 'percentage', 20, 25), /redondeo/)
})

test('limita un descuento fijo al subtotal', () => {
  assert.deepEqual(calculateDiscount(3000, 'fixed', 500), {
    discountAmountCents: 500,
    totalCents: 2500,
  })
  assert.deepEqual(calculateDiscount(3000, 'fixed', 5000), {
    discountAmountCents: 3000,
    totalCents: 0,
  })
})

test('sin descuento conserva el subtotal y rechaza valores invalidos', () => {
  assert.deepEqual(calculateDiscount(3000), {
    discountAmountCents: 0,
    totalCents: 3000,
  })
  assert.throws(() => calculateDiscount(3000, 'percentage', 0))
  assert.throws(() => calculateDiscount(3000, 'percentage', 101))
  assert.throws(() => calculateDiscount(3000, 'fixed', Number.NaN))
  assert.throws(() => calculateDiscount(3000, 'fixed', 10.5))
  assert.throws(() => calculateDiscount(-1))
})

test('solo permite cerrar tickets cobrados con un metodo real o tickets a cero sin pago', () => {
  assert.doesNotThrow(() => assertValidTicketPayment(2400, 'cash'))
  assert.doesNotThrow(() => assertValidTicketPayment(2400, 'card'))
  assert.doesNotThrow(() => assertValidTicketPayment(0, null))
  assert.throws(() => assertValidTicketPayment(2400, null), /Efectivo o Tarjeta/)
  assert.throws(() => assertValidTicketPayment(0, 'cash'), /no requiere/)
})

test('el POS carga unicamente descuentos activos del local y conserva el orden', () => {
  const shared = { tenantId: 'tenant', color: null, type: 'percentage', value: 10 }
  const discounts = [
    { ...shared, id: 'inactive', venueId: 'venue-a', name: 'Inactivo', isActive: false, sortOrder: 0 },
    { ...shared, id: 'other', venueId: 'venue-b', name: 'Otro local', isActive: true, sortOrder: 0 },
    { ...shared, id: 'second', venueId: 'venue-a', name: 'Segundo', isActive: true, sortOrder: 20 },
    { ...shared, id: 'first', venueId: 'venue-a', name: 'Primero', isActive: true, sortOrder: 10 },
  ]
  assert.deepEqual(getActiveVenueDiscounts(discounts, 'venue-a').map((discount) => discount.id), ['first', 'second'])
})

test('valida y normaliza las definiciones creadas o editadas desde CRM', () => {
  assert.equal(validateDiscountDefinition('  Empleado  ', 'percentage', 20), 'Empleado')
  assert.equal(validateDiscountDefinition('Promocion', 'fixed', 500), 'Promocion')
  assert.throws(() => validateDiscountDefinition(' ', 'percentage', 20), /nombre/)
  assert.throws(() => validateDiscountDefinition('Excesivo', 'percentage', 101), /100/)
  assert.throws(() => validateDiscountDefinition('Invalido', 'fixed', 10.5), /importe fijo/)
})

test('reparte las ventas netas entre lineas sin perder centimos', () => {
  assert.deepEqual(allocateNetTotalToLines([1000, 2000], 2400), [800, 1600])
  assert.deepEqual(allocateNetTotalToLines([333, 333, 334], 875), [291, 292, 292])
  assert.equal(allocateNetTotalToLines([333, 333, 334], 875).reduce((sum, value) => sum + value, 0), 875)
  assert.deepEqual(allocateNetTotalToLines([1000, 2000], 0), [0, 0])
  assert.throws(() => allocateNetTotalToLines([100], 101), /no puede superar/)
})
