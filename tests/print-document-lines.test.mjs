import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSaleTicketLines } from '../src/features/local-printing/services/documentLineBuilders.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'
import { printerLayoutFromPrinter, receiptTextWidth } from '../src/features/local-printing/services/receiptFormatters.ts'

const sale = {
  ticket: {
    id: 'T-2026-0001', tenantId: 'tenant', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue',
    deviceId: 'device', userId: 'user', subtotalCents: 2900, discount: null, discountAmountCents: 250,
    totalCents: 2650, createdAt: '2026-08-19T18:45:00+02:00',
  },
  lines: [
    {
      id: 'line-1', ticketId: 'T-2026-0001', tenantId: 'tenant', productId: 'p1', variantId: 'v1',
      productName: 'Cóctel extraordinariamente largo', variantName: 'Edición piña', quantity: 1.5,
      unitPriceCents: 1200, lineTotalCents: 1800, netTotalCents: 1650,
      modifiers: [{ id: 'm1', groupId: 'g1', name: 'Más hielo y limón recién cortado', priceCents: 0 }],
      components: [{ id: 'c1', type: 'mixer', selectionGroupId: null, selectionGroupName: 'Mixer', productId: 'p2', variantId: null, productName: 'Tónica premium', variantName: '', quantity: 1, priceDeltaCents: 0, sortOrder: 0 }],
      note: 'Servir sin pajita y con una rodaja de naranja muy fina',
      fiscalSnapshot: { taxRate: 21, taxableBaseCents: 1488, taxAmountCents: 312, grossTotalCents: 1800 },
    },
    {
      id: 'line-2', ticketId: 'T-2026-0001', tenantId: 'tenant', productId: 'p3', variantId: 'v3',
      productName: 'Café', variantName: 'Solo', quantity: 1, unitPriceCents: 1100, lineTotalCents: 1100, netTotalCents: 1000,
      modifiers: [], components: [], fiscalSnapshot: { taxRate: 10, taxableBaseCents: 1000, taxAmountCents: 100, grossTotalCents: 1100 },
    },
  ],
  sale: {
    id: 'sale_123', tenantId: 'tenant', ticketId: 'T-2026-0001', cashSessionId: 'cash', cashRegisterId: 'register',
    venueId: 'venue', deviceId: 'device', userId: 'user', totalCents: 2650, paymentMethod: 'cash', createdAt: '2026-08-19T18:45:00+02:00',
  },
  payment: { id: 'payment', tenantId: 'tenant', saleId: 'sale_123', method: 'cash', amountCents: 2650, receivedCents: 3000, changeCents: 350 },
}

const establishment = {
  name: 'Peña Café', legalName: 'Compañía Española SL', taxId: 'B12345678', address: 'Calle Ñandú 10',
  timezone: 'Europe/Madrid', cashRegisterName: 'Caja principal', employeeName: 'Iñaki', footer: 'Gracias por su visita',
}
const layout58 = { columns: 32, paperWidth: 58, characterSet: 'CP858' }
const layout80 = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

test('el ticket estándar se compone exactamente en 32 columnas', () => {
  assert.deepEqual(buildSaleTicketLines(sale, establishment, layout58), EXPECTED_SALE_32)
})

test('el ticket estándar se compone exactamente en 48 columnas', () => {
  assert.deepEqual(buildSaleTicketLines(sale, establishment, layout80), EXPECTED_SALE_48)
})

test('producto decimal, modificadores y notas largas no dependen del wrapping físico', () => {
  for (const layout of [layout58, layout80]) {
    const lines = buildSaleTicketLines(sale, establishment, layout)
    assert.ok(lines.some((line) => line.includes('1,5 x')))
    assert.ok(lines.some((line) => line.includes('Tónica premium')))
    assert.ok(lines.some((line) => line.includes('Más hielo')))
    assert.ok(lines.some((line) => line.includes('Nota:')))
    for (const line of lines) {
      assert.ok(receiptTextWidth(line) <= layout.columns, `Línea demasiado larga (${layout.columns}): ${line}`)
      assert.equal(Array.from(line).some((character) => {
        const code = character.codePointAt(0) ?? 0
        return code < 32 || code === 127
      }), false)
    }
  }
})

test('el mismo intento conserva requestId y contenido, efectivo abre cajón y una copia no', () => {
  const input = { sale, establishment, printerId: 'main', printerLayout: layout80, autoOpenCashDrawer: true }
  const first = mapSaleToPrintRequest(input)
  const retry = mapSaleToPrintRequest(input)
  assert.deepEqual(retry, first)
  assert.equal(first.requestId, 'print:sale_123:original')
  assert.equal(first.force, false)
  assert.equal(first.options.openCashDrawer, true)
  assert.equal('ticket' in first, false)

  const copy = mapSaleToPrintRequest({ ...input, isReprint: true, copyNumber: 1 })
  assert.equal(copy.requestId, 'print:sale_123:copy:1')
  assert.equal(copy.force, true)
  assert.equal(copy.options.openCashDrawer, false)
})

test('paperWidth de la impresora seleccionada decide 32 o 48 columnas', () => {
  assert.deepEqual(printerLayoutFromPrinter({ id: '58mm', paperWidth: 58, characterSet: 'CP858' }), layout58)
  assert.deepEqual(printerLayoutFromPrinter({ id: '80mm', paperWidth: 80, characterSet: 'CP858' }), layout80)
})

const EXPECTED_SALE_32 = [
  '           Peña Café',
  '      Compañía Española SL',
  '       NIF/CIF B12345678',
  '         Calle Ñandú 10',
  '',
  'Ticket               T-2026-0001',
  'Fecha        2026-08-19 18:45:00',
  'Caja              Caja principal',
  'Empleado                   Iñaki',
  '',
  'PRODUCTOS',
  '--------------------------------',
  '1,5 x Cóctel',
  'extraordinariamente',
  'largo Edición piña       16,50 €',
  '  + Tónica premium',
  '  + Más hielo y limón recién',
  '    cortado',
  '  Nota: Servir sin pajita y con',
  '        una rodaja de naranja',
  '        muy fina',
  '1 x Café Solo            10,00 €',
  '',
  '--------------------------------',
  'Subtotal                 29,00 €',
  'Descuento                -2,50 €',
  'Base imponible           22,73 €',
  'IVA 10 %                  0,91 €',
  'IVA 21 %                  2,86 €',
  'TOTAL                    26,50 €',
  '',
  'PAGO',
  '--------------------------------',
  'Efectivo                 26,50 €',
  'Entregado                30,00 €',
  'Cambio                    3,50 €',
  '',
  '     Gracias por su visita',
  '',
  '',
]

const EXPECTED_SALE_48 = [
  '                   Peña Café',
  '              Compañía Española SL',
  '               NIF/CIF B12345678',
  '                 Calle Ñandú 10',
  '',
  'Ticket                               T-2026-0001',
  'Fecha                        2026-08-19 18:45:00',
  'Caja                              Caja principal',
  'Empleado                                   Iñaki',
  '',
  'PRODUCTOS',
  '------------------------------------------------',
  '1,5 x Cóctel extraordinariamente largo',
  'Edición piña                             16,50 €',
  '  + Tónica premium',
  '  + Más hielo y limón recién cortado',
  '  Nota: Servir sin pajita y con una rodaja de',
  '        naranja muy fina',
  '1 x Café Solo                            10,00 €',
  '',
  '------------------------------------------------',
  'Subtotal                                 29,00 €',
  'Descuento                                -2,50 €',
  'Base imponible                           22,73 €',
  'IVA 10 %                                  0,91 €',
  'IVA 21 %                                  2,86 €',
  'TOTAL                                    26,50 €',
  '',
  'PAGO',
  '------------------------------------------------',
  'Efectivo                                 26,50 €',
  'Entregado                                30,00 €',
  'Cambio                                    3,50 €',
  '',
  '             Gracias por su visita',
  '',
  '',
]
