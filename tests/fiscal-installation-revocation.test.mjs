import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { compileComponent } from './helpers/component-harness.mjs'
import { isFiscalTransportUnavailable } from '../src/features/fiscal/local/availability.ts'

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context = { tenantId: id(1), venueId: id(2), deviceId: id(3) }
const cash = { cashRegisterId: id(4) }
class Missing extends Error {}
class Revoked extends Missing { installationRevoked = true }
const revoked = { installationId: id(5), revokedAt: '2026-10-11T20:00:00.000Z', reason: 'Cambio de equipo' }

function harness() {
  const data = new Map(), calls = [], events = []
  let response = { data: revoked, error: null }
  let identity = { installation: { id: id(5), tenant_id: context.tenantId, venue_id: context.venueId, device_id: context.deviceId, cash_register_id: cash.cashRegisterId } }
  const module = compileComponent(readFileSync(new URL('../src/features/fiscal/local/installationRevocation.ts', import.meta.url), 'utf8'), {
    zod: { z }, '../../../lib/supabase.ts': { supabase: { rpc(name, body) { calls.push({ name, body }); return { abortSignal: async () => response } } } },
    './backendRead.ts': { readFiscalBackend: operation => operation() }, './availability.ts': { isFiscalTransportUnavailable },
    './localIdentity.ts': { readFiscalIdentity: async () => identity, FiscalInstallationRevokedError: Revoked },
    './localLedger.ts': { openLedger: async () => ({ transaction: () => ({ objectStore: () => ({ get: key => data.get(key), put: value => data.set(value.scope, value) }) }), close() {} }), request: async value => value, transactionDone: async () => {} },
  }, { window: { dispatchEvent: event => events.push(event) }, CustomEvent })
  return { module, data, calls, events, response: value => { response = value }, identity: value => { identity = value } }
}

test('a confirmed revocation persists across reload/offline, blocks issuance and leaves another installation untouched', async () => {
  const h = harness()
  await assert.rejects(h.module.checkFiscalInstallationRevocation(context, cash, 'identity'), Revoked)
  assert.equal(h.calls[0].name, 'pos_fiscal_installation_revocation')
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].body)), { p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_register_id: cash.cashRegisterId, p_device_id: context.deviceId, p_installation_id: id(5) })
  assert.ok(h.data.has(`pwa-revoked:${id(5)}`))
  assert.equal(h.events[0].detail, id(5))
  h.response({ data: null, error: new TypeError('Failed to fetch') })
  await assert.rejects(h.module.assertFiscalInstallationNotRevoked(id(5)), Revoked)
  await assert.rejects(h.module.checkFiscalInstallationRevocation(context, cash, 'identity'), Revoked)
  assert.equal(h.calls.length, 1, 'known revocation cannot be bypassed by an offline read')
  await h.module.assertFiscalInstallationNotRevoked(id(6))
})

test('outage, non-revoked status and unconfirmed identity never fabricate revocation', async () => {
  for (const response of [{ data: null, error: null }, { data: null, error: new TypeError('Failed to fetch') }]) {
    const h = harness(); h.response(response)
    await h.module.checkFiscalInstallationRevocation(context, cash, 'identity')
    assert.equal(h.data.size, 0)
  }
  const permission = harness(); permission.response({ data: null, error: { code: '42501', message: 'Forbidden' } })
  await assert.rejects(permission.module.checkFiscalInstallationRevocation(context, cash, 'identity'), error => error.code === '42501')
  assert.equal(permission.data.size, 0)
  const wrong = harness(); wrong.response({ data: { ...revoked, installationId: id(99) }, error: null })
  await assert.rejects(wrong.module.checkFiscalInstallationRevocation(context, cash, 'identity'), /no corresponde/)
  assert.equal(wrong.data.size, 0)
  const foreign = harness(); foreign.identity({ installation: { id: id(5), tenant_id: id(99), venue_id: context.venueId, device_id: context.deviceId, cash_register_id: cash.cashRegisterId } })
  await assert.rejects(foreign.module.checkFiscalInstallationRevocation(context, cash, 'identity'), /no corresponde/)
  assert.equal(foreign.calls.length, 0)
})
