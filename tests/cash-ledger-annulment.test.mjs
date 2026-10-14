import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { summarizeSales } from '../src/features/cash-registers/services/cashSummary.ts'
import { compileComponent } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/services/posService.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue' }

function sale(id, method, amountCents, status = 'paid', overrides = {}) {
  return {
    id, tenant_id: 'tenant', cash_session_id: 'session', payment_method: method,
    total_cents: amountCents, created_at: '2026-10-14T10:00:00Z',
    sale_payments: [{ method, amount_cents: amountCents }],
    tickets: { status, venue_id: 'venue' }, ...overrides,
  }
}

function ledgerService(rows, error = null) {
  const supabase = {
    from(table) {
      assert.equal(table, 'sales')
      const filters = []
      let innerTickets = false
      const query = {
        select(columns) { innerTickets = columns.includes('tickets!inner('); return query },
        eq(column, value) { filters.push([column, value]); return query },
        order() { return query },
        then(resolve) {
          const data = rows.filter(row => filters.every(([column, value]) => {
            if (column.startsWith('tickets.')) {
              // An embedded filter alone does not remove parent sales in PostgREST.
              return !innerTickets || row.tickets?.[column.split('.')[1]] === value
            }
            return row[column] === value
          }))
          return Promise.resolve({ data, error }).then(resolve)
        },
      }
      return query
    },
  }
  return compileComponent(source, {
    '../utils/UserFacingError.ts': { UserFacingError: Error },
    '../features/catalog/data/load-pos-catalog.ts': {},
    '../features/catalog/services/catalogSnapshots.ts': {},
    '../lib/supabase': { supabase },
    '../features/session/services/sessionValidity': {},
    '../features/cash-registers/services/cashSummary.ts': {},
    '../features/quick-sale/services/salePayload.ts': {},
    '../features/platform/tenantFeatureAccess': {},
    '../features/cash-registers/services/sessionTicketHistoryModel.ts': {},
    './loginLeaseService': {},
  })
}

test('cash closing and shift summary exclude annulled card, cash and split payments on every refresh', async () => {
  const rows = [
    sale('cash', 'cash', 1250),
    sale('card', 'card', 2300),
    sale('split', null, 1000, 'paid', {
      sale_payments: [{ method: 'cash', amount_cents: 400 }, { method: 'card', amount_cents: 600 }],
    }),
  ]
  const originalSnapshots = JSON.stringify(rows)
  const { loadSalesLedgerFromSupabase } = ledgerService(rows)
  assert.equal(summarizeSales(0, await loadSalesLedgerFromSupabase(context, 'session')).totalSalesCents, 4550)

  for (const row of rows) row.tickets.status = 'void'
  for (let refresh = 0; refresh < 2; refresh++) {
    const ledger = await loadSalesLedgerFromSupabase(context, 'session')
    assert.equal(ledger.length, 0)
    const closing = summarizeSales(10000, ledger)
    assert.equal(closing.cashCents, 10000)
    assert.equal(closing.cardCents, 0)
    assert.equal(closing.totalSalesCents, 0)
    const shift = summarizeSales(0, ledger)
    assert.equal(shift.cashCents, 0)
    assert.equal(shift.cardCents, 0)
  }
  const originalRows = JSON.parse(originalSnapshots)
  rows.forEach((row, index) => {
    assert.deepEqual(row.sale_payments, originalRows[index].sale_payments)
    assert.equal(row.total_cents, originalRows[index].total_cents)
  })
})

test('active sales retain exact payment cents and tenant, venue and cash session isolation', async () => {
  const rows = [
    sale('active', 'card', 2345),
    sale('void', 'card', 9000, 'void'),
    sale('other-tenant', 'card', 8000, 'paid', { tenant_id: 'other-tenant' }),
    sale('other-session', 'card', 7000, 'paid', { cash_session_id: 'other-session' }),
    sale('other-venue', 'card', 6000, 'paid', { tickets: { status: 'paid', venue_id: 'other-venue' } }),
  ]
  const ledger = await ledgerService(rows).loadSalesLedgerFromSupabase(context, 'session')
  assert.deepEqual(Array.from(ledger, row => row.id), ['active'])
  assert.equal(ledger[0].payments[0].amountCents, 2345)
  assert.equal(summarizeSales(0, ledger).cardCents, 2345)
})

test('ledger query failures remain errors rather than an empty successful summary', async () => {
  const error = new Error('Connection failed')
  await assert.rejects(ledgerService([], error).loadSalesLedgerFromSupabase(context, 'session'), error)
})
