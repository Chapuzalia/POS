import assert from 'node:assert/strict'
import test from 'node:test'
import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'
import { IDBFactory } from 'fake-indexeddb'
import { openLedger, persistLocalFiscalAnnulment, request, transactionDone } from '../src/features/fiscal/local/localLedger.ts'
import { createLocalFallbackLease } from '../src/features/fiscal/local/clock.ts'
import { UserFacingError } from '../src/utils/UserFacingError.ts'
import { getReadableError } from '../src/utils/errors.ts'

test('an older fiscal ticket exposes the reason for rejection without changing the chain', async (t) => {
  const oldIndexedDB = globalThis.indexedDB
  const oldLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  globalThis.indexedDB = new IDBFactory()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_, __, action) => action() } })
  t.after(() => {
    globalThis.indexedDB = oldIndexedDB
    if (oldLocks) Object.defineProperty(navigator, 'locks', oldLocks)
    else delete navigator.locks
  })
  const installation = { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation', deviceId: 'device' }
  const scope = 'tenant:subject:installation'
  const chain = { scope, position: 2, previous: { hash: 'latest-hash' } }
  const db = await openLedger()
  t.after(() => db.close())
  const seed = db.transaction('cursors', 'readwrite')
  const seeded = transactionDone(seed)
  seed.objectStore('cursors').put(chain)
  await seeded

  await assert.rejects(persistLocalFiscalAnnulment({
    installation,
    lease: createLocalFallbackLease(installation.installationId, installation.deviceId),
    original: { scope, record: { ...installation, hash: 'older-hash' } },
    reason: 'Anulación solicitada desde el histórico de tickets',
  }), error => {
    assert.ok(error instanceof UserFacingError)
    assert.equal(getReadableError(error), 'Solo se puede anular el último ticket emitido.')
    return true
  })
  const tx = db.transaction(['cursors', 'entries', 'delivery'], 'readonly')
  const checked = transactionDone(tx)
  const [storedChain, entries, deliveries] = await Promise.all([
    request(tx.objectStore('cursors').get(scope)),
    request(tx.objectStore('entries').count()),
    request(tx.objectStore('delivery').count()),
  ])
  await checked
  assert.deepEqual(storedChain, chain)
  assert.equal(entries, 0)
  assert.equal(deliveries, 0)
})

test('confirmed hold annuls with an automatic fiscal reason and no further dialogs', async () => {
  const fiscalCalls = []
  const h = createCashTicketActionsHarness({ prepareLocalFiscalAnnulment: async (...args) => { fiscalCalls.push(args) } })
  h.ticket.payload.localFiscal = { recordId: 'original' }
  await h.render().voidTicket(h.ticket)
  assert.equal(fiscalCalls.length, 1)
  assert.equal(fiscalCalls[0][2], 'ticket-1')
  assert.equal(fiscalCalls[0][3], 'Anulación solicitada desde el histórico de tickets')
  assert.deepEqual(h.calls.dialogs, [])
  assert.equal(h.calls.tickets[0][0].status, 'voided')
  assert.deepEqual(h.calls.ledgers[0], [])
  assert.equal(h.calls.stats, 1)
})

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
