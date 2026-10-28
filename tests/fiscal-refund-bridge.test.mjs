import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent } from './helpers/component-harness.mjs'

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

test('a lost RPC acknowledgement recovers and delivers the exact committed refund without a second economic operation', async () => {
  const h = scenario({ rpcError: new TypeError('Failed to fetch'), restored: true })
  assert.equal(await h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash'), h.entry)
  assert.equal(h.calls.filter(call => call.name === 'create_ticket_refund').length, 1)
  assert.ok(h.calls.includes('recover-after-error'))
  assert.ok(h.calls.includes('incidence'))
  assert.ok(h.calls.some(call => call.bridge))
})

test('refunds reject foreign scope and duplicate selections before economic confirmation', async () => {
  const h = scenario()
  await assert.rejects(h.issuePosRefund({ ...context, tenantId: 'foreign' }, cash, h.ticket, [{ lineId: 'line', quantity: 1 }], 'cash'), /caja y local/)
  await assert.rejects(h.issuePosRefund(context, cash, h.ticket, [{ lineId: 'line', quantity: 1 }, { lineId: 'line', quantity: 1 }], 'cash'), /distintas/)
  assert.ok(!h.calls.some(call => call.name === 'create_ticket_refund'))
})
