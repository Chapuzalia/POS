import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FiscalInstallation } from '../../src/features/fiscal/local/installation.ts'

const { httpFetch, readHead, readRecord, reconcile } = vi.hoisted(() => ({
  httpFetch: vi.fn(), readHead: vi.fn(), readRecord: vi.fn(), reconcile: vi.fn(),
}))

vi.mock('../../src/lib/supabase.ts', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  const { backendFetch } = await import('../../src/lib/backendFetch')
  return { supabase: createClient('https://fiscal.example.com', 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: backendFetch },
  }) }
})
vi.mock('../../src/features/fiscal/local/localLedger.ts', () => ({
  readLocalFiscalHead: readHead, readLocalFiscalRecord: readRecord, reconcileLocalFiscalCopies: reconcile,
}))

import { recoverServerConfirmedFiscalChain } from '../../src/features/fiscal/local/serverRecovery.ts'

const installation: FiscalInstallation = {
  tenantId: crypto.randomUUID(), fiscalSubjectId: crypto.randomUUID(), installationId: crypto.randomUUID(),
  venueId: crypto.randomUUID(), cashRegisterId: crypto.randomUUID(), deviceId: crypto.randomUUID(),
  issuerName: 'Test issuer', issuerNif: '89890001K', installationNumber: 'installation',
  venueCode: 'L1', registerCode: 'C1', installationCode: 'I1', timezone: 'Europe/Madrid',
  installationSequence: 1, seriesVersion: 2, bridgeUrl: null, aeatEnvironment: 'test',
  system: { NombreRazon: 'Test', NIF: '89890001K', NombreSistemaInformatico: 'Tickit',
    IdSistemaInformatico: 'TK', Version: 'test', NumeroInstalacion: 'installation',
    TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S' },
}

function row(position: number) {
  const id = crypto.randomUUID()
  const hash = position.toString(16).toUpperCase().padStart(64, '0')
  const ticketId = crypto.randomUUID()
  const saleId = crypto.randomUUID()
  return {
    id, tenant_id: installation.tenantId, fiscal_subject_id: installation.fiscalSubjectId,
    installation_id: installation.installationId, ticket_id: ticketId, sale_id: saleId, refund_request_id: null,
    record_kind: 'alta', chain_position: position, hash,
    record_envelope: {
      idempotencyKey: id, environment: 'production', tenantId: installation.tenantId,
      fiscalSubjectId: installation.fiscalSubjectId, installationId: installation.installationId,
      venueId: installation.venueId, cashRegisterId: installation.cashRegisterId, deviceId: installation.deviceId,
      issuerNif: installation.issuerNif, invoiceId: crypto.randomUUID(), chainPosition: position, hash,
      generatedAt: '2026-11-11T10:00:00Z', canonicalSchema: 'aeat-registro-v1', canonicalRecord: {}, previous: null,
    },
    invoice_snapshot: {
      issuerName: installation.issuerName, issuerNif: installation.issuerNif, series: 'S', number: position,
      issuedAt: '2026-11-11T10:00:00Z', qrUrl: 'https://example.com/qr', ticketId, saleId, paymentId: null,
      lines: [], recipient: null, totalCents: 100, taxCents: 21,
    },
    economic_snapshot: null, rpc_result: null,
  }
}

let serverRows: ReturnType<typeof row>[]
let pages: URLSearchParams[]
const pageError = vi.fn()
const headRpcError = vi.fn()
const dispatchEvent = vi.fn()
const timeout = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  vi.stubGlobal('fetch', httpFetch)
  vi.stubGlobal('window', { dispatchEvent })
  serverRows = Array.from({ length: 123 }, (_, i) => row(i + 1))
  pages = []
  pageError.mockReset()
  headRpcError.mockReset()
  readHead.mockResolvedValue({ entry: null })
  readRecord.mockResolvedValue(null)
  reconcile.mockImplementation(async (_scope, _device, copies) => copies.length)
  httpFetch.mockImplementation(async (input: string) => {
    const url = new URL(input)
    const query = url.searchParams
    if (url.pathname.endsWith('/rpc/pos_fiscal_chain_head')) {
      const error = headRpcError()
      return error ? Response.json(error, { status: error.code === 'PGRST202' ? 404 : error.code === 'PGRST116' ? 406 : 403 })
        : Response.json(serverRows.length ? [serverRows.at(-1)] : [])
    }
    if (query.get('order') === 'chain_position.desc') {
      return Response.json(serverRows.at(-1) ?? null)
    }
    pages.push(query)
    const error = pageError(query)
    if (error) return Response.json(error, { status: error.code === '42501' ? 403 : 500 })
    const bounds = query.getAll('chain_position')
    const from = Number(bounds.find(bound => bound.startsWith('gte.'))?.slice(4))
    const to = Number(bounds.find(bound => bound.startsWith('lte.'))?.slice(4))
    return Response.json(serverRows.filter(record => record.chain_position >= from && record.chain_position <= to)
      .slice(0, Number(query.get('limit'))))
  })
})

it('downloads complete snapshots in small scoped batches without OFFSET', async () => {
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(123)
  expect(pages.map(page => page.getAll('chain_position'))).toEqual([
    ['gte.1', 'lte.100'], ['gte.101', 'lte.123'],
  ])
  for (const page of pages) {
    expect(page.get('limit')).toBe('100')
    expect(page.has('offset')).toBe(false)
    expect(page.get('tenant_id')).toBe(`eq.${installation.tenantId}`)
    expect(page.get('fiscal_subject_id')).toBe(`eq.${installation.fiscalSubjectId}`)
    expect(page.get('installation_id')).toBe(`eq.${installation.installationId}`)
    expect(page.get('order')).toBe('chain_position.asc')
  }
  expect(reconcile).toHaveBeenCalledOnce()
  const [scope, deviceId, copies] = reconcile.mock.calls[0]
  expect(scope).toEqual({ tenantId: installation.tenantId, fiscalSubjectId: installation.fiscalSubjectId,
    installationId: installation.installationId })
  expect(deviceId).toBe(installation.deviceId)
  expect(copies.map(copy => copy.entry.record.chainPosition)).toEqual(serverRows.map(record => record.chain_position))
  expect(copies[0].entry.record.hash).toBe(serverRows[0].hash)
  expect(copies[0].entry.invoice.totalCents).toBe(100)
  const [url, init] = httpFetch.mock.calls[0]
  expect(new URL(url).pathname).toBe('/rest/v1/rpc/pos_fiscal_chain_head')
  expect(JSON.parse(init.body)).toEqual({ p_tenant_id: installation.tenantId,
    p_fiscal_subject_id: installation.fiscalSubjectId, p_installation_id: installation.installationId })
})

it.each(['PGRST202', '42883'])('falls back to the scoped table read only when the new RPC is missing (%s)', async code => {
  headRpcError.mockReturnValue({ code, message: 'function missing', details: '', hint: '' })
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(123)
  const url = new URL(httpFetch.mock.calls[1][0])
  expect(url.pathname).toBe('/rest/v1/fiscal_local_records')
  expect(url.searchParams.get('tenant_id')).toBe(`eq.${installation.tenantId}`)
  expect(url.searchParams.get('fiscal_subject_id')).toBe(`eq.${installation.fiscalSubjectId}`)
  expect(url.searchParams.get('installation_id')).toBe(`eq.${installation.installationId}`)
  expect(url.searchParams.get('order')).toBe('chain_position.desc')
  expect(url.searchParams.get('limit')).toBe('1')
})

it.each(['42501', 'PGRST301', '57014'])('propagates head RPC errors without retrying through the table (%s)', async code => {
  headRpcError.mockReturnValue({ code, message: 'read denied or timed out', details: '', hint: '' })
  await expect(recoverServerConfirmedFiscalChain(installation)).rejects.toMatchObject({ code })
  expect(httpFetch).toHaveBeenCalledOnce()
  expect(reconcile).not.toHaveBeenCalled()
})

it('keeps an empty head empty without falling back to a second read', async () => {
  serverRows = []
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(0)
  expect(httpFetch).toHaveBeenCalledOnce()
  expect(reconcile).not.toHaveBeenCalled()
})

it('rejects ambiguous head responses without falling back to another read', async () => {
  headRpcError.mockReturnValue({ code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object',
    details: 'The result contains 2 rows', hint: null })
  await expect(recoverServerConfirmedFiscalChain(installation)).rejects.toMatchObject({ code: 'PGRST116' })
  expect(httpFetch).toHaveBeenCalledOnce()
  expect(reconcile).not.toHaveBeenCalled()
})

it('does not fall back to the table after a head transport failure', async () => {
  headRpcError.mockImplementation(() => { throw new TypeError('Network request failed') })
  await expect(recoverServerConfirmedFiscalChain(installation)).rejects.toMatchObject({ code: '' })
  expect(pages).toHaveLength(0)
  expect(reconcile).not.toHaveBeenCalled()
  expect(httpFetch.mock.calls.every(([url]) => new URL(url).pathname.endsWith('/rpc/pos_fiscal_chain_head'))).toBe(true)
})

it('shares the head read and reconciliation between concurrent recoveries', async () => {
  await expect(Promise.all([recoverServerConfirmedFiscalChain(installation), recoverServerConfirmedFiscalChain(installation)]))
    .resolves.toEqual([123, 123])
  expect(httpFetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/rpc/pos_fiscal_chain_head'))).toHaveLength(1)
  expect(reconcile).toHaveBeenCalledOnce()
})

it('reduces a timed-out batch and retries at the same position', async () => {
  serverRows = Array.from({ length: 273 }, (_, i) => row(i + 1))
  pageError.mockImplementation(query => query.get('limit') === '100'
    && query.getAll('chain_position').includes('gte.101') ? timeout : null)
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(273)
  expect(pages.map(page => [page.getAll('chain_position')[0], page.get('limit')])).toEqual([
    ['gte.1', '100'], ['gte.101', '100'], ['gte.101', '50'], ['gte.151', '50'], ['gte.201', '50'], ['gte.251', '50'],
  ])
  expect(dispatchEvent).not.toHaveBeenCalled()
})

it('stops at 25 instead of generating thousands of tiny requests and releases the in-flight recovery', async () => {
  pageError.mockReturnValue(timeout)
  await expect(recoverServerConfirmedFiscalChain(installation)).rejects.toMatchObject(timeout)
  expect(pages.map(page => page.get('limit'))).toEqual(['100', '50', '25'])
  expect(reconcile).not.toHaveBeenCalled()
  pageError.mockReturnValue(null)
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(123)
})

it('recovers 12,353 records with 124 queries, each bounded to at most 100 positions', async () => {
  serverRows = Array.from({ length: 12_353 }, (_, i) => row(i + 1))
  pageError.mockImplementation(query => {
    const [lower, upper] = query.getAll('chain_position')
    return Number(upper.slice(4)) - Number(lower.slice(4)) + 1 > 100 ? timeout : null
  })
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(12_353)
  expect(pages).toHaveLength(124)
  expect(pages.at(-1)?.getAll('chain_position')).toEqual(['gte.12301', 'lte.12353'])
  expect(dispatchEvent).not.toHaveBeenCalled()
})

it('propagates authorization failures without retrying or restoring a partial chain', async () => {
  const denied = { ...timeout, code: '42501', message: 'permission denied' }
  pageError.mockReturnValue(denied)
  await expect(recoverServerConfirmedFiscalChain(installation)).rejects.toMatchObject(denied)
  expect(pages).toHaveLength(1)
  expect(reconcile).not.toHaveBeenCalled()
})

it('includes the local anchor and stops at the prepared head despite new server records', async () => {
  const prepared = serverRows[100]
  readHead.mockResolvedValue({ entry: { record: { chainPosition: 100 } } })
  await expect(recoverServerConfirmedFiscalChain(installation, { record: prepared })).resolves.toBe(2)
  expect(pages[0].getAll('chain_position')).toEqual(['gte.100', 'lte.101'])
  expect(httpFetch).toHaveBeenCalledOnce()
  expect(reconcile.mock.calls[0][2].map(copy => copy.entry.id)).toEqual([serverRows[99].id, prepared.id])
})

it.each(['missing-middle', 'missing-tail', 'wrong-tenant', 'wrong-head'])(
  'does not reconcile an incomplete or conflicting chain: %s', async (failure) => {
    const prepared = structuredClone(serverRows.at(-1))
    if (failure === 'missing-middle') serverRows.splice(60, 1)
    if (failure === 'missing-tail') serverRows.pop()
    if (failure === 'wrong-tenant') serverRows[60].tenant_id = crypto.randomUUID()
    if (failure === 'wrong-head' && prepared) prepared.hash = 'A'.repeat(64)
    await expect(recoverServerConfirmedFiscalChain(installation, { record: prepared })).rejects.toThrow()
    expect(reconcile).not.toHaveBeenCalled()
  },
)

it('skips downloading when the local head already matches the server', async () => {
  const head = serverRows.at(-1)
  readHead.mockResolvedValue({ entry: { id: head?.id,
    record: { chainPosition: head?.chain_position, hash: head?.hash } } })
  await expect(recoverServerConfirmedFiscalChain(installation)).resolves.toBe(0)
  expect(pages).toHaveLength(0)
  expect(reconcile).not.toHaveBeenCalled()
})
