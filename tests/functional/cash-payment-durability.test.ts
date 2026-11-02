import { readFileSync } from 'node:fs'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createCompiledHookRunner, compileComponent } from '../helpers/component-harness.mjs'
import * as durable from '../../src/lib/durableSales.ts'
import * as offline from '../../src/lib/offlineStore.ts'

vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError() {}, operationBreadcrumb() {} }))

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user', role: 'owner' }
const session = { id: 'cash', cashRegisterId: 'register' }
const originalTicket = () => ({
  id: 'sale', cashSessionId: 'cash', paymentMethod: 'card', totalCents: 600, createdAt: '2026-10-25T10:00:00Z', status: 'active',
  printStatus: 'printed', printAttempts: 1,
  payload: {
    ticket: { id: 'ticket', tenantId: 'tenant', venueId: 'venue', cashSessionId: 'cash', cashRegisterId: 'register', deviceId: 'device', totalCents: 600, createdAt: '2026-10-25T10:00:00Z' },
    sale: { id: 'sale', ticketId: 'ticket', tenantId: 'tenant', cashSessionId: 'cash', paymentMethod: 'card', totalCents: 600, createdAt: '2026-10-25T10:00:00Z' },
    payment: { id: 'payment', tenantId: 'tenant', saleId: 'sale', method: 'card', amountCents: 600, receivedCents: null, changeCents: 0 },
    lines: [],
  },
})

function actions({ cacheFails = false, hardware = false, loadRemote = async () => ({ currentPage: 1, tickets: [], totalResults: 0 }) } = {}) {
  const errors: string[] = []
  let failCache = cacheFails
  const collect = vi.fn(async () => hardware ? { id: 'hardware', requestId: 'cashlogy:change:sale', saleId: 'sale', status: 'completed', requestedAmountCents: 600 } : null)
  const finish = vi.fn()
  const history = compileComponent(source('features/cash-registers/services/sessionTicketHistoryModel.ts'), {})
  const local = compileComponent(source('features/cash-registers/services/localSessionTickets.ts'), {
    '../../../lib/offlineStore': offline,
    '../../../lib/durableSales.ts': durable,
    '../../fiscal/local/localLedger.ts': { listLocalFiscalScopes: async () => [] },
    '../../fiscal/local/posInvoice.ts': {},
  })
  const payment = compileComponent(source('features/cash-registers/services/paymentChange.ts'), {
    '../../../lib/durableSales.ts': durable,
    '../../local-printing/cashlogy/useCashlogyStore': { settleCashlogyPaymentIfConfigured: collect,
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }) },
  })
  const options = {
    context, cashSession: session, isOnline: false, tickets: [originalTicket()], ledger: [{ ...originalTicket().payload.sale }],
    persistTickets(value: ReturnType<typeof originalTicket>[] | ((tickets: ReturnType<typeof originalTicket>[]) => ReturnType<typeof originalTicket>[])) {
      const tickets = typeof value === 'function' ? value(options.tickets) : value
      if (failCache) throw new DOMException('Quota', 'QuotaExceededError'); options.tickets = tickets
    },
    persistLedger(value: typeof options.ledger | ((ledger: typeof options.ledger) => typeof options.ledger)) {
      const ledger = typeof value === 'function' ? value(options.ledger) : value
      if (failCache) throw new DOMException('Quota', 'QuotaExceededError'); options.ledger = ledger
    },
    mergeRemotePrintStates: (tickets: unknown) => tickets,
    syncPendingEvents: async () => {}, refreshPendingCount() {}, setBusy() {}, setHistoryOpen() {}, subtractProductSalesStats() {},
    setError: (message: string | null) => { if (message) errors.push(message) },
  }
  const runner = createCompiledHookRunner(source('features/cash-registers/hooks/useCashTicketActions.ts'), 'useCashTicketActions', {
    '../../../lib/format': { createId: () => crypto.randomUUID() },
    '../../../lib/offlineStore': offline,
    '../../../lib/durableSales.ts': durable,
    '../../../lib/observability.ts': { isTransportError: () => false, reportOperationError() {} },
    '../../../services/posService': { loadSessionTicketPageFromSupabase: loadRemote }, '../../../utils/dates': { nowIso: () => '2026-10-25T10:01:00Z' },
    '../../../utils/errors': { getReadableError: (error: Error) => error.message },
    '../../fiscal/local/annulment.ts': {}, '../../fiscal/local/refund.ts': {},
    '../../local-printing/services/printAgentStorage': {}, '../../local-printing/store/usePrintAgentStore': {},
    '../../local-printing/cashlogy/useCashlogyStore': {
      settleCashlogyPaymentIfConfigured: collect, finishCashlogyPayment: finish,
      getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    },
    '../services/sessionTicketHistoryModel.ts': history,
    '../services/localSessionTickets.ts': local,
    '../services/paymentChange.ts': payment,
  }, { window: globalThis.window, structuredClone, crypto, navigator: globalThis.navigator })
  return { options, errors, collect, finish, local, render: () => runner.render(options), recoverCache: () => { failCache = false }, runner }
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { location: { pathname: '/pos' }, localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  } })
  vi.stubGlobal('navigator', { locks: { request: (_key: string, _options: unknown, work: () => unknown) => work() } })
  await durable.loadDurableEvents()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('retains the changed payment and its pending event together when both local caches reject writes', async () => {
  const harness = actions({ cacheFails: true })
  await harness.render().changePayment(harness.options.tickets[0], 'cash')
  expect(await durable.loadDurableEvents()).toMatchObject([{ kind: 'sale_payment_changed', payload: { paymentMethod: 'cash', paymentId: 'payment' } }])
  const page = await harness.render().loadHistoryPage(1, '')
  expect(page.tickets[0].ticket).toMatchObject({ paymentMethod: 'cash', payload: { payment: { method: 'cash' } } })
  expect(harness.errors.join(' ')).toContain('guardado')
})

it('does not change either projection when the durable transaction aborts', async () => {
  const harness = actions()
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
    if (this.name === 'durableEvents') this.transaction.abort()
    return put.apply(this, args)
  })
  await harness.render().changePayment(harness.options.tickets[0], 'cash')
  expect(harness.options.tickets[0].paymentMethod).toBe('card')
  expect(harness.options.ledger[0].paymentMethod).toBe('card')
  expect(await durable.loadDurableEvents()).toEqual([])
})

it('recovers an accepted hardware payment after an aborted final commit without collecting twice', async () => {
  const harness = actions({ hardware: true })
  const put = IDBObjectStore.prototype.put
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
    if (this.name === 'durableEvents') this.transaction.abort()
    return put.apply(this, args)
  })
  await harness.render().changePayment(harness.options.tickets[0], 'cash')
  expect(harness.finish).not.toHaveBeenCalled()
  failure.mockRestore()
  await harness.render().changePayment(harness.options.tickets[0], 'cash')
  expect(harness.collect).toHaveBeenCalledTimes(1)
  expect(await durable.loadDurableEvents()).toHaveLength(1)
  expect(harness.options.ledger[0].paymentMethod).toBe('cash')
})

it('repairs both projections on reload even when the server already acknowledged the change', async () => {
  const first = actions({ cacheFails: true })
  await first.render().changePayment(first.options.tickets[0], 'cash')
  const [event] = await durable.loadDurableEvents()
  await durable.updateDurableEvent(event.id)
  expect(await first.local.loadPendingLocalSaleIds(context, session)).toEqual(['sale'])
  first.runner.unmount()
  const reloaded = actions()
  reloaded.render()
  await vi.waitFor(() => expect(reloaded.options.ledger[0].paymentMethod).toBe('cash'))
  expect(reloaded.options.tickets[0]).toMatchObject({ paymentMethod: 'cash', printStatus: 'printed', printAttempts: 1 })
  expect(reloaded.collect).not.toHaveBeenCalled()
  expect(await durable.loadDurableEvents()).toEqual([])
  expect((await durable.loadPaymentOperations(context, 'cash'))[0].result?.paymentProjectionPending).toBe(false)
  expect(await reloaded.local.loadPendingLocalSaleIds(context, session)).toEqual([])
  reloaded.runner.unmount()
})

it('recovers the original accepted charge automatically after reload', async () => {
  const first = actions({ hardware: true })
  const put = IDBObjectStore.prototype.put
  const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
    if (this.name === 'durableEvents') this.transaction.abort()
    return put.apply(this, args)
  })
  await first.render().changePayment(first.options.tickets[0], 'cash')
  first.runner.unmount()
  failure.mockRestore()
  const reloaded = actions({ hardware: true })
  reloaded.render()
  await vi.waitFor(() => expect(reloaded.options.tickets[0].paymentMethod).toBe('cash'))
  expect(first.collect).toHaveBeenCalledTimes(1)
  expect(reloaded.collect).not.toHaveBeenCalled()
  expect(reloaded.finish).toHaveBeenCalledTimes(1)
  expect(await durable.loadDurableEvents()).toHaveLength(1)
  reloaded.runner.unmount()
})

it('keeps a delayed payment mutation in its original application route', async () => {
  const ticket = originalTicket()
  const operation = await durable.preparePaymentChangeOperation(context, ticket, 'cash')
  const accepted = await durable.acceptPaymentOperation(operation, operation.payload, null)
  window.location.pathname = '/crm'
  await durable.commitPaymentChangeOperation(accepted)
  expect(await durable.loadDurableEvents()).toEqual([])
  window.location.pathname = '/pos'
  expect(await durable.loadDurableEvents()).toHaveLength(1)
})

it('rejects a payment mutation from another tenant before preparing or collecting', async () => {
  const harness = actions({ hardware: true })
  const foreign = { ...harness.options.tickets[0], payload: { ...harness.options.tickets[0].payload,
    ticket: { ...harness.options.tickets[0].payload.ticket, tenantId: 'foreign' } } }
  await harness.render().changePayment(foreign, 'cash')
  expect(harness.collect).not.toHaveBeenCalled()
  expect(await durable.loadDurableEvents()).toEqual([])
  expect(await durable.loadPaymentOperations(context, 'cash')).toEqual([])
})

it('updates the matching payment in a legacy payments list as well as the singular payment', async () => {
  const harness = actions({ cacheFails: true })
  const ticket = originalTicket()
  const legacy = { ...ticket, payload: { ...ticket.payload, payments: [ticket.payload.payment] } }
  harness.options.tickets = [legacy]
  await harness.render().changePayment(legacy, 'cash')
  const page = await harness.render().loadHistoryPage(1, '')
  expect(page.tickets[0].ticket.payload.payments).toMatchObject([{ id: 'payment', method: 'cash', amountCents: 600 }])
  harness.recoverCache()
  await harness.render().changePayment(legacy, 'cash')
  expect(harness.options.ledger[0].payments).toMatchObject([{ method: 'cash', amountCents: 600 }])
})

it('creates a new mutation when fresh remote history confirms the original payment method was restored elsewhere', async () => {
  const remote = { currentPage: 1, tickets: [{ number: 1, ticket: originalTicket() }], totalResults: 1 }
  const harness = actions({ hardware: true, loadRemote: async () => remote })
  await harness.render().changePayment(harness.options.tickets[0], 'cash')
  const [event] = await durable.loadDurableEvents()
  await durable.updateDurableEvent(event.id)
  harness.options.isOnline = true
  const page = await harness.render().loadHistoryPage(1, '')
  await harness.render().changePayment(page.tickets[0].ticket, 'cash')
  const pending = await durable.loadDurableEvents()
  expect(harness.collect).toHaveBeenCalledTimes(2)
  expect(pending).toHaveLength(1)
  expect(pending[0].id).not.toBe(event.id)
})

it('does not treat a history read started before the payment as evidence to collect again', async () => {
  let resolve!: (page: unknown) => void
  let requested = false
  const harness = actions({ hardware: true, loadRemote: () => { requested = true; return new Promise(done => { resolve = done }) } })
  harness.options.isOnline = true
  const history = harness.render().loadHistoryPage(1, '')
  await vi.waitFor(() => expect(requested).toBe(true))
  const original = harness.options.tickets[0]
  await harness.render().changePayment(original, 'cash')
  const [event] = await durable.loadDurableEvents()
  await durable.updateDurableEvent(event.id)
  resolve({ currentPage: 1, tickets: [{ number: 1, ticket: originalTicket() }], totalResults: 1 })
  await history
  await harness.render().changePayment(original, 'cash')
  expect(harness.collect).toHaveBeenCalledTimes(1)
  expect(await durable.loadDurableEvents()).toEqual([])
})
