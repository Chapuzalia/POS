import assert from 'node:assert/strict'

import test from 'node:test'

import { normalizeCustomerTaxId, validateCustomerCreateInput } from '../src/features/customers/customerValidation.ts'
import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

const customer = {
  id: 'customer-1', tenantId: 'tenant', legalName: 'Alteil Solutions S.L.', taxId: 'B12345678',
  address: 'Calle Mayor 1', postalCode: '08700', city: 'Igualada', province: 'Barcelona', country: 'España',
  email: 'facturas@alteil.test', phone: null, createdAt: '2026-08-21T10:00:00Z', updatedAt: '2026-08-21T10:00:00Z',
}
const context = {
  tenantId: 'tenant', venueId: 'venue', venueDefaultTaxRate: 21, deviceId: 'device', userId: 'user',
}
const cashSession = { id: 'cash', cashRegisterId: 'register' }
const layout = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

function line(id, cents, vatRate) {
  return {
    id, productId: `product-${id}`, productName: id, variantId: `variant-${id}`, variantName: id,
    basePriceCents: cents, componentDeltaCents: 0, modifierDeltaCents: 0, unitPriceCents: cents, quantity: 1,
    modifiers: [], components: [], catalogSnapshot: {
      placementId: null, productType: 'standard', productId: `product-${id}`, productName: id,
      variantId: `variant-${id}`, variantName: id, basePriceCents: cents, vatRate,
      categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '', saleFormatId: null, saleFormatName: id,
    },
  }
}

function payload(lines, discount = null, invoiceCustomer = null) {
  const originalWindow = globalThis.window
  globalThis.window = { ...originalWindow, crypto: globalThis.crypto }
  try {
    return buildSalePayload(context, cashSession, lines, 'card', null, discount, invoiceCustomer)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
}

test('valida los campos obligatorios y normaliza NIF/CIF equivalentes', () => {
  assert.equal(normalizeCustomerTaxId(' b-12 345.678 '), 'B12345678')
  assert.throws(() => validateCustomerCreateInput({ ...customer, legalName: '' }), /razón social/i)
  assert.throws(() => validateCustomerCreateInput({ ...customer, postalCode: '' }), /código postal/i)
  assert.equal(validateCustomerCreateInput(customer).country, 'España')
  assert.equal(validateCustomerCreateInput({ ...customer, country: '' }).country, 'España')
})

test('el snapshot fiscal queda desacoplado de cambios posteriores del cliente', () => {
  const sourceCustomer = { ...customer }
  const invoice = payload([line('Café', 1100, 10)], null, sourceCustomer)
  assert.equal(invoice.ticket.invoice.customerId, customer.id)
  assert.deepEqual(invoice.ticket.invoice.customer, {
    legalName: customer.legalName, taxId: customer.taxId, address: customer.address,
    postalCode: customer.postalCode, city: customer.city, province: customer.province,
    country: customer.country, email: customer.email, phone: customer.phone,
  })
  sourceCustomer.legalName = 'Nombre cambiado después'
  sourceCustomer.address = 'Otra dirección'
  assert.equal(invoice.ticket.invoice.customer.legalName, 'Alteil Solutions S.L.')
  assert.equal(invoice.ticket.invoice.customer.address, 'Calle Mayor 1')

})

test('la factura imprime descuentos y varios tipos de IVA desde los importes finales cobrados', () => {
  const discount = { discountId: null, name: 'Descuento 20 %', type: 'manual', calculationType: 'percentage', value: 20, roundingIncrementCents: null, color: null }
  const billed = payload([line('IVA 21', 1210, 21), line('IVA 10', 1100, 10)], discount, customer)
  billed.ticket.invoice = { ...billed.ticket.invoice, series: 'F-2026', number: '000124', issuedAt: billed.sale.createdAt }
  const text = mapSaleToPrintRequest({ sale: billed, establishment: { name: 'TICKIT BAR' }, printerId: 'main', printerLayout: layout }).lines.join('\n')
  assert.equal(billed.sale.totalCents, 1848)
  assert.match(text, /Descuento[ ]+-4,62 €/)
  assert.match(text, /Base imponible[ ]+16,00 €/)
  assert.match(text, /IVA 10 %[ ]+0,80 €/)
  assert.match(text, /IVA 21 %[ ]+1,68 €/)
  assert.match(text, /TOTAL \(IVA incluido\)[ ]+18,48 €/)
})
