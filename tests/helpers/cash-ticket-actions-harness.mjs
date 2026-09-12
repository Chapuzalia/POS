import { readFile } from 'node:fs/promises'

import { createCompiledHookRunner } from './component-harness.mjs'

const source = await readFile(new URL('../../src/features/cash-registers/hooks/useCashTicketActions.ts', import.meta.url), 'utf8')

export function createCashTicketActionsHarness({
  isOnline = true,
  offlineQueue = [],
  settleCashlogyPaymentIfConfigured = async () => null,
  syncPendingEvents = async () => undefined,
  voidTicketWithFiscalCancellation = async () => undefined,
} = {}) {
  const calls = { busy: [], enqueued: [], errors: [], finished: [], forgotten: [], ledgers: [], stats: 0, sync: 0, tickets: [] }
  const ticket = {
    cashSessionId: 'cash', createdAt: '2026-09-12T00:00:00Z', id: 'sale-1', paymentMethod: 'card', printAttempts: 0,
    printStatus: 'not_requested', status: 'active', totalCents: 600,
    payload: {
      lines: [{ lineTotalCents: 600, productId: 'product-1', quantity: 1 }],
      payment: { changeCents: 0, id: 'payment-1', method: 'card', receivedCents: null },
      sale: { id: 'sale-1', paymentMethod: 'card' },
      ticket: { id: 'ticket-1' },
    },
  }
  const runner = createCompiledHookRunner(source, 'useCashTicketActions', {
    '../../../lib/format': { createId: () => 'event-1' },
    '../../../lib/offlineStore': {
      enqueueOfflineEvent: (event) => calls.enqueued.push(event),
      forgetOfflineEvent: (id) => calls.forgotten.push(id),
      getOfflineQueue: () => offlineQueue,
    },
    '../../../services/posService': {
      loadSessionTicketPageFromSupabase: async () => ({ currentPage: 1, tickets: [], totalResults: 0 }),
    },
    '../../../utils/dates': { nowIso: () => '2026-09-12T00:00:00Z' },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../../fiscal/service': { voidTicketWithFiscalCancellation },
    '../../local-printing': { nextPrintCopyNumber: () => 1, usePrintAgentStore: { getState: () => ({}) } },
    '../../local-printing/cashlogy/useCashlogyStore': {
      finishCashlogyPayment: (transaction) => calls.finished.push(transaction),
      getCashlogyPaymentAmounts: (transaction, totalCents) => ({ changeCents: transaction?.changeCents ?? 0, receivedCents: transaction?.receivedCents ?? totalCents }),
      settleCashlogyPaymentIfConfigured,
    },
  }, { window: { confirm: () => true } })
  const options = {
    cashSession: { id: 'cash' },
    context: { role: 'owner', tenantId: 'tenant' },
    isOnline,
    ledger: [{ id: 'sale-1', paymentMethod: 'card' }],
    mergeRemotePrintStates: (tickets) => tickets,
    persistLedger: (ledger) => calls.ledgers.push(ledger),
    persistTickets: (tickets) => calls.tickets.push(tickets),
    printTicket: async () => {},
    refreshPendingCount() {},
    setBusy: (busy) => calls.busy.push(busy),
    setError: (error) => calls.errors.push(error),
    setHistoryOpen() {},
    subtractProductSalesStats: () => { calls.stats += 1 },
    syncPendingEvents: async () => { calls.sync += 1; await syncPendingEvents() },
    tickets: [ticket],
  }
  return { calls, options, render: () => runner.render(options), ticket }
}
