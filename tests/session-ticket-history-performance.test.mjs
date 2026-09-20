import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'
import { compileComponent } from './helpers/component-harness.mjs'
import { deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const historyModelSource = await readFile(new URL('../src/features/cash-registers/services/sessionTicketHistoryModel.ts', import.meta.url), 'utf8')
const { createCachedSessionTicketHistoryPage } = compileComponent(historyModelSource, {})

test('la primera página del histórico se construye inmediatamente con los tickets ya cargados en la caja', () => {
  const ticket = (id, createdAt, ticketNumber) => ({ createdAt, id, ticketNumber })
  const cachedPage = createCachedSessionTicketHistoryPage([
    ticket('sale-old', '2026-09-19T10:00:00Z', 1),
    ticket('sale-new', '2026-09-19T12:00:00Z', 2),
  ])

  assert.equal(cachedPage.currentPage, 1)
  assert.equal(cachedPage.totalResults, 2)
  assert.deepEqual(Array.from(cachedPage.tickets, ({ ticket: item }) => item.id), ['sale-new', 'sale-old'])
  assert.equal(createCachedSessionTicketHistoryPage([]), null)
})

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

test('el modal pinta la caché desde el primer render y PosPage se la entrega', async () => {
  const [modalSource, posPageSource] = await Promise.all([
    readFile(new URL('../src/components/modals/SessionTicketsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(modalSource, /useState<SessionTicketHistoryPage \| null>\(\(\) => initialPage\)/)
  assert.match(modalSource, /useState\(initialPage === null\)/)
  assert.doesNotMatch(modalSource, /catch \{[\s\S]*?setPageData\(null\)[\s\S]*?setLoadError/)
  assert.match(modalSource, /loadError && !pageData/)
  assert.match(posPageSource, /createCachedSessionTicketHistoryPage\(cash\.tickets\)/)
  assert.match(posPageSource, /initialPage=\{initialTicketHistoryPage\}/)
})
