import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/features/crm/sales/services/accountingExportService.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue' }
const from = '2026-08-01T00:00:00Z'
const to = '2026-09-01T00:00:00Z'

function closure(session, first, last) {
  return { cash_session_id: session, first_ticket_number: first, last_ticket_number: last, total_sales_cents: 12345 }
}

function ticket(session, counter, series, number) {
  return {
    cash_session_id: session,
    ticket_number: counter,
    fiscal_local_records: [
      { record_kind: 'anulacion', invoice_snapshot: { series: 'IGNORED', number: 999 } },
      { record_kind: 'alta', invoice_snapshot: { series, number } },
    ],
  }
}

function service(rows, tickets, queryError = null) {
  const queries = []
  const supabase = {
    async rpc(name, args) {
      assert.equal(name, 'get_accounting_closures_export')
      assert.deepEqual({ ...args }, { p_tenant_id: 'tenant', p_venue_id: 'venue', p_from: from, p_to: to })
      return { data: rows, error: null }
    },
    from(table) {
      assert.equal(table, 'tickets')
      const scopes = {}
      return {
        select(columns) {
          assert.match(columns, /fiscal_local_records \(record_kind, invoice_snapshot\)/)
          return this
        },
        eq(column, value) {
          scopes[column] = value
          return this
        },
        async or(filter) {
          assert.deepEqual(scopes, { tenant_id: 'tenant', venue_id: 'venue' })
          queries.push(filter)
          const boundaries = [...filter.matchAll(/and\(cash_session_id\.eq\.([^,]+),ticket_number\.in\.\(([^)]+)\)\)/g)]
          assert.ok(boundaries.length)
          return {
            data: tickets.filter((row) => boundaries.some(([, session, numbers]) => row.cash_session_id === session && numbers.split(',').includes(String(row.ticket_number)))),
            error: queryError,
          }
        },
      }
    },
  }
  return {
    ...compileComponent(source, { '../../../../lib/supabase': { supabase } }),
    queries,
  }
}

test('closure export uses persisted fiscal identities across series and exercises', async () => {
  const rows = [closure('session-a', 42, '77'), closure('session-b', 42, 42)]
  const api = service(rows, [
    ticket('session-a', 42, 'NIC-BARRA-2025-S', 900),
    ticket('session-a', 77, 'NIC-BARRA-1-2026-F', 1),
    ticket('session-b', 42, 'OTRO-C2-2026-S', 15),
    ticket('session-a', 50, 'UNRELATED', 50),
  ])
  const result = await api.loadAccountingClosures(context, from, to)
  assert.equal(result[0].first_ticket_code, 'NIC-BARRA-2025-S/900')
  assert.equal(result[0].last_ticket_code, 'NIC-BARRA-1-2026-F/1')
  assert.equal(result[1].first_ticket_code, 'OTRO-C2-2026-S/15')
  assert.equal(result[1].last_ticket_code, 'OTRO-C2-2026-S/15')
  assert.equal(result[0].total_sales_cents, rows[0].total_sales_cents)
  assert.equal(api.queries.length, 1)
})

test('empty closures have empty boundaries and need no ticket queries', async () => {
  const api = service([closure('empty', null, null)], [])
  const [row] = await api.loadAccountingClosures(context, from, to)
  assert.equal(row.first_ticket_code, null)
  assert.equal(row.last_ticket_code, null)
  assert.equal(api.queries.length, 0)
})

test('missing tickets or fiscal identities reject the export without numeric fallback', async () => {
  for (const tickets of [[], [ticket('session', 1, '', 1)], [ticket('session', 1, 'SERIES', null)], [{ ...ticket('session', 1, 'SERIES', 1), fiscal_local_records: [] }]]) {
    const api = service([closure('session', 1, 1)], tickets)
    await assert.rejects(api.loadAccountingClosures(context, from, to), /código fiscal/)
  }
})

test('fiscal lookup failures reject the export', async () => {
  const api = service([closure('session', 1, 1)], [], new Error('lookup failed'))
  await assert.rejects(api.loadAccountingClosures(context, from, to), /lookup failed/)
})

test('large closure exports batch only boundary ticket lookups', async () => {
  const rows = Array.from({ length: 45 }, (_, index) => closure(`session-${index}`, 1, 2))
  const tickets = rows.flatMap((row) => [ticket(row.cash_session_id, 1, 'SERIES-S', 10), ticket(row.cash_session_id, 2, 'SERIES-F', 20)])
  const api = service(rows, tickets)
  const result = await api.loadAccountingClosures(context, from, to)
  assert.equal(result.length, 45)
  assert.equal(api.queries.length, 3)
  assert.ok(result.every((row) => row.first_ticket_code === 'SERIES-S/10' && row.last_ticket_code === 'SERIES-F/20'))
})
