import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { compileComponent } from './helpers/component-harness.mjs'
import { readFiscalBackend } from '../src/features/fiscal/local/backendRead.ts'
import { assertFiscalLease, createLocalFallbackLease } from '../src/features/fiscal/local/clock.ts'
import { isFiscalTransportUnavailable } from '../src/features/fiscal/local/availability.ts'
import { isFiscalBridgeOrigin } from '../src/features/fiscal/local/bridgeUrl.ts'
import { UserFacingError } from '../src/utils/UserFacingError.ts'

const source = name => readFileSync(new URL(`../src/features/fiscal/local/${name}.ts`, import.meta.url), 'utf8')
const tenantId = '11111111-1111-4111-8111-111111111111'
const venueId = '22222222-2222-4222-8222-222222222222'
const deviceId = '33333333-3333-4333-8333-333333333333'
const cashRegisterId = '44444444-4444-4444-8444-444444444444'
const subjectId = '55555555-5555-4555-8555-555555555555'
const installationId = '66666666-6666-4666-8666-666666666666'
const context = { tenantId, venueId, deviceId, userId: deviceId }
const cashSession = { cashRegisterId }
const snapshot = {
  installation: { id: installationId, tenant_id: tenantId, fiscal_subject_id: subjectId,
    venue_id: venueId, cash_register_id: cashRegisterId, device_id: deviceId,
    installation_number: 'BCN-C1-1', venue_code: 'BCN', register_code: 'C1', installation_code: 'I1',
    installation_sequence: 1, series_version: 2, bridge_requested: true, mode: 'production', retired_at: null },
  subject: { id: subjectId, tenant_id: tenantId, legal_name: 'Bar SL', nif: 'B12345678' },
}
const settings = { tenant_id: tenantId, bridge_url: 'https://bridge.example/', aeat_environment: 'production',
  producer_name: 'Productor', producer_nif: 'B12345678', system_id: 'TK', system_version: '1' }

function harness({ offline = true, identity = snapshot, cachedSettings = settings, ledgerError = null, response = null, enabled = true, retiredForVerifactu = false } = {}) {
  const globals = { navigator: { onLine: !offline }, AbortController, setTimeout, clearTimeout,
    DOMException, TypeError, URL, crypto, performance,
    window: { localStorage: { getItem: () => cachedSettings ? JSON.stringify(cachedSettings) : null, setItem() {} } } }
  const reader = compileComponent(source('backendRead'), {}, globals).readFiscalBackend
  const signals = []
  const calls = { network: 0, ledger: 0, bridge: 0 }
  const client = {
    rpc(name) {
      calls.network++
      if (name === 'pos_verifactu_retired_identity') return { abortSignal: async () => ({ data: retiredForVerifactu, error: null }) }
      return query
    },
    from() { calls.network++; return query },
  }
  const query = {
    select() { return this }, eq() { return this }, is() { return this },
    order() { return this }, limit() { return this },
    abortSignal(signal) { signals.push(signal); return this },
    maybeSingle() { return this },
    then(resolve, reject) { return (response ? Promise.resolve(response) : new Promise(() => {})).then(resolve, reject) },
  }
  const backend = { readFiscalBackend: request => reader(request, 5) }
  const settingsService = compileComponent(source('settings'), {
    zod: { z }, '../../../lib/supabase.ts': { supabase: client }, './backendRead.ts': backend,
    './bridgeUrl.ts': { isFiscalBridgeOrigin }, '../../../utils/UserFacingError.ts': { UserFacingError },
  }, globals)
  const installation = compileComponent(source('installation'), {
    zod: { z }, '../../../lib/supabase.ts': { supabase: client }, './backendRead.ts': backend,
    './settings.ts': settingsService, './availability.ts': { isFiscalTransportUnavailable },
    './integration.ts': { loadVerifactuIntegration: async () => ({ enabled_at: enabled ? '2026-10-11' : null }) },
    './installationRevocation.ts': { assertFiscalInstallationNotRevoked: async () => {}, refreshFiscalInstallationRevocation: async () => false },
    './clock.ts': { assertFiscalLease, createLocalFallbackLease },
    './bridgeClient.ts': { createBridgeClient() { calls.bridge++; throw new Error('Bridge must not be contacted offline') } },
    './serverRecovery.ts': { recoverServerConfirmedFiscalChain: async () => 0 },
    '../../../utils/UserFacingError.ts': { UserFacingError },
    './localIdentity.ts': { readFiscalIdentity: async () => identity, FiscalIdentityMissingError: class extends Error {},
      readPendingFiscalActivation: async () => null,
      assertFiscalLedgerHeadValid: async () => { calls.ledger++; if (ledgerError) throw ledgerError } },
  }, globals)
  const recovery = compileComponent(source('serverRecovery'), {
    zod: { z }, '../../../lib/supabase.ts': { supabase: client }, './backendRead.ts': backend,
    './localLedger.ts': { readLocalFiscalHead: async () => ({ entry: null }),
      reconcileLocalFiscalCopies: () => assert.fail('Outage cannot reconcile a chain') },
  }, globals)
  return { installation, recovery, calls, signals, settingsService }
}

test('offline fiscal preparation uses the validated local identity/settings without contacting Supabase or bridge', async () => {
  const h = harness()
  const installation = await h.installation.loadFiscalInstallation(context, cashSession)
  assert.equal(installation.installationId, installationId)
  assert.equal(installation.issuerNif, snapshot.subject.nif)
  assert.equal(installation.aeatEnvironment, 'production')
  assert.equal((await h.installation.getFiscalInstallationLease(installation)).source, 'local-fallback')
  await assert.rejects(h.recovery.recoverServerConfirmedFiscalChain(installation), isFiscalTransportUnavailable)
  assert.equal(h.calls.network, 0)
  assert.equal(h.calls.bridge, 0)
  assert.equal(h.calls.ledger, 1)
})

test('unresponsive backend with navigator online falls back to local preparation and aborts its reads', async () => {
  const h = harness({ offline: false })
  const installation = await h.installation.loadFiscalInstallation(context, cashSession)
  assert.equal(installation.installationId, installationId)
  await assert.rejects(h.recovery.recoverServerConfirmedFiscalChain(installation), isFiscalTransportUnavailable)
  assert.ok(h.signals.length > 0)
  assert.ok(h.signals.every(signal => signal.aborted))
})

test('offline preparation still blocks missing identity, missing settings, damaged ledger and foreign scopes', async () => {
  const scenarios = [
    { identity: null }, { cachedSettings: null }, { ledgerError: new Error('Damaged ledger') },
    { identity: { ...snapshot, installation: { ...snapshot.installation, device_id: subjectId } } },
    { identity: { ...snapshot, subject: { ...snapshot.subject, tenant_id: subjectId } } },
    { cachedSettings: { ...settings, tenant_id: subjectId } },
  ]
  for (const scenario of scenarios) {
    const h = harness(scenario)
    await assert.rejects(h.installation.loadFiscalInstallation(context, cashSession))
    assert.equal(h.calls.network, 0)
  }
})

test('online retirement and permission rejection never fall back to the cached installation', async () => {
  for (const response of [{ data: null, error: null },
    { data: null, error: { code: '42501', message: 'Permission denied', details: '', hint: '' } }]) {
    const h = harness({ offline: false, response })
    await assert.rejects(h.installation.loadFiscalInstallation(context, cashSession))
    assert.equal(h.calls.network, response.error ? 1 : 2)
  }
})

test('fresh fiscal settings remain mandatory for activation recovery while offline', async () => {
  const h = harness()
  await assert.rejects(h.settingsService.loadFiscalPosSettings(tenantId, false), /confirmar en Supabase/)
  assert.equal(h.calls.network, 0)
})

test('local entry retains the same identity and sequence while only confirmed activation requires a bridge identity', async () => {
  const identity={...snapshot,installation:{...snapshot.installation,bridge_requested:false}}
  const h=harness({identity})
  const historical=await h.installation.loadFiscalInstallation(context,cashSession)
  assert.equal(historical.installationId,installationId)
  assert.equal(historical.bridgeUrl,null)
  await assert.rejects(h.installation.loadFiscalInstallation(context,cashSession,true),error=>error instanceof h.installation.FiscalBridgeIdentityRequiredError)
  const active=harness()
  assert.equal((await active.installation.loadFiscalInstallation(context,cashSession,true)).bridgeUrl,settings.bridge_url)
  const disabled=harness({identity,enabled:false})
  assert.equal((await disabled.installation.loadFiscalInstallation(context,cashSession,true)).bridgeUrl,null)
  const prepared=harness({enabled:false})
  assert.equal((await prepared.installation.loadFiscalInstallation(context,cashSession,true)).bridgeUrl,null,'a saved URL must not activate transport')
  const unconfigured=harness({identity,cachedSettings:{...settings,bridge_url:''}})
  await assert.rejects(unconfigured.installation.loadFiscalInstallation(context,cashSession,true),/configuración de remisión Verifactu/)
  const retired=harness({offline:false,response:{data:null,error:null},retiredForVerifactu:true})
  await assert.rejects(retired.installation.loadFiscalInstallation(context,cashSession,true),error=>error instanceof retired.installation.FiscalBridgeIdentityRequiredError)
})

test('bridge activation replays the same request after a lost reply and reload without losing the old chain', async () => {
  const nextId = '77777777-7777-4777-8777-777777777777'
  const original = { ...snapshot, installation: { ...snapshot.installation, bridge_requested: true } }
  const next = { ...snapshot, installation: { ...snapshot.installation, id: nextId, installation_sequence: 2 } }
  let identity = original, pending = null, committed = false
  const requests = [], validated = [], persisted = [], recovered = []
  const globals = { navigator: { onLine: true, locks: { request: async (_key, _options, action) => action() } }, URL }
  const query = data => {
    const value = { select() { return this }, eq() { return this }, is() { return this },
      abortSignal() { return this }, maybeSingle: async () => ({ data, error: null }) }
    return value
  }
  const client = {
    rpc(name, params) {
      if (name === 'pos_fiscal_preparation') return { abortSignal: async () => ({ data: committed ? null : { ...original, settings, head: null }, error: null }) }
      if (name === 'pos_verifactu_retired_identity') return { abortSignal: async () => ({ data: true, error: null }) }
      assert.equal(name, 'activate_pwa_fiscal_installation')
      requests.push(params)
      assert.equal(params.p_expected_installation_id, null)
      if (!committed) { committed = true; return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } }) }
      return Promise.resolve({ data: nextId, error: null })
    },
    from(name) { return query(name === 'fiscal_sif_installations' ? next.installation : next.subject) },
  }
  const modules = {
    zod: { z }, '../../../lib/supabase.ts': { supabase: client },
    './backendRead.ts': { readFiscalBackend: action => action() },
    './settings.ts': { loadFiscalPosSettings: async () => settings, rememberFiscalPosSettings: () => settings },
    './integration.ts': { loadVerifactuIntegration: async () => ({ enabled_at: '2026-10-11' }) },
    './installationRevocation.ts': { assertFiscalInstallationNotRevoked: async () => {}, refreshFiscalInstallationRevocation: async () => false },
    './availability.ts': { isFiscalTransportUnavailable }, './clock.ts': { assertFiscalLease, createLocalFallbackLease },
    './bridgeClient.ts': {}, '../../../utils/UserFacingError.ts': { UserFacingError },
    './serverRecovery.ts': { recoverServerConfirmedFiscalChain: async value => recovered.push(value.installationId) },
    './localIdentity.ts': {
      FiscalIdentityMissingError: class extends Error {}, readFiscalIdentity: async () => identity,
      readPendingFiscalActivation: async () => pending,
      fiscalActivationRequest: async (_key, expectedInstallationId, recoverForTesting) => {
        pending ??= { requestId: 'same-request', expectedInstallationId, recoverForTesting }
        return pending
      },
      assertFiscalLedgerHeadValid: async scope => validated.push(scope),
      persistFiscalIdentity: async (_key, value) => { persisted.push(value); identity = value; pending = null },
    },
  }
  const first = compileComponent(source('installation'), modules, globals)
  await assert.rejects(first.activateFiscalInstallation(context, cashSession, null), error => error.message === 'Failed to fetch')
  assert.equal(identity, original)
  assert.equal(persisted.length, 0)
  const reload = compileComponent(source('installation'), modules, globals)
  await assert.rejects(reload.loadFiscalInstallation(context, cashSession, true), error => error instanceof reload.FiscalBridgeIdentityRequiredError)
  const active = await reload.activateFiscalInstallation(context, cashSession, nextId)
  assert.equal(active.installationId, nextId)
  assert.equal(active.bridgeUrl, settings.bridge_url)
  assert.deepEqual({ ...requests[0] }, { ...requests[1] })
  assert.deepEqual(recovered, [nextId])
  assert.equal(persisted.length, 1)
  assert.equal(original.installation.id, installationId)
  assert.ok(validated.includes(`${tenantId}:${subjectId}:${installationId}`))
  assert.ok(validated.includes(`${tenantId}:${subjectId}:${nextId}`))
})

test('a timed-out read ignores a late response and successful/forbidden reads retain their results', async () => {
  let finish, signal
  const late = new Promise(resolve => { finish = resolve })
  const result = await readFiscalBackend(value => { signal = value; return late }, 5)
  assert.ok(isFiscalTransportUnavailable(result.error))
  assert.equal(signal.aborted, true)
  finish({ data: 'late', error: null })
  assert.equal(result.data, null)
  for (const response of [{ data: 'ok', error: null },
    { data: null, error: { code: '42501', message: 'Permission denied', details: '', hint: '' } }]) {
    assert.equal(await readFiscalBackend(async () => response, 5), response)
  }
})
