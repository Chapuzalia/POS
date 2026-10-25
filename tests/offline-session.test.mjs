import { UserFacingError } from '../src/utils/UserFacingError.ts'
import { createDurableSalesHarness } from './helpers/durable-sales-harness.mjs'
import * as observability from '../src/lib/observability.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { hasPersistedSessionForUser, isInvalidAuthError } from '../src/features/session/services/sessionValidity.ts'
import { appendFrozenQueueEvent, recordQueueEventFailure } from '../src/features/offline/services/offlineQueueState.ts'
import { isClosedCashSaleRejection } from '../src/features/offline/services/cashSessionRejection.ts'
import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'

import { isCrmUser } from '../src/app/app-permissions.ts'

const compiled = new Map()
function load(path, modules, globals = {}) {
  if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText)
  const exports = {}
  vm.runInNewContext(compiled.get(path), {
    exports, require: (id) => (id.endsWith('/UserFacingError.ts') ? { UserFacingError } : id.endsWith('/observability.ts') ? observability : modules[id] ?? {}), console, ...globals,
  })
  return exports
}

function hooks() {
  const slots = []
  let cursor = 0
  let effects = []
  const changed = (slot, deps) => !slot || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))
  const react = {
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useState(initial) {
      const i = cursor++
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }]
    },
    useCallback(callback, deps) {
      const i = cursor++
      if (changed(slots[i], deps)) slots[i] = { callback, deps }
      return slots[i].callback
    },
    useEffect(callback, deps) {
      const i = cursor++
      if (changed(slots[i], deps)) effects.push(() => {
        slots[i]?.cleanup?.()
        slots[i] = { deps, cleanup: callback() }
      })
    },
  }
  return {
    react,
    render(fn, ...args) {
      cursor = 0; effects = []
      const result = fn(...args)
      effects.forEach((effect) => effect())
      return result
    },
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))
const storage = () => {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
}
const context = { userId: 'user', tenantId: 'tenant', venueId: 'venue', deviceId: 'device', role: 'cashier' }
const cash = { id: 'existing-cash', status: 'open' }
const credentials = JSON.stringify({ user: { id: 'user' }, access_token: 'expired-access', refresh_token: 'supabase-refresh', expires_at: 1 })

async function harness({ online = true, boot = false, refreshError = null } = {}) {
  const window = new EventTarget()
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const timers = new Map()
  let timerId = 0
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }
  window.clearTimeout = (id) => timers.delete(id)
  window.localStorage = storage()
  const globals = { window, document, crypto, localStorage: window.localStorage, sessionStorage: storage() }
  const durable = createDurableSalesHarness()
  const store = load('lib/offlineStore', {
    './durableSales.ts': durable,
    '../app/app-routes': { getAppRoute: () => 'pos' },
    '../features/offline/services/offlineQueueState.ts': { appendFrozenQueueEvent, recordQueueEventFailure },
  }, globals)
  store.saveCachedContext(context)
  store.saveCachedCashSession(context, cash)
  let raw = credentials
  let authListener = () => {}
  const calls = []
  const faults = { refresh: refreshError, lease: null, load: null }
  const user = { id: 'user', user_metadata: {} }
  const supabase = {
    auth: {
      onAuthStateChange: (callback) => { authListener = callback; return { data: { subscription: { unsubscribe() {} } } } },
      refreshSession: async () => { calls.push('refresh'); return { data: { session: { user } }, error: faults.refresh } },
      getUser: async () => { calls.push('user'); return { data: { user }, error: null } },
      getSession: () => { throw new Error('Offline must not call getSession') },
      signOut: async () => { calls.push('logout'); raw = null; authListener('SIGNED_OUT'); return { error: null } },
    },
    rpc: async (name) => {
      calls.push(name)
      return { data: name === 'get_current_tenant_features' ? [] : true, error: name.includes('login') ? faults.lease : null }
    },
    from: (table) => {
      const rows = {
        profiles: {}, tenants: { id: 'tenant', is_active: true }, tenant_memberships: { role: 'cashier' },
        device_user_assignments: { device_id: 'device', venue_id: 'venue' },
        venues: { id: 'venue' }, devices: { id: 'device' },
      }
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: rows[table], error: null }) }
      return query
    },
  }
  const supabaseModule = { supabase, supabaseConfig: { isReady: true }, hasLocalSupabaseSession: (id) => hasPersistedSessionForUser(raw, id) }
  const lease = load('services/loginLeaseService', { '../lib/supabase': supabaseModule }, globals)
  const service = load('services/posService', {
    '../lib/supabase': supabaseModule,
    '../features/session/services/sessionValidity': { isInvalidAuthError },
    '../features/platform/tenantFeatureAccess': { normalizeTenantFeatures: (features) => features, hasTenantCapability: () => false },
    './loginLeaseService': lease,
  }, globals)
  const syncRunner = hooks()
  const synced = []
  const syncHook = load('hooks/useOfflineSync', {
    '../lib/durableSales.ts': durable,
    react: syncRunner.react, '../lib/offlineStore': store, '../lib/supabase': supabaseModule,
    '../services/posService': { syncEvent: async (event) => { calls.push('sync'); synced.push(event) } },
    '../utils/errors': { getReadableError: String },
    '../features/offline/services/cashSessionRejection': { isClosedCashSaleRejection },
  }, globals).useOfflineSync
  const runner = hooks()
  const hook = load('features/session/hooks/useTenantSession', {
    react: runner.react, '../../../lib/offlineStore': store, '../../../lib/supabase': supabaseModule,
    '../../../services/posService': service, '../../../services/loginLeaseService': lease,
    '../../../utils/errors': { getReadableError: String }, '../../../app/app-permissions': { isBackofficeUser: () => false },
    '../../../lib/diagnostics': { addDiagnosticBreadcrumb() {} },
    '../../../lib/backendFetch': { backendUnavailableEvent: 'pos:backend-unavailable' },
  }, globals).useTenantSession
  const state = { ready: false, context: boot ? null : context, cash: boot ? null : cash, cleared: 0, hydrated: 0, error: null }
  const options = {
    context: state.context, isOnline: online, loginLeaseBlocked: false, pendingLoginContext: null,
    setSessionReady: (value) => { state.ready = value },
    loadTenantState: async () => { calls.push('load'); if (faults.load) throw faults.load; return { cashSession: cash } },
    applyTenantState: (next, data) => { state.context = next; state.cash = data.cashSession; store.saveCachedContext(next) },
    applyOfflineState: async (next) => { state.hydrated++; state.context = next; state.cash = store.getCachedCashSession(next) },
    clearActiveState: () => { state.cleared++; state.context = null; state.cash = null },
    setError: (value) => { state.error = value },
    setIsBootstrapping() {}, setIsBusy() {}, setIsLoading() {},
    setLoginLeaseBlocked: (value) => { options.loginLeaseBlocked = value },
    setPendingLoginContext: (value) => { options.pendingLoginContext = value },
  }
  let actions
  function render() {
    options.context = state.context
    const offline = syncRunner.render(syncHook, options.isOnline, state.ready)
    options.syncPendingEvents = offline.syncPendingEvents
    actions = runner.render(hook, options)
  }
  render()
  await flush()
  return { durable, calls, faults, state, options, store, service, lease, globals, timers, synced, render, supabase, get actions() { return actions }, signOut: () => { raw = null; authListener('SIGNED_OUT') } }
}

test('2: refresh con network error mantiene sesión y caja, sin signOut', async () => {
  const h = await harness({ refreshError: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) })
  assert.equal(h.state.cleared, 0)
  assert.equal(h.state.cash.id, cash.id)
  assert.equal(h.state.ready, false)
  assert.deepEqual(h.calls, ['refresh'])
  assert.ok(h.store.getCachedContext())
})

test('3 y 8: rechazo explícito del refresh, también al reconectar, cierra sesión', async () => {
  for (const reconnect of [false, true]) {
    const invalid = { code: 'refresh_token_not_found', name: 'AuthApiError', status: 400 }
    const h = await harness({ refreshError: reconnect ? null : invalid })
    if (reconnect) {
      h.options.isOnline = false; h.render(); await flush()
      h.faults.refresh = invalid
      h.options.isOnline = true; h.render(); await flush()
    }
    assert.equal(h.state.context, null)
    assert.equal(h.store.getCachedContext(), null)
    assert.ok(h.calls.includes('logout'))
    assert.equal(await h.service.hasValidOfflineSession(context), false)
  }
})

test('4 y 7: venta offline en la caja existente, validar → lease → sincronizar al reconectar', async () => {
  const h = await harness()
  h.options.isOnline = false; h.render(); await flush()
  const paymentRunner = hooks()
  const pay = load('features/quick-sale/hooks/useQuickSalePayment', {
    '../../../lib/durableSales.ts': h.durable,
    react: paymentRunner.react, '../../../lib/offlineStore': h.store,
    '../../../lib/format': { createId: () => crypto.randomUUID() }, '../services/salePayload': { buildSalePayload },
    '../../local-printing/cashlogy/useCashlogyStore': { getCashlogyPaymentAmounts: () => ({}), finishCashlogyPayment() {} },
    '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
    '../../../services/posService': { loadSessionTicketFromSupabase: async () => null },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { assertRealSaleAllowed() {}, resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': { issuePosInvoice: async () => { throw new Error('production disabled') }, printPayloadWithLocalFiscal: (payload) => payload },
    '../../fiscal/local/economicSync.ts': { synchronizeFiscalEconomicSales: async () => {} },
    '../../fiscal/local/sync.ts': { synchronizeLocalFiscalQueue: async () => {} },
    '../../fiscal/local/installation.ts': { fiscalBridgeAccessToken: async () => '', fiscalBridgeBaseUrl: () => '' },
  }, h.globals).useQuickSalePayment
  const paymentInFlightChanges = []
  const payment = paymentRunner.render(pay, {
    context, cashSession: h.state.cash, isOnline: false, discount: null, invoiceCustomer: null, ledger: [], tickets: [],
    lines: [{ id: 'line', productId: 'product', productName: 'Café', variantId: 'variant', variantName: 'Normal', quantity: 1,
      basePriceCents: 200, unitPriceCents: 200, componentDeltaCents: 0, modifierDeltaCents: 0, components: [], modifiers: [], catalogSnapshot: { vatRate: 10 } }],
    persistLedger: (ledger) => h.store.saveSaleLedger(context, ledger), persistTickets() {}, persistLines() {}, mergeProductStats() {},
    resetUi() {}, refreshPendingCount() {}, printSale: async () => {}, onError: assert.fail,
    onPaymentInFlightChange: (inFlight) => paymentInFlightChanges.push(inFlight),
    syncPendingEvents: () => assert.fail('No sync offline'),
  })
  const previousWindow = globalThis.window
  globalThis.window = { crypto }
  try { await payment('card', 200) } finally { globalThis.window = previousWindow }
  assert.deepEqual(paymentInFlightChanges, [true, false])
  assert.equal(h.store.getOfflineQueue().length, 1)
  assert.equal(h.store.getOfflineQueue()[0].payload.ticket.cashSessionId, cash.id)
  h.calls.length = 0
  h.options.isOnline = true; h.render(); await flush()
  assert.equal(h.state.cleared, 0)
  assert.equal(h.state.ready, true)
  assert.equal(h.state.cash.id, cash.id)
  assert.equal(h.store.getOfflineQueue().length, 0)
  assert.equal(h.synced[0].payload.ticket.cashSessionId, cash.id)
  assert.ok(h.calls.indexOf('refresh') < h.calls.indexOf('claim_user_login'))
  assert.ok(h.calls.indexOf('claim_user_login') < h.calls.indexOf('sync'))
})

test('6: un heartbeat fallido conserva el lease y la sesión; false confirmado sí cierra', async () => {
  const h = await harness()
  const runner = hooks()
  const useActivity = load('features/session/hooks/useLoginActivity', {
    react: runner.react, '../../../services/loginLeaseService': h.lease,
    '../../../app/app-permissions': { isCrmUser },
  }, h.globals).useLoginActivity
  const closed = []
  const activityOptions = { context, isOnline: true, onSessionClosed: async (...args) => closed.push(args) }
  h.faults.lease = new TypeError('fetch failed')
  runner.render(useActivity, activityOptions); await flush()
  await assert.rejects(h.lease.heartbeatLoginLease(), /fetch failed/)
  assert.equal(closed.length, 0)
  const identity = h.globals.sessionStorage.getItem('club-pos:login-instance-id')
  h.faults.lease = null
  h.globals.document.dispatchEvent(new Event('visibilitychange')); await flush()
  assert.equal(closed.length, 0)
  assert.equal(h.globals.sessionStorage.getItem('club-pos:login-instance-id'), identity)
  h.supabase.rpc = async () => ({ data: false, error: null })
  h.globals.document.dispatchEvent(new Event('visibilitychange')); await flush()
  assert.equal(closed.length, 1)
  assert.equal(closed[0][1], true)
})

test('SIGNED_OUT durante una restauración pendiente no resucita el usuario', async () => {
  const h = await harness()
  h.options.isOnline = false; h.render(); await flush()
  let resolveRefresh
  h.supabase.auth.refreshSession = () => new Promise((resolve) => { resolveRefresh = resolve })
  h.options.isOnline = true; h.render()
  h.signOut()
  resolveRefresh({ data: { session: { user: { id: 'user' } } }, error: null }); await flush()
  assert.equal(h.state.context, null)
  assert.equal(h.store.getCachedContext(), null)
})
