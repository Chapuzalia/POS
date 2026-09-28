import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeHttpError, createBridgeClient } from '../src/features/fiscal/local/bridgeClient.ts'

const record = {
  idempotencyKey: 'record-1', environment: 'test', tenantId: 'tenant-1', fiscalSubjectId: 'subject-1',
  issuerNif: '89890001K', venueId: 'venue-1', cashRegisterId: 'register-1',
  installationId: 'install-1', deviceId: 'device-1', invoiceId: 'invoice-1',
  chainPosition: 1, previous: null, hash: 'A'.repeat(64),
  generatedAt: '2024-01-01T19:20:30+01:00', canonicalSchema: 'aeat-registro-v1',
  canonicalRecord: { RegistroAlta: { Huella: 'A'.repeat(64) } },
  invoice: { issuerName: 'Emisor ficticio', issuerNif: '89890001K', series: 'L1-C1-I1-2024-S',
    number: 1, issuedAt: '2024-01-01T19:20:30+01:00', qrUrl: 'https://aeat.example.invalid/qr',
    ticketId: 'ticket-1', saleId: 'sale-1', paymentId: null,
    lines: [{ description: 'Servicio ficticio', grossCents: 1210, discountCents: 0, baseCents: 1000,
      taxCents: 210, taxRate: '21.00' }], recipient: null, totalCents: 1210, taxCents: 210 },
}

test('production transport requires HTTPS and never accepts test records', async () => {
  const production = createBridgeClient({ mode: 'production', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
  await assert.rejects(production.deliver([record]), /entorno del registro/)
  assert.throws(() => createBridgeClient({ mode: 'test', baseUrl: 'http://bridge.example/', getAccessToken: async () => 'token' }), /HTTPS/)
})

test('test bridge refuses production records before any network call', async () => {
  const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
  await assert.rejects(client.deliver([{ ...record, environment: 'production' }]), /entorno del registro/)
})

test('durable response is per record and never rewrites the fiscal input', async () => {
  const originalFetch = globalThis.fetch
  let sent
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    assert.equal(init.headers.Authorization, 'Bearer temporary-token')
    return new Response(JSON.stringify({ contract: 'tickit-verifactu-bridge', version: 1, results: [{
      idempotencyKey: record.idempotencyKey, state: 'VPS_STORED', code: null,
      description: null, csv: null, responseRef: null,
      vpsStoredAt: '2024-01-01T18:20:33Z', aeatRespondedAt: null,
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'temporary-token' })
    const result = await client.deliver([record])
    assert.equal(result[0].state, 'VPS_STORED')
    assert.deepEqual(sent.records[0].canonicalRecord, record.canonicalRecord)
    assert.deepEqual(sent.records[0].invoice, record.invoice)
    assert.equal(record.hash, 'A'.repeat(64))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a VPS response cannot claim a local-only state', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ contract: 'tickit-verifactu-bridge', version: 1, results: [{
    idempotencyKey: record.idempotencyKey, state: 'LOCAL_PENDING', code: null,
    description: null, csv: null, responseRef: null, vpsStoredAt: null, aeatRespondedAt: null,
  }] }), { status: 200 })
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    await assert.rejects(client.deliver([record]), /individualmente/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('lost POST response is queried by the same idempotency key', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), init?.method ?? 'GET'])
    if (init?.method === 'POST') throw new Error('timeout')
    return new Response(JSON.stringify({ idempotencyKey: record.idempotencyKey, state: 'VPS_STORED', code: null,
      description: null, csv: null, responseRef: null, vpsStoredAt: '2024-01-01T18:20:33Z', aeatRespondedAt: null }), { status: 200 })
  }
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    await assert.rejects(client.deliver([record]), /timeout/)
    assert.equal((await client.status(record.idempotencyKey)).state, 'VPS_STORED')
    assert.deepEqual(seen.map(([, method]) => method), ['POST', 'GET'])
  } finally { globalThis.fetch = originalFetch }
})

test('duplicate remains actionable until AEAT identity and hash are reconciled', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ idempotencyKey: record.idempotencyKey, state: 'REQUIRES_ACTION', code: 'DUPLICATE',
    description: 'Consultar registro preexistente', csv: null, responseRef: 'response-1', vpsStoredAt: '2024-01-01T18:20:33Z', aeatRespondedAt: '2024-01-01T18:21:33Z' }), { status: 200 })
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    const result = await client.status(record.idempotencyKey)
    assert.equal(result.state, 'REQUIRES_ACTION')
    assert.notEqual(result.state, 'AEAT_ACCEPTED')
  } finally { globalThis.fetch = originalFetch }
})

test('exclusive installation lease refuses another device identity', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ contract: 'tickit-verifactu-bridge', version: 1,
    leaseId: 'lease-1', installationId: 'install-1', deviceId: 'other-ipad', fencingToken: 3,
    expiresAt: '2026-09-28T11:00:00Z', serverUtcAt: '2026-09-28T10:00:00Z' }), { status: 200 })
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    await assert.rejects(client.acquireInstallationLease('install-1', 'ipad-1'), /otro dispositivo/)
  } finally { globalThis.fetch = originalFetch }
})

test('a status failure retains its HTTP code and does not imply a missing record', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    await assert.rejects(client.status(record.idempotencyKey), error => error instanceof BridgeHttpError && error.status === 503)
  } finally { globalThis.fetch = originalFetch }
})

test('response events are scoped to the requested idempotency key', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ idempotencyKey: record.idempotencyKey, events: [{
    at: '2026-09-28T10:01:00Z', state: 'AEAT_ACCEPTED_WITH_ERRORS', code: 'W01',
    description: 'Advertencia ficticia', csv: 'CSV-FICTICIO', responseRef: 'response-1',
  }] }), { status: 200 })
  try {
    const client = createBridgeClient({ mode: 'test', baseUrl: 'https://bridge.example/', getAccessToken: async () => 'token' })
    const events = await client.responses(record.idempotencyKey)
    assert.equal(events[0].state, 'AEAT_ACCEPTED_WITH_ERRORS')
    assert.equal(events[0].csv, 'CSV-FICTICIO')
    await assert.rejects(client.responses('record-2'), /otro registro/)
  } finally { globalThis.fetch = originalFetch }
})
