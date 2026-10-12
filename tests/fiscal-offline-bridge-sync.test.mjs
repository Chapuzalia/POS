import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BridgeHttpError } from '../src/features/fiscal/local/bridgeClient.ts'
import { isFiscalTransportFailure } from '../src/features/fiscal/local/deliveryIncidence.ts'
import { compileComponent } from './helpers/component-harness.mjs'

const source = file => readFileSync(new URL(`../src/features/fiscal/local/${file}`, import.meta.url), 'utf8')
const scope = { tenantId: 'tenant', fiscalSubjectId: 'subject', installationId: 'installation' }
const clone = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(setImmediate)

function scenario(count = 4) {
  const entries = [], sales = [], rpcCalls = [], deliveries = []
  const economicStored = new Map(), bridgeStored = new Map(), locks = new Map(), timers = new Map()
  const navigator = {
    onLine: true,
    locks: { async request(key, _, action) {
      const previous = locks.get(key) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(action)
      locks.set(key, current)
      try { return await current } finally { if (locks.get(key) === current) locks.delete(key) }
    } },
  }
  const window = new EventTarget(), document = new EventTarget()
  document.visibilityState = 'visible'
  const economicSynced = 'tickit:fiscal-economic-synced'
  const acknowledgements = []
  window.addEventListener(economicSynced, event => acknowledgements.push(event.detail))
  let interval, requestMode = 'ok', signal, statusGate, bridgePasses = 0, reply = { state: 'VPS_STORED' }
  window.setInterval = action => { interval = action; return 1 }
  window.clearInterval = () => { interval = undefined }
  const globals = {
    navigator, window, document, AbortController, CustomEvent,
    setTimeout(action, ms) { const id = Symbol(); timers.set(id, { action, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  const addSale = () => {
    const n = entries.length + 1, id = `record-${n}`
    entries.push({ id, record: { ...scope, idempotencyKey: id, invoiceId: `invoice-${n}`, chainPosition: n,
      previous: n === 1 ? null : { hash: `hash-${n - 1}` }, hash: `hash-${n}`,
      lease: { leaseId: `local-lease-${n}`, fencingToken: n }, canonicalRecord: { RegistroAlta: { Huella: `hash-${n}` } } },
    invoice: { ticketId: `ticket-${n}`, saleId: `sale-${n}`, number: n, transmissionMode: 'bridge' },
    delivery: { state: 'LOCAL_PENDING', attempts: 0, lastError: null, nextAttemptAt: null, result: null } })
    sales.push({ id, eventId: `event-${n}`, payload: { sale: { id: `sale-${n}` } }, synced: false })
  }
  for (let n = 0; n < count; n++) addSale()
  const ledger = {
    FISCAL_ECONOMIC_SYNCED: economicSynced,
    listLocalFiscalEntries: async () => entries.map(entry => ({ ...entry, delivery: { ...entry.delivery } })),
    listPendingFiscalEconomicSales: async () => sales.filter(sale => !sale.synced),
    markFiscalEconomicSaleSynced: async id => { sales.find(sale => sale.id === id).synced = true },
    markLocalFiscalIncidence: async () => { for (const entry of entries) if (entry.delivery.state === 'LOCAL_PENDING') entry.delivery.incidence = true },
    updateLocalFiscalDelivery: async (id, delivery) => { const entry = entries.find(entry => entry.id === id); entry.delivery = { ...delivery, ...(entry.delivery.incidence ? { incidence: true } : {}) } },
  }
  const economic = compileComponent(source('economicSync.ts'), {
    './localLedger.ts': ledger,
    './deliveryIncidence.ts': { isFiscalTransportFailure },
    '../../../lib/supabase.ts': { supabase: { rpc(name, params) {
      assert.equal(name, 'sync_local_fiscal_sale_created')
      const wire = clone(params)
      rpcCalls.push(wire)
      return { abortSignal(value) {
        signal = value
        if (requestMode === 'fail') return Promise.resolve({ error: new Error('database unavailable') })
        const existing = economicStored.get(wire.p_record.idempotencyKey)
        if (existing) assert.deepEqual(wire, existing, 'retries must keep the event, payload and fiscal identity unchanged')
        else {
          assert.equal(wire.p_record.chainPosition, economicStored.size + 1)
          economicStored.set(wire.p_record.idempotencyKey, wire)
        }
        // The DB can commit while the acknowledgement never reaches the browser.
        if (requestMode === 'lost-response') return new Promise(() => {})
        return Promise.resolve({ error: null })
      } }
    } } },
  }, globals)
  const result = (id, state = 'VPS_STORED') => ({ idempotencyKey: id, state, code: null,
    description: null, csv: null, responseRef: null, vpsStoredAt: '2026-10-11T00:00:00Z', aeatRespondedAt: null })
  const bridge = compileComponent(source('sync.ts'), {
    './localLedger.ts': ledger,
    './deliveryIncidence.ts': { isFiscalTransportFailure },
    './bridgeClient.ts': { BridgeHttpError, createBridgeClient: config => {
      assert.equal(config.mode, 'production')
      bridgePasses++
      return {
        async status(id) {
          if (statusGate) await statusGate
          if (!bridgeStored.has(id)) throw new BridgeHttpError(404)
          return bridgeStored.get(id)
        },
        async deliver(records) {
          const record = clone(records[0])
          deliveries.push(record)
          assert.ok(economicStored.has(record.idempotencyKey), 'the bridge must not receive an economically unconfirmed sale')
          if (reply.state === 'REQUIRES_ACTION') return [{ ...result(record.idempotencyKey), ...reply, vpsStoredAt: null }]
          if (bridgeStored.has(record.idempotencyKey)) return [bridgeStored.get(record.idempotencyKey)]
          assert.equal(record.chainPosition, bridgeStored.size + 1, 'later sales must not overtake a pending predecessor')
          const response = result(record.idempotencyKey)
          bridgeStored.set(record.idempotencyKey, response)
          return [response]
        },
      }
    } },
  }, globals)
  const bridgeConfig = { ...scope, mode: 'production', baseUrl: 'http://localhost:3000/', getAccessToken: async () => 'session' }
  return { entries, sales, rpcCalls, deliveries, economicStored, bridgeStored, locks, timers, navigator, addSale,
    economic, acknowledgements, synchronizeBridge: () => bridge.synchronizeLocalFiscalQueue(bridgeConfig),
    startBridge: () => bridge.startFiscalSyncWhileOpen(bridgeConfig),
    bridgePasses: () => bridgePasses,
    acknowledge: detail => window.dispatchEvent(new CustomEvent(economicSynced, { detail })),
    holdStatus: () => { let release; statusGate = new Promise(resolve => { release = resolve }); return release },
    setRequestMode: value => { requestMode = value }, setReply: value => { reply = value },
    timeout: () => { for (const timer of [...timers.values()]) { assert.equal(timer.ms, 20_000); timer.action() } },
    interval: () => interval?.(), signal: () => signal,
  }
}

test('economic acknowledgement wakes the bridge immediately without waiting for its interval', async () => {
  const s = scenario(1)
  const stop = s.startBridge()
  try {
    await settle()
    assert.equal(s.deliveries.length, 0)
    await s.economic.synchronizeFiscalEconomicSales(scope)
    await settle()
    assert.deepEqual(s.acknowledgements, ['tenant:subject:installation'])
    assert.equal(s.sales[0].synced, true)
    assert.equal(s.deliveries.length, 1)
    assert.equal(s.entries[0].delivery.state, 'VPS_STORED')
    const passes = s.bridgePasses()
    for (const otherScope of ['other:subject:installation', 'tenant:other:installation', 'tenant:subject:other']) {
      s.acknowledge(otherScope)
    }
    await settle()
    assert.equal(s.bridgePasses(), passes, 'other fiscal scopes must not wake this worker')
    s.bridgeStored.set('record-1', { ...s.bridgeStored.get('record-1'), state: 'AEAT_ACCEPTED', aeatRespondedAt: '2026-10-11T00:00:01Z' })
    s.entries[0].delivery.nextAttemptAt = null
    s.interval()
    await settle()
    assert.equal(s.entries[0].delivery.state, 'AEAT_ACCEPTED', 'AEAT polling continues after durable bridge storage')
    assert.equal(s.deliveries.length, 1, 'polling must not resend the stored sale')
    const finalPasses = s.bridgePasses()
    stop()
    s.acknowledge('tenant:subject:installation')
    await settle()
    assert.equal(s.bridgePasses(), finalPasses, 'stopped workers must remove their listener')
  } finally { stop() }
})

test('an acknowledgement during a running bridge pass schedules another pass without losing the new sale', async () => {
  const s = scenario(1)
  await s.economic.synchronizeFiscalEconomicSales(scope)
  const releaseStatus = s.holdStatus()
  const stop = s.startBridge()
  try {
    await settle()
    s.addSale()
    await s.economic.synchronizeFiscalEconomicSales(scope)
    assert.equal(s.deliveries.length, 0)
    releaseStatus()
    await settle()
    assert.deepEqual(s.deliveries.map(record => record.chainPosition), [1, 2])
    assert.ok(s.entries.every(entry => entry.delivery.state === 'VPS_STORED'))
  } finally { releaseStatus(); stop() }
})

test('a lost economic acknowledgement does not wake bridge delivery until an idempotent retry succeeds', async () => {
  const s = scenario(1)
  const stop = s.startBridge()
  try {
    await settle()
    s.setRequestMode('lost-response')
    const pending = s.economic.synchronizeFiscalEconomicSales(scope)
    await settle()
    s.timeout()
    await assert.rejects(pending, /tiempo de espera/)
    assert.equal(s.acknowledgements.length, 0)
    assert.equal(s.deliveries.length, 0)
    s.setRequestMode('ok')
    await s.economic.synchronizeFiscalEconomicSales(scope)
    await settle()
    assert.equal(s.deliveries.length, 1)
    assert.deepEqual(s.rpcCalls[0], s.rpcCalls[1])
  } finally { stop() }
})

test('four disconnected sales and the subsequent online sale wait for economic acknowledgement and deliver in order', async () => {
  const s = scenario()
  s.navigator.onLine = false
  await s.economic.synchronizeFiscalEconomicSales(scope)
  await s.synchronizeBridge()
  assert.equal(s.rpcCalls.length, 0)
  assert.equal(s.deliveries.length, 0)
  s.navigator.onLine = true
  s.setRequestMode('lost-response')
  const recovery = s.economic.synchronizeFiscalEconomicSales(scope)
  await settle()
  s.addSale()
  await s.synchronizeBridge()
  assert.equal(s.deliveries.length, 0, 'a DB commit without acknowledgement is still pending locally')
  s.timeout()
  await assert.rejects(recovery, /tiempo de espera/)
  assert.equal(s.signal().aborted, true)
  assert.equal(s.timers.size, 0)
  assert.equal(s.locks.size, 0)
  assert.equal(s.sales.filter(sale => !sale.synced).length, 5)
  s.setRequestMode('ok')
  await s.economic.synchronizeFiscalEconomicSales(scope)
  await s.synchronizeBridge()
  assert.equal(s.economicStored.size, 5)
  assert.deepEqual(s.deliveries.map(record => record.chainPosition), [1, 2, 3, 4, 5])
  assert.ok(s.entries.every(entry => entry.delivery.state === 'VPS_STORED'))
  assert.ok(s.deliveries.every(record => record.deliveryIncidence === true), 'POS outages must reach the bridge on the first delivery')
  assert.ok(s.rpcCalls.every(call => !('deliveryIncidence' in call.p_record)), 'transport metadata must not alter the Supabase envelope')
  assert.deepEqual(s.rpcCalls[1], s.rpcCalls[0], 'the uncertain sale is replayed with the same idempotency key')
  await s.synchronizeBridge()
  assert.equal(s.deliveries.length, 5, 'stored records are polled, never duplicated')
})

test('a stalled RPC releases the background worker so the next interval can retry', async () => {
  const s = scenario(1)
  s.setRequestMode('lost-response')
  const stop = s.economic.startFiscalEconomicSyncWhileOpen(scope)
  try {
    await settle()
    s.interval()
    await settle()
    assert.equal(s.rpcCalls.length, 1, 'an in-flight request is not overlapped')
    s.timeout()
    await settle()
    s.setRequestMode('ok')
    s.interval()
    await settle()
    assert.equal(s.rpcCalls.length, 2)
    assert.equal(s.sales[0].synced, true)
    assert.equal(s.timers.size, 0)
  } finally { stop() }
})

test('economic failure leaves all sales pending and prevents later fiscal records from overtaking', async () => {
  const s = scenario()
  s.setRequestMode('fail')
  await assert.rejects(s.economic.synchronizeFiscalEconomicSales(scope), /database unavailable/)
  await s.synchronizeBridge()
  assert.equal(s.rpcCalls.length, 1)
  assert.equal(s.deliveries.length, 0)
  assert.ok(s.sales.every(sale => !sale.synced))
  assert.ok(s.entries.every(entry => entry.delivery.attempts === 0))
})

test('backoff on an unacknowledged predecessor blocks later sales and retains the actual bridge error', async () => {
  const s = scenario()
  await s.economic.synchronizeFiscalEconomicSales(scope)
  const before = clone(s.entries.map(entry => entry.record))
  const description = 'POS economic synchronization required before bridge ingestion'
  s.setReply({ state: 'REQUIRES_ACTION', code: 'VALIDATION_ERROR', description })
  await s.synchronizeBridge()
  assert.equal(s.deliveries.length, 1)
  assert.equal(s.entries[0].delivery.state, 'LOCAL_PENDING')
  assert.equal(s.entries[0].delivery.lastError, description)
  assert.ok(s.entries.every(entry => !entry.delivery.incidence), 'a validation error must not be misclassified as a connection outage')
  await s.synchronizeBridge()
  assert.equal(s.deliveries.length, 1, 'backoff must not cause later chain positions to be delivered')
  assert.deepEqual(clone(s.entries.map(entry => entry.record)), before)
  s.entries[0].delivery.nextAttemptAt = null
  s.setReply({ state: 'VPS_STORED' })
  await s.synchronizeBridge()
  assert.equal(s.bridgeStored.size, 4)
})

test('only technical transport failures qualify as delivery incidences', () => {
  assert.equal(isFiscalTransportFailure(new BridgeHttpError(404)), false)
  assert.equal(isFiscalTransportFailure(new BridgeHttpError(401)), false)
  assert.equal(isFiscalTransportFailure(new BridgeHttpError(503)), true)
  assert.equal(isFiscalTransportFailure(new TypeError('Failed to fetch')), true)
  assert.equal(isFiscalTransportFailure({ code: '', message: 'TypeError: Failed to fetch' }), true)
  assert.equal(isFiscalTransportFailure({ code: '23505', message: 'record conflict' }), false)
})

test('a lost bridge acknowledgement reports the POS incidence on the existing idempotent record', async () => {
  const s = scenario(1)
  await s.economic.synchronizeFiscalEconomicSales(scope)
  await s.synchronizeBridge()
  const accepted = { ...s.bridgeStored.get('record-1'), state: 'AEAT_ACCEPTED', aeatRespondedAt: '2026-10-11T00:00:01Z' }
  s.bridgeStored.set('record-1', accepted)
  s.entries[0].delivery = { state: 'LOCAL_PENDING', incidence: true, attempts: 1, lastError: 'Failed to fetch', nextAttemptAt: null, result: null }
  const original = clone(s.entries[0].record)
  await s.synchronizeBridge()
  assert.equal(s.bridgeStored.size, 1)
  assert.equal(s.deliveries.at(-1).deliveryIncidence, true)
  assert.equal(s.entries[0].delivery.state, 'AEAT_ACCEPTED')
  assert.equal(s.entries[0].delivery.incidence, true)
  assert.deepEqual(clone(s.entries[0].record), original)
})
