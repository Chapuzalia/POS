import { readFile } from 'node:fs/promises'

import { compileComponent, createCompiledHookRunner } from './component-harness.mjs'

const source = await readFile(new URL('../../src/features/cash-registers/hooks/useCashTicketActions.ts', import.meta.url), 'utf8')
const historyModel = compileComponent(await readFile(new URL('../../src/features/cash-registers/services/sessionTicketHistoryModel.ts', import.meta.url), 'utf8'), {})

export function createCashTicketActionsHarness({
  isOnline = true,
  offlineQueue = [],
  settleCashlogyPaymentIfConfigured = async () => null,
  syncPendingEvents = async () => undefined,
  prepareLocalFiscalAnnulment = async () => undefined,
  issuePosRefund = async () => undefined,
  loadLocalSessionTickets = async (_, __, tickets) => tickets,
  loadSessionTicketPageFromSupabase = async () => ({ currentPage: 1, tickets: [], totalResults: 0 }),
} = {}) {
  let cachedTickets = []
  const calls = { busy: [], enqueued: [], errors: [], finished: [], forgotten: [], historyOpen: [], ledgers: [], stats: 0, sync: 0, tickets: [], remoteHistory: 0, savedHistory: [] }
  const ticket = {
    cashSessionId: 'cash', createdAt: '2026-09-12T00:00:00Z', id: 'sale-1', paymentMethod: 'card', printAttempts: 0,
    printStatus: 'not_requested', status: 'active', totalCents: 600,
    payload: {
      lines: [{ lineTotalCents: 600, productId: 'product-1', productName: 'Producto', variantName: 'Normal', quantity: 1 }],
      payment: { changeCents: 0, id: 'payment-1', method: 'card', receivedCents: null },
      sale: { id: 'sale-1', paymentMethod: 'card' },
      ticket: { id: 'ticket-1', tenantId: 'tenant', venueId: 'venue', cashSessionId: 'cash', cashRegisterId: 'register', deviceId: 'device' },
    },
  }
  const runner = createCompiledHookRunner(source, 'useCashTicketActions', {
    '../../../lib/format': { createId: () => 'event-1' },
    '../../../lib/offlineStore': {
      enqueueOfflineEvent: (event) => calls.enqueued.push(event),
      forgetOfflineEvent: (id) => calls.forgotten.push(id),
      getOfflineQueue: () => offlineQueue,
      getSessionTickets: () => cachedTickets,
      saveSessionTickets: (_, __, tickets) => { cachedTickets = tickets; calls.savedHistory.push(tickets) },
    },
    '../../../lib/observability.ts': { isTransportError: error => /fetch|network/i.test(error.message) || error.name === 'AbortError' },
    '../../../services/posService': {
      loadSessionTicketPageFromSupabase: async (...args) => { calls.remoteHistory++; return loadSessionTicketPageFromSupabase(...args) },
    },
    '../services/sessionTicketHistoryModel.ts': historyModel,
    '../services/localSessionTickets.ts': { loadLocalSessionTickets: (ctx, session, tickets) => loadLocalSessionTickets(ctx, session, [...tickets, ...cachedTickets]) },
    '../../../lib/supabase.ts': { supabase: null },
    '../../../utils/dates': { nowIso: () => '2026-09-12T00:00:00Z' },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../../fiscal/local/annulment.ts': { prepareLocalFiscalAnnulment },
    '../../fiscal/local/refund.ts': { issuePosRefund },
    '../../fiscal/local/installation.ts': { getFiscalInstallationLease: async () => null, loadFiscalInstallation: async () => null },
    '../../fiscal/local/localLedger.ts': { buildLocalRectificative: async () => null, findLocalFiscalEntryByTicket: async () => null, persistLocalRectificative: async () => undefined },
    '../../fiscal/local/clock.ts': { assertFiscalLease: () => undefined },
    '../../local-printing': { nextPrintCopyNumber: () => 1, usePrintAgentStore: { getState: () => ({}) } },
    '../../local-printing/cashlogy/useCashlogyStore': {
      finishCashlogyPayment: (transaction) => calls.finished.push(transaction),
      getCashlogyPaymentAmounts: (transaction, totalCents) => ({ changeCents: transaction?.changeCents ?? 0, receivedCents: transaction?.receivedCents ?? totalCents }),
      settleCashlogyPaymentIfConfigured,
    },
  }, { window: { confirm: () => true, prompt: () => 'Anulación solicitada' } })
  const options = {
    cashSession: { id: 'cash', cashRegisterId: 'register' },
    context: { role: 'owner', tenantId: 'tenant', venueId: 'venue', deviceId: 'device' },
    isOnline,
    ledger: [{ id: 'sale-1', paymentMethod: 'card' }],
    mergeRemotePrintStates: (tickets) => tickets,
    persistLedger: (ledger) => calls.ledgers.push(ledger),
    persistTickets: (tickets) => calls.tickets.push(tickets),
    printTicket: async () => {},
    refreshPendingCount() {},
    setBusy: (busy) => calls.busy.push(busy),
    setError: (error) => calls.errors.push(error),
    setHistoryOpen: (open) => calls.historyOpen.push(open),
    subtractProductSalesStats: () => { calls.stats += 1 },
    syncPendingEvents: async () => { calls.sync += 1; await syncPendingEvents() },
    tickets: [ticket],
  }
  return { calls, options, render: () => runner.render(options), ticket }
}
