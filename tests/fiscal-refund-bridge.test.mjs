import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent } from './helpers/component-harness.mjs'
import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'

const source = readFileSync(new URL('../src/features/fiscal/local/refund.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device' }
const cash = { id: 'cash', cashRegisterId: 'register' }
function scenario({ type = 'F2', transmissionMode = 'bridge', rpcError = null, bridgeFails = false, restored = false } = {}) {
  const calls = [], original = { record: { canonicalRecord: { RegistroAlta: { TipoFactura: type } } } }
  const ticket = { cashSessionId: 'cash', payload: { ticket: { id: 'ticket', tenantId: 'tenant', venueId: 'venue', cashRegisterId: 'register' },
    sale: { id: 'sale' }, lines: [{ id: 'line', quantity: 3 }] } }
  const installation = { ...context, installationId: 'installation', fiscalSubjectId: 'subject', cashRegisterId: 'register', bridgeUrl: 'http://localhost:3000/', aeatEnvironment: 'test' }
  const entry = { id: 'refund-record', record: { idempotencyKey: 'refund-record', hash: 'unchanged-hash' }, invoice: { ticketId: 'refund-request', transmissionMode } }
  const { issuePosRefund } = compileComponent(source, {
    '../../../lib/supabase.ts': { supabase: { rpc(name, args) { calls.push({ name, args }); return { abortSignal: async () => ({ error: rpcError }) } } } },
    './localLedger.ts': { findLocalFiscalEntryByTicket: async () => original,
      listLocalFiscalEntries: async () => restored ? [entry] : [], markLocalFiscalIncidence: async () => { calls.push('incidence') },
      confirmLocalRectificative: async (input, confirm) => { calls.push({ build: input }); await confirm(entry); calls.push('persist'); return entry } },
    './deliveryIncidence.ts': { isFiscalTransportFailure: error => error instanceof TypeError },
    './installation.ts': { getFiscalInstallationLease: async () => ({ leaseId: 'new-lease' }), fiscalBridgeAccessToken: async () => 'token' },
    './posInvoice.ts': { preflightFiscalInstallation: async () => { calls.push('recover'); return installation } },
    './economicSync.ts': { synchronizeFiscalEconomicSales: async () => { calls.push('economic') } },
    './serverRecovery.ts': { recoverServerConfirmedFiscalChain: async () => { calls.push('recover-after-error') } },
    './sync.ts': { synchronizeLocalFiscalQueue: async config => { calls.push({ bridge: config }); if (bridgeFails) throw new TypeError('Failed to fetch') } },
  }, { crypto, AbortSignal })
  return { calls, issuePosRefund, ticket, entry }
}

for (const [type, correction] of [['F2', 'R5'], ['F1', 'R1']]) {
  test(`${type} refund confirms economics before persisting and immediately queues ${correction} for the bridge`, async () => {
    const h = scenario({ type })
    assert.equal(await h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash'), h.entry)
    assert.deepEqual(h.calls.slice(0, 2), ['recover', 'economic'])
    const input = h.calls.find(call => call.build)?.build
    assert.equal(input.type, correction)
    assert.equal(input.lease.leaseId, 'new-lease')
    assert.deepEqual(Array.from(input.selectedLines, line => ({ ...line })), [{ lineId: '0', quantity: 1, originalQuantity: 3 }])
    const rpcIndex = h.calls.findIndex(call => call.name === 'create_ticket_refund')
    assert.ok(rpcIndex < h.calls.indexOf('persist'))
    assert.ok(h.calls.indexOf('persist') < h.calls.findIndex(call => call.bridge))
    assert.equal(h.calls[rpcIndex].args.p_idempotency_key, 'refund-record')
    assert.equal(h.calls[rpcIndex].args.p_refund_request_id, 'refund-request')
    assert.equal(h.calls[rpcIndex].args.p_original_sale_id, 'sale')
  })
}

test('a bridge outage does not undo or repeat a committed refund', async () => {
  const h = scenario({ bridgeFails: true })
  assert.equal(await h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'card'), h.entry)
  assert.equal(h.calls.filter(call => call.name === 'create_ticket_refund').length, 1)
  assert.ok(h.calls.includes('persist'))
})

test('economic rejection does not persist or deliver an unconfirmed refund', async () => {
  const h = scenario({ rpcError: new Error('REFUND_LINE_QUANTITY_INVALID') })
  await assert.rejects(h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 4 }], 'cash'), /REFUND_LINE/)
  assert.ok(!h.calls.includes('persist'))
  assert.ok(!h.calls.some(call => call.bridge))
  assert.ok(h.calls.includes('recover-after-error'))
})

test('a lost RPC acknowledgement recovers and delivers the exact committed refund without a second economic operation', async () => {
  const h = scenario({ rpcError: new TypeError('Failed to fetch'), restored: true })
  assert.equal(await h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash'), h.entry)
  assert.equal(h.calls.filter(call => call.name === 'create_ticket_refund').length, 1)
  assert.ok(h.calls.includes('recover-after-error'))
  assert.ok(h.calls.includes('incidence'))
  assert.ok(h.calls.some(call => call.bridge))
})

test('legacy local-only installations remain local-only after a refund', async () => {
  const h = scenario({ transmissionMode: 'local-only' })
  await h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash')
  assert.ok(h.calls.includes('persist'))
  assert.ok(!h.calls.some(call => call.bridge))
})

test('refunds reject foreign scope and duplicate selections before economic confirmation', async () => {
  const h = scenario()
  await assert.rejects(h.issuePosRefund({ ...context, tenantId: 'foreign' }, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash'), /caja y local/)
  await assert.rejects(h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }, { lineId: 'line', quantity: 1 }], 'cash'), /distintas/)
  assert.ok(!h.calls.some(call => call.name === 'create_ticket_refund'))
})

test('history refund action delegates to fiscal service; failed confirmation leaves an error and no history refresh', async () => {
  let calls = 0
  const h = createCashTicketActionsHarness({ issuePosRefund: async () => { calls++; throw new Error('Refund rejected') } })
  h.ticket.payload.localFiscal = { recordId: 'original-record' }
  await h.render().refund(h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash')
  assert.equal(calls, 1)
  assert.equal(h.calls.errors.at(-1), 'Refund rejected')
  assert.deepEqual(h.calls.busy, [true, false])
})

test('repeated clicks cannot create two concurrent refunds in the history', async () => {
  let release, calls = 0
  const waiting = new Promise(resolve => { release = resolve })
  const h = createCashTicketActionsHarness({ issuePosRefund: async () => { calls++; await waiting } })
  h.ticket.payload.localFiscal = { recordId: 'original-record' }
  const actions = h.render()
  const first = actions.refund(h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash')
  await actions.refund(h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash')
  assert.equal(calls, 1)
  release(); await first
})
