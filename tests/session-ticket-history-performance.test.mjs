import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'
import { compileComponent } from './helpers/component-harness.mjs'
import { deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const historyModelSource = await readFile(new URL('../src/features/cash-registers/services/sessionTicketHistoryModel.ts', import.meta.url), 'utf8')
const { createCachedSessionTicketHistoryPage } = compileComponent(historyModelSource, {})

test('el histórico abre sin conexión, sin RPC ni sincronización, y devuelve la página local', async () => {
  const harness = createCashTicketActionsHarness({ isOnline: false, offlineQueue: [{tenantId:'tenant'}] })
  const actions = harness.render()
  actions.openHistory()
  const page = await actions.loadHistoryPage(1, '')
  assert.deepEqual(harness.calls.historyOpen, [true])
  assert.deepEqual(harness.calls.errors, [null])
  assert.equal(harness.calls.sync, 0)
  assert.equal(harness.calls.remoteHistory, 0)
  assert.equal(page.source, 'local')
  assert.equal(page.tickets[0].ticket.id, harness.ticket.id)
})

test('el histórico usa snapshots locales si el backend falla aunque el navegador indique conexión', async () => {
  const harness = createCashTicketActionsHarness({ loadSessionTicketPageFromSupabase: async () => { throw new TypeError('Failed to fetch') } })
  const page = await harness.render().loadHistoryPage(1, '')
  assert.equal(page.source, 'local')
  assert.equal(page.totalResults, 1)
  const forbidden = createCashTicketActionsHarness({ loadSessionTicketPageFromSupabase: async () => { throw new Error('permission denied') } })
  await assert.rejects(forbidden.render().loadHistoryPage(1, ''), /permission denied/)
})

test('cada página remota consultada queda disponible al pasar a offline', async () => {
  let remote
  const harness = createCashTicketActionsHarness({ loadSessionTicketPageFromSupabase: async () => ({currentPage: 2, totalResults: 24, tickets: [{number: 13, ticket: remote}]}) })
  remote = { ...harness.ticket, id: 'remote-sale', payload: { ...harness.ticket.payload, ticket: { ...harness.ticket.payload.ticket, id: 'remote-ticket' } } }
  const onlinePage = await harness.render().loadHistoryPage(2, '')
  assert.equal(onlinePage.tickets.length, 1)
  assert.equal(onlinePage.tickets[0].ticket.id, 'remote-sale')
  assert.equal(harness.calls.savedHistory.length, 1)
  harness.options.isOnline = false
  const offlinePage = await harness.render().loadHistoryPage(1, 'remote-ticket')
  assert.equal(offlinePage.totalResults, 1)
  assert.equal(offlinePage.tickets[0].ticket.id, 'remote-sale')
  assert.equal(harness.calls.remoteHistory, 1)
})

test('una consulta remota no pisa una modificación de cobro local todavía pendiente', async () => {
  let remote
  const harness = createCashTicketActionsHarness({
    offlineQueue: [{tenantId:'tenant',kind:'sale_payment_changed',payload:{saleId:'sale-1'}}],
    loadSessionTicketPageFromSupabase: async () => ({currentPage:1,totalResults:1,tickets:[{number:1,ticket:remote}]}),
  })
  remote = {...harness.ticket,paymentMethod:'cash',payload:{...harness.ticket.payload,sale:{...harness.ticket.payload.sale,paymentMethod:'cash'}}}
  await harness.render().loadHistoryPage(1,'')
  assert.equal(harness.calls.savedHistory[0][0].paymentMethod,'card')
  assert.equal(harness.calls.savedHistory[0][0].payload.sale.paymentMethod,'card')
})

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

test('el fallback local se actualiza cuando la caché llega después del primer render', async () => {
  const harness = createCashTicketActionsHarness()
  const firstActions = harness.render()
  const firstLoadPage = firstActions.loadHistoryPage

  harness.options.tickets = [harness.ticket]
  const refreshedActions = harness.render()
  assert.notEqual(refreshedActions.loadHistoryPage, firstLoadPage)

  const page = await refreshedActions.loadHistoryPage(1, '')
  assert.equal(page.totalResults, 1)
  assert.equal(page.tickets[0].ticket.id, harness.ticket.id)
})

