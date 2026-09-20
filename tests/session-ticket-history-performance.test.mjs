import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'
import { deferred, flush } from './helpers/restaurant-controller-harness.mjs'

test('el histórico abre antes de esperar la sincronización offline y se invalida al terminar', async () => {
  const sync = deferred()
  const harness = createCashTicketActionsHarness({
    offlineQueue: [{ id: 'pending-sale', kind: 'sale_created', tenantId: 'tenant' }],
    syncPendingEvents: async () => sync.promise,
  })
  const initialActions = harness.render()
  const initialLoadPage = initialActions.loadHistoryPage

  initialActions.openHistory()

  assert.deepEqual(harness.calls.historyOpen, [true])
  assert.deepEqual(harness.calls.busy, [])
  assert.equal(harness.calls.sync, 1)

  sync.resolve()
  await flush()

  const refreshedActions = harness.render()
  assert.notEqual(refreshedActions.loadHistoryPage, initialLoadPage)
})

test('el histórico abre sin iniciar una sincronización innecesaria cuando la cola está vacía', () => {
  const harness = createCashTicketActionsHarness()

  harness.render().openHistory()

  assert.deepEqual(harness.calls.historyOpen, [true])
  assert.deepEqual(harness.calls.busy, [])
  assert.equal(harness.calls.sync, 0)
})

test('el refresco de una venta confirmada recupera solo ese ticket', async () => {
  const source = await readFile(new URL('../src/features/cash-registers/hooks/useCashSession.ts', import.meta.url), 'utf8')
  const refreshBlock = source.match(/const refreshConfirmedSale = useCallback[\s\S]*?\n  }, \[[^\n]+\]\)/)?.[0] ?? ''

  assert.match(refreshBlock, /loadSessionTicketFromSupabase\(options\.context, session\.id, ticketId\)/)
  assert.doesNotMatch(refreshBlock, /loadSessionTicketsFromSupabase/)
  assert.match(refreshBlock, /ticketsRef\.current\.filter/)
})
