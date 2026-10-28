import assert from 'node:assert/strict'

import test from 'node:test'

import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'

test('el histórico usa snapshots locales si el backend falla aunque el navegador indique conexión', async () => {
  const harness = createCashTicketActionsHarness({ loadSessionTicketPageFromSupabase: async () => { throw new TypeError('Failed to fetch') } })
  const page = await harness.render().loadHistoryPage(1, '')
  assert.equal(page.source, 'local')
  assert.equal(page.totalResults, 1)
  const forbidden = createCashTicketActionsHarness({ loadSessionTicketPageFromSupabase: async () => { throw new Error('permission denied') } })
  await assert.rejects(forbidden.render().loadHistoryPage(1, ''), /permission denied/)
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
