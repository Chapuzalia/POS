import { readFileSync } from 'node:fs'
import * as personalPermissions from '../../src/features/personal/permissions'
import { expect, it } from 'vitest'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'
import type { OfflineEvent, SaleRecord } from '../../src/types/index.ts'
import * as reconciliation from '../../src/features/cash-registers/services/cashLedgerReconciliation.ts'

const source = readFileSync(new URL('../../src/features/cash-registers/hooks/useCashSession.ts', import.meta.url), 'utf8')
const sale = (id: string, paymentMethod: SaleRecord['paymentMethod'] = 'card'): SaleRecord => ({
  id, paymentMethod, cashSessionId: 'session', totalCents: 600, createdAt: '2026-10-25T10:00:00Z',
})

function cashSession(queue: OfflineEvent[] = [], journalPending = false) {
  let resolve!: (sales: SaleRecord[]) => void
  const remote = new Promise<SaleRecord[]>(done => { resolve = done })
  const cachedLedgers: unknown[] = []
  const modules = {
    '../../personal/permissions': personalPermissions,
    '../../../lib/observability.ts': {}, '../../../utils/UserFacingError.ts': { UserFacingError: Error },
    '../../tables/service': { loadOpenRestaurantOrders: async () => [] },
    sileo: { sileo: { warning() {} } },
    '../../../lib/offlineStore': { getOfflineQueue: () => queue, saveSaleLedger: (_context: unknown, ledger: unknown) => cachedLedgers.push(ledger), saveSessionTickets() {} },
    '../../../services/posService': { loadSalesLedgerFromSupabase: () => remote,
      loadSessionTicketFromSupabase: async () => null, summarizeSales: () => ({}) },
    '../../../utils/errors': { getReadableError: (error: Error) => error.message }, '../../fiscal/local/tenantMode.ts': {}, '../../fiscal/local/installation.ts': {},
    '../../../lib/durableSales.ts': { loadPendingPaymentOperations: async () => journalPending ? [{ state: 'accepted' }] : [] },
    '../../fiscal/local/localLedger.ts': {}, '../../fiscal/local/posInvoice.ts': {},
    '../../local-printing/hooks/usePrintAgentScope': { usePrintAgentScope() {} },
    '../../local-printing/cashlogy/useCashlogyScope': { useCashlogyScope() {} },
    '../../local-printing/cashlogy/cashlogyCashBalance': { loadActiveCashlogyCashBalance: async () => null }, '../../local-printing/services/cashClosingPrintMapper': {},
    '../services/cashClosingPrintRecovery': {}, '../../local-printing/services/printCashClosing': {},
    '../../local-printing/store/usePrintAgentStore': {},
    '../../local-printing/services/printTicket': { mergeRemoteTicketPrintStates: (_local: unknown, tickets: unknown) => tickets },
    '../services/cashSessionLifecycle': {}, './useActiveCashSession': { useActiveCashSession() {} },
    './useCashRegisterOptions': { useCashRegisterOptions: () => ({}) },
    './useCashTicketActions': { useCashTicketActions: () => ({}) },
    '../services/cashState': {}, '../services/localSessionTickets.ts': { loadPendingLocalSaleIds: async () => [] },
    '../services/cashLedgerReconciliation.ts': reconciliation,
    '../service': { loadCashMovements: async () => [], subscribeToCashMovements: () => () => {}, loadCashlogyStackerCollectionsTotal: async () => 0 },
  }
  const runner = createCompiledHookRunner(source, 'useCashSession', modules)
  const options = { context: { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user' },
    isOnline: true, onError() {}, setBusy() {}, refreshPendingCount() {}, syncPendingEvents: async () => {}, subtractProductSalesStats() {} }
  const render = () => runner.render(options)
  render().hydrate({ id: 'session' }, [], [])
  return { render, resolve, runner, cachedLedgers }
}

it('keeps a new sale committed while the restaurant ledger read is in flight', async () => {
  const harness = cashSession()
  harness.render().persistLedger([sale('existing')])
  const pending = harness.render().refreshConfirmedSale('ticket', 'missing', false)
  harness.render().persistLedger([sale('existing'), sale('new', 'cash')])
  harness.resolve([sale('existing')])
  await pending
  expect(harness.render().ledger.map((record: SaleRecord) => record.id)).toEqual(['existing', 'new'])
  harness.runner.unmount()
})

it('preserves an unsynced sale that already existed when a remote refresh began', async () => {
  const event = { kind: 'sale_created', tenantId: 'tenant', payload: { sale: { id: 'pending' } } } as OfflineEvent
  const harness = cashSession([event])
  harness.render().persistLedger([sale('pending', 'cash')])
  const pending = harness.render().refreshLedger()
  harness.resolve([])
  await pending
  expect(harness.render().ledger.map((record: SaleRecord) => record.id)).toEqual(['pending'])
  harness.runner.unmount()
})

it('accepts remote annulments and payment changes while retaining edits made after the read began', async () => {
  const harness = cashSession()
  harness.render().persistLedger([sale('annulled-remotely'), sale('remote-method'), sale('local-method'), sale('voided-locally')])
  const pending = harness.render().refreshConfirmedSale('ticket', 'missing', false)
  harness.render().persistLedger([sale('annulled-remotely'), sale('remote-method'), sale('local-method', 'cash')])
  harness.resolve([sale('remote-method', 'cash'), sale('local-method'), sale('voided-locally')])
  await pending
  expect(harness.render().ledger).toEqual([sale('remote-method', 'cash'), sale('local-method', 'cash')])
  harness.runner.unmount()
})

it('does not open closing while an accepted payment still needs its durable final commit', async () => {
  const harness = cashSession([], true)
  harness.resolve([])
  expect(await harness.render().openCloseModal()).toBe(false)
  expect(harness.render().closeModalOpen).toBe(false)
  harness.runner.unmount()
})

it('persists the resolved ledger when same-render payment projections use a functional update', () => {
  const harness = cashSession()
  const cash = harness.render()
  cash.persistLedger([sale('new-sale')])
  cash.persistLedger((current: SaleRecord[]) => [...current, sale('changed-payment', 'cash')])
  expect(harness.cachedLedgers.at(-1)).toEqual([sale('new-sale'), sale('changed-payment', 'cash')])
  expect(harness.render().ledger).toEqual([sale('new-sale'), sale('changed-payment', 'cash')])
  harness.runner.unmount()
})
