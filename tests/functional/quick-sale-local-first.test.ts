import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { readFileSync } from 'node:fs'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'
import type { CashSession, TenantContext, TicketLine } from '../../src/types'
import * as durable from '../../src/lib/durableSales.ts'
import * as invoices from '../../src/features/fiscal/local/posInvoice.ts'
import { fiscalIdentityKey, loadFiscalInstallation } from '../../src/features/fiscal/local/installation.ts'
import { persistFiscalIdentity, fiscalActivationRequest, refreshFiscalIdentitySnapshot } from '../../src/features/fiscal/local/localIdentity.ts'
import { rememberFiscalPosSettings } from '../../src/features/fiscal/local/settings.ts'
import { listLocalFiscalEntries, listPendingFiscalEconomicSales } from '../../src/features/fiscal/local/localLedger.ts'
import { buildSalePayload } from '../../src/features/quick-sale/services/salePayload.ts'
import { openLedger, transactionDone } from '../../src/lib/localDatabase.ts'
import { resolveLocalFiscalMode } from '../../src/features/fiscal/local/tenantMode.ts'
import * as permissions from '../../src/features/personal/permissions.ts'
import * as customPayments from '../../src/lib/customPayments.ts'

const { remoteRead, sync } = vi.hoisted(() => ({ remoteRead: vi.fn(), sync: vi.fn() }))
vi.mock('../../src/lib/supabase.ts', () => ({ supabase: { from: remoteRead, rpc: remoteRead, auth: { getSession: remoteRead } } }))
vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError: vi.fn(), operationBreadcrumb: vi.fn() }))

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context: TenantContext = { tenantId: uuid(1), venueId: uuid(2), deviceId: uuid(3), userId: uuid(4),
  tenantName: 'Test', tenantSlug: 'test', venueName: 'Local', deviceName: 'iPad', userName: 'Caja', role: 'cashier', venueDefaultTaxRate: 21 }
const session: CashSession = { id: uuid(5), cashRegisterId: uuid(6), cashRegisterName: 'Caja',
  tenantId: context.tenantId, venueId: context.venueId, deviceId: context.deviceId, userId: context.userId,
  openedAt: new Date().toISOString(), openingFloatCents: 0, status: 'open' }
const scope = { tenantId: context.tenantId, fiscalSubjectId: uuid(7), installationId: uuid(8) }
const snapshot = { installation: { id: scope.installationId, tenant_id: context.tenantId, fiscal_subject_id: scope.fiscalSubjectId,
  venue_id: context.venueId, cash_register_id: session.cashRegisterId, device_id: context.deviceId,
  installation_number: 'TEST-1', venue_code: 'L1', register_code: 'C1', installation_code: 'I1',
  installation_sequence: 1, series_version: 2, bridge_requested: true, mode: 'production', retired_at: null },
  subject: { id: scope.fiscalSubjectId, tenant_id: context.tenantId, legal_name: 'Emisor ficticio', nif: '89890001K' } }
const lines: TicketLine[] = [{ id: uuid(9), productId: uuid(10), variantId: uuid(11), productName: 'Servicio ficticio', variantName: '',
  basePriceCents: 1210, componentDeltaCents: 0, modifierDeltaCents: 0, unitPriceCents: 1210, quantity: 1,
  modifiers: [], components: [], catalogSnapshot: { vatRate: 21 } }]
const integrationKey = `tickit:verifactu-integration:v1:${context.tenantId}`
const settingsKey = `tickit:fiscal-pos-settings:v1:${context.tenantId}`

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const storage = new Map<string, string>()
  const window = Object.assign(new EventTarget(), { crypto, location: { pathname: '/pos' }, localStorage: {
    get length() { return storage.size }, key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  vi.stubGlobal('window', window)
  const locks = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: (key: string, _options: unknown, work: () => Promise<unknown>) => {
    const pending = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    locks.set(key, pending)
    return pending
  } } })
  // Neither the backend nor the background synchronizer ever acknowledges a request.
  remoteRead.mockImplementation(() => new Promise(() => {}))
  sync.mockImplementation(() => new Promise(() => {}))
  rememberFiscalPosSettings({ tenant_id: context.tenantId, bridge_url: 'https://bridge.example', aeat_environment: 'test',
    print_ticket_qr: true, producer_name: 'Productor ficticio', producer_nif: '89890001K', system_id: 'TK', system_version: '1' }, context.tenantId)
  window.localStorage.setItem(integrationKey, JSON.stringify({ tenant_id: context.tenantId,
    requested_at: '2026-11-01', enabled_at: '2026-11-01', aeat_environment: 'test', print_ticket_qr: true }))
  await persistFiscalIdentity(fiscalIdentityKey(context, session), snapshot,
    `${scope.tenantId}:${scope.fiscalSubjectId}:${scope.installationId}`, context.deviceId)
  await durable.loadDurableEvents()
})
afterEach(() => { vi.unstubAllGlobals() })

async function issue() {
  const payload = buildSalePayload(context, session, lines, 'card', null, null)
  const prepared = await invoices.preflightPosInvoice(context, session, payload, 40000, { localOnly: true })
  return { payload, prepared, entry: await invoices.issuePosInvoice(context, session, payload, false, undefined, undefined, prepared) }
}

it('commits and releases a card checkout while online backend and background sync do not respond', async () => {
  const errors: string[] = [], busy: boolean[] = []
  const reset = vi.fn(), print = vi.fn(async () => {})
  const runner = createCompiledHookRunner(readFileSync(new URL('../../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8'), 'useQuickSalePayment', {
    '../../../lib/durableSales.ts': durable,
    '../../../lib/observability.ts': { reportOperationError: vi.fn(), operationBreadcrumb: vi.fn() },
    '../../../utils/errors.ts': { getReadableError: (error: Error) => error.message },
    '../../../services/posService': {}, '../services/salePayload': { buildSalePayload },
    '../../personal/permissions': permissions, '../../../lib/customPayments': customPayments,
    '../../customers/service': {},
    '../../local-printing/cashlogy/useCashlogyStore': { finishCashlogyPayment() {}, getCashlogyPaymentAmounts: () => ({}), getCashlogyPaymentSaleId: () => null },
    '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
    '../../fiscal/local/mode.ts': {}, '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode },
    '../../fiscal/local/posInvoice.ts': invoices,
    '../../fiscal/local/economicSync.ts': { synchronizeFiscalEconomicSales: sync },
    '../../fiscal/local/sync.ts': {}, '../../fiscal/local/installation.ts': {},
  }, { window, crypto, performance })
  const payment = runner.render({ context, cashSession: session, lines, discount: null, invoiceCustomer: null, ledger: [], tickets: [], isOnline: true,
    persistLedger() {}, persistTickets() {}, persistLines() {}, mergeProductStats() {}, resetUi: reset,
    refreshPendingCount() {}, syncPendingEvents: sync, printSale: print,
    onError: (error: string) => errors.push(error), onPaymentInFlightChange: (value: boolean) => busy.push(value) })
  await payment('card', null)
  expect(errors).toEqual([])
  expect(busy).toEqual([true, false])
  expect(reset).toHaveBeenCalledTimes(1)
  expect(print).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(remoteRead).not.toHaveBeenCalled()
  expect(await durable.loadDurableSessionTickets(context, session.id)).toHaveLength(1)
  expect(await listPendingFiscalEconomicSales(scope)).toHaveLength(1)
  runner.unmount()
}, 3000)

it('preserves consecutive numbers and immutable identities across concurrent local issues and retries', async () => {
  const [first, second] = await Promise.all([issue(), issue()])
  expect([first.entry.invoice.number, second.entry.invoice.number].sort()).toEqual([1, 2])
  expect(await invoices.issuePosInvoice(context, session, first.payload, false, undefined, undefined, first.prepared)).toMatchObject({ id: first.entry.id })
  expect(await listLocalFiscalEntries(scope)).toHaveLength(2)
  expect(await listPendingFiscalEconomicSales(scope)).toHaveLength(2)
  expect(remoteRead).not.toHaveBeenCalled()
})

it('revalidates expired preparation locally without falling back to online reads', async () => {
  const { payload, prepared, entry } = await issue()
  const expired = { ...prepared, preparedAt: Date.now() - 61000, preparedMonotonicAt: performance.now() - 61000 }
  expect(await invoices.issuePosInvoice(context, session, payload, false, undefined, undefined, expired)).toMatchObject({ id: entry.id })
  expect(remoteRead).not.toHaveBeenCalled()
})

it('uses fiscal metadata refreshed in the background on the next local checkout', async () => {
  const integration = JSON.parse(window.localStorage.getItem(integrationKey) ?? 'null')
  remoteRead.mockImplementation((resource: string) => {
    if (resource === 'pos_fiscal_preparation') return { abortSignal: async () => ({ error: null, data: {
      ...snapshot, subject: { ...snapshot.subject, legal_name: 'Emisor actualizado' }, head: null,
      settings: JSON.parse(window.localStorage.getItem(settingsKey) ?? 'null'),
    } }) }
    const query = { select: () => query, eq: () => query, abortSignal: () => query,
      maybeSingle: async () => ({ error: null, data: integration }) }
    return query
  })
  await loadFiscalInstallation(context, session, true)
  remoteRead.mockClear()
  remoteRead.mockImplementation(() => new Promise(() => {}))
  expect((await issue()).entry.invoice.issuerName).toBe('Emisor actualizado')
  expect(remoteRead).not.toHaveBeenCalled()
})

it('cannot refresh a replacement identity or erase a pending activation from a stale background response', async () => {
  const key = fiscalIdentityKey(context, session)
  await expect(refreshFiscalIdentitySnapshot(key, uuid(99), snapshot)).rejects.toThrow()
  await fiscalActivationRequest(key, scope.installationId, false)
  await expect(refreshFiscalIdentitySnapshot(key, scope.installationId, snapshot)).rejects.toThrow()
  await expect(issue()).rejects.toThrow()
})

it.each(['foreign_identity', 'missing_settings', 'missing_integration', 'foreign_integration', 'activation_pending', 'revoked', 'corrupt_head'])(
  'blocks local checkout for %s without attempting a network fallback', async failure => {
    if (failure === 'foreign_identity') await persistFiscalIdentity(fiscalIdentityKey(context, session),
      { ...snapshot, installation: { ...snapshot.installation, device_id: uuid(99) } },
      `${scope.tenantId}:${scope.fiscalSubjectId}:${scope.installationId}`, context.deviceId)
    if (failure === 'missing_settings') window.localStorage.removeItem(settingsKey)
    if (failure === 'missing_integration') window.localStorage.removeItem(integrationKey)
    if (failure === 'foreign_integration') window.localStorage.setItem(integrationKey, JSON.stringify({ tenant_id: uuid(99),
      requested_at: null, enabled_at: null, aeat_environment: 'test', print_ticket_qr: true }))
    if (failure === 'activation_pending') await fiscalActivationRequest(fiscalIdentityKey(context, session), scope.installationId, false)
    if (failure === 'revoked' || failure === 'corrupt_head') {
      const entry = failure === 'corrupt_head' ? (await issue()).entry : null
      const db = await openLedger()
      const tx = db.transaction(entry ? 'numbers' : 'bindings', 'readwrite'), done = transactionDone(tx)
      if (entry) tx.objectStore('numbers').put({ key: `${entry.scope}:${entry.invoice.series}`, lastNumber: 99 })
      else tx.objectStore('bindings').put({ scope: `pwa-revoked:${scope.installationId}`, installationId: scope.installationId,
        revokedAt: new Date().toISOString(), reason: 'Test' })
      await done
      db.close()
    }
    await expect(issue()).rejects.toThrow()
    expect(remoteRead).not.toHaveBeenCalled()
    expect(await listPendingFiscalEconomicSales(scope)).toHaveLength(failure === 'corrupt_head' ? 1 : 0)
  })
