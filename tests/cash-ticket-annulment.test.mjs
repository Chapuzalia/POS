import assert from 'node:assert/strict'
import test from 'node:test'
import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'

test('concurrent annulment attempts execute one fiscal and economic operation', async () => {
  let release, count = 0
  const waiting = new Promise(resolve => { release = resolve })
  const h = createCashTicketActionsHarness({ prepareLocalFiscalAnnulment: async () => { count++; await waiting } })
  h.ticket.payload.localFiscal = { recordId: 'original' }
  const actions = h.render()
  const first = actions.voidTicket(h.ticket)
  await actions.voidTicket(h.ticket)
  assert.equal(count, 1)
  release()
  await first
  assert.equal(h.calls.stats, 1)
})

test('fiscal rejection keeps sale and ledger intact and releases the lock for retry', async () => {
  let count = 0
  const h = createCashTicketActionsHarness({ prepareLocalFiscalAnnulment: async () => { count++; throw new Error('Fiscal rejection') } })
  h.ticket.payload.localFiscal = { recordId: 'original' }
  const actions = h.render()
  await actions.voidTicket(h.ticket)
  await actions.voidTicket(h.ticket)
  assert.equal(count, 2)
  assert.equal(h.calls.tickets.length, 0)
  assert.equal(h.calls.ledgers.length, 0)
  assert.equal(h.calls.stats, 0)
  assert.equal(h.calls.errors.at(-1), 'Fiscal rejection')
})

test('pending sales and offline fiscal tickets retain their existing guards', async () => {
  const pending = createCashTicketActionsHarness({ offlineQueue: [{ kind: 'sale_created', payload: { sale: { id: 'sale-1' } } }] })
  await pending.render().voidTicket(pending.ticket)
  assert.match(pending.calls.errors.at(-1), /pendiente/)
  assert.equal(pending.calls.tickets.length, 0)
  const offline = createCashTicketActionsHarness({ isOnline: false })
  offline.ticket.payload.localFiscal = { recordId: 'original' }
  await offline.render().voidTicket(offline.ticket)
  assert.match(offline.calls.errors.at(-1), /conexión/)
  assert.equal(offline.calls.tickets.length, 0)
})
