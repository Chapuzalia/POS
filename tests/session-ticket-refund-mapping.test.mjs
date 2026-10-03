import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compileComponent } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/services/posService.ts', import.meta.url), 'utf8')
const catalogSource = readFileSync(new URL('../src/features/catalog/services/catalogSnapshots.ts', import.meta.url), 'utf8')
const catalogSnapshots = compileComponent(catalogSource, {})

async function loadRefund({ fiscal = {}, method = 'cash', originalFiscal = {} } = {}) {
  const refundLine = {
    id: 'refund-line', original_ticket_line_id: 'line', quantity: 1,
    product_name: 'Producto histórico', variant_name: 'Unidad', modifiers: [],
    gross_cents: -1000, discount_cents: 0, net_total_cents: -1000,
    tax_rate: 10, taxable_base_cents: -909, tax_amount_cents: -91, ...fiscal,
  }
  const ticket = {
    id: 'ticket', tenant_id: 'tenant', cash_session_id: 'session', cash_register_id: 'register',
    venue_id: 'venue', device_id: 'device', user_id: 'user', status: 'paid',
    ticket_number: 1, subtotal_cents: 2000, total_cents: 2000,
    local_created_at: '2026-10-01T10:00:00Z',
    ticket_lines: [{
      id: 'line', product_id: 'product', variant_id: 'variant', quantity: 2,
      product_name: 'Producto histórico', variant_name: 'Unidad', unit_price_cents: 1000,
      line_total_cents: 2000, tax_rate: 21, taxable_base_cents: 1653, tax_amount_cents: 347,
      ...originalFiscal,
    }],
    refund_requests: [{
      id: 'refund', total_cents: -1000, refund_method: method, created_at: '2026-10-02T10:00:00Z',
      refund_lines: [refundLine],
      refund_payments: [{ id: 'refund-payment', method, amount_cents: -1000, payment_snapshot: null }],
      fiscal_local_records: [{
        id: 'record', invoice_id: 'invoice',
        invoice_snapshot: { series: 'R', number: 1, issuedAt: '2026-10-02T10:00:00Z', issuerName: 'Bar', issuerNif: 'B12345678' },
      }],
    }],
  }
  const filters = []
  const supabase = {
    from(table) {
      const query = {
        select() { return query },
        eq(column, value) { filters.push([table, column, value]); return query },
        filter() { return query },
        order() { return query },
        then(resolve) { return Promise.resolve({ data: table === 'tickets' ? [ticket] : [], error: null }).then(resolve) },
      }
      return query
    },
  }
  const service = compileComponent(source, {
    '../utils/UserFacingError.ts': { UserFacingError: Error },
    '../features/catalog/data/load-pos-catalog.ts': {},
    '../features/catalog/services/catalogSnapshots.ts': catalogSnapshots,
    '../lib/supabase': { supabase },
    '../features/session/services/sessionValidity': {},
    '../features/cash-registers/services/cashSummary.ts': {},
    '../features/quick-sale/services/salePayload.ts': {},
    '../features/platform/tenantFeatureAccess': {},
    '../features/cash-registers/services/sessionTicketHistoryModel.ts': {},
    './loginLeaseService': {},
  })
  const [record] = await service.loadSessionTicketsFromSupabase({ tenantId: 'tenant' }, 'session')
  assert.ok(filters.some(([table, column, value]) => table === 'tickets' && column === 'tenant_id' && value === 'tenant'))
  assert.ok(filters.some(([table, column, value]) => table === 'tickets' && column === 'cash_session_id' && value === 'session'))
  assert.ok(filters.some(([table, column, value]) => table === 'offline_event_log' && column === 'tenant_id' && value === 'tenant'))
  return record.refundDocuments[0].payload
}

test('el histórico usa los importes y el IVA persistidos de la devolución parcial', async () => {
  const payload = await loadRefund()
  assert.deepEqual({ ...payload.lines[0].fiscalSnapshot }, {
    taxRate: 10, taxableBaseCents: -909, taxAmountCents: -91, grossTotalCents: -1000,
  })
  assert.equal(payload.lines[0].lineTotalCents, -1000)
  assert.equal(payload.payment.amountCents, -1000)
})

test('los datos fiscales incompletos se mantienen como snapshot nulo sin inventar importes', async () => {
  for (const field of ['tax_rate', 'taxable_base_cents', 'tax_amount_cents']) {
    const payload = await loadRefund({ fiscal: { [field]: null } })
    assert.equal(payload.lines[0].fiscalSnapshot, null)
  }
})

test('el snapshot de devolución admite IVA cero y no depende del snapshot de la venta original', async () => {
  const payload = await loadRefund({
    fiscal: { tax_rate: 0, taxable_base_cents: -1000, tax_amount_cents: 0 },
    originalFiscal: { tax_rate: null, taxable_base_cents: null, tax_amount_cents: null },
  })
  assert.deepEqual({ ...payload.lines[0].fiscalSnapshot }, {
    taxRate: 0, taxableBaseCents: -1000, taxAmountCents: 0, grossTotalCents: -1000,
  })
})

test('solo efectivo y tarjeta generan un pago; se conserva el método histórico de la devolución', async () => {
  for (const method of ['cash', 'card', 'invitation', 'other']) {
    const payload = await loadRefund({ method })
    assert.equal(payload.sale.paymentMethod, method)
    if (method === 'cash' || method === 'card') {
      assert.equal(payload.payment.method, method)
      assert.equal(payload.payment.saleId, 'refund')
      assert.equal(payload.payment.tenantId, 'tenant')
    } else {
      assert.equal(payload.payment, null)
    }
  }
})
