import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridgeClient } from '../src/features/fiscal/local/bridgeClient.ts'

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
