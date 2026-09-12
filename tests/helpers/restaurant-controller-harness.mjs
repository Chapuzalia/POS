import { readFile } from 'node:fs/promises'

import { createCompiledHookRunner } from './component-harness.mjs'

const source = await readFile(new URL('../../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')

export const flush = () => new Promise((resolve) => setImmediate(resolve))

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, reject, resolve }
}

export function createRestaurantControllerHarness({
  cashlogyTransaction = null,
  cashlogyConfigured = false,
  closeResult,
  currentOrder: initialOrder,
  pendingUnits = 0,
  tableService: tableServiceOverrides = {},
} = {}) {
  const mapRefresh = deferred()
  const queueSync = deferred()
  const print = deferred()
  const calls = {
    busy: [],
    cashlogyFinished: [],
    cashlogySettlements: [],
    close: 0,
    drafts: [],
    errors: [],
    paid: [],
    pendingChecks: 0,
    prints: 0,
    replaced: [],
    setMap: [],
  }
  const fallbackOrder = {
    lines: [{ id: 'line', productId: 'product', quantity: 1, servedQuantity: 1, unitPriceCents: 600, variantId: 'variant' }],
    order: { id: 'order', revision: 1, status: 'open' },
    tables: [{ areaId: 'area', id: 'table', isVirtual: false }],
  }
  let currentOrder = initialOrder ?? fallbackOrder
  const draft = {
    clearOrder() { currentOrder = null },
    flush: async () => currentOrder,
    getCurrentOrder: () => currentOrder,
    get order() { return currentOrder },
    replaceOrder(next) { currentOrder = next; calls.replaced.push(next) },
    saveState: 'saved',
    updateDraft(update) {
      currentOrder = update(currentOrder)
      calls.drafts.push(currentOrder)
    },
  }
  let map = { areas: [{ id: 'area' }], tables: [{ id: 'table', isVirtual: false, nextReservation: null, status: 'occupied' }] }
  const realtime = {
    configLoaded: true,
    loadCurrentMap: () => mapRefresh.promise,
    map,
    refreshMap: async () => undefined,
    setMap(next) {
      map = typeof next === 'function' ? next(map) : next
      realtime.map = map
      calls.setMap.push(map)
    },
    tablesEnabled: true,
  }
  const tableService = {
    closeRestaurantOrder: async () => {
      calls.close += 1
      return closeResult ?? { changeCents: null, nextOrderId: null, paymentId: 'payment', pendingUnits: 0, receivedCents: null, requiresConfirmation: false, saleId: 'sale', ticketId: 'ticket', totalCents: 600 }
    },
    cleanupVirtualRoomRestaurantTable: async () => false,
    loadRestaurantOrder: async () => currentOrder,
    loadRestaurantOrderPendingUnits: async () => {
      calls.pendingChecks += 1
      return { detail: currentOrder, pendingUnits }
    },
    ...tableServiceOverrides,
  }
  const modules = {
    '../../../lib/discounts': { calculateDiscountForLines: () => ({ totalCents: 600 }) },
    '../../../lib/format': { createId: () => 'id', getLineSignature: () => 'signature' },
    '../../../lib/observability.ts': { reportOperationError() {} },
    '../../../utils/UserFacingError.ts': { UserFacingError: Error },
    '../../../utils/dates': { nowIso: () => '2026-09-12T00:00:00Z' },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../../catalog/services/saleLineBuilder': { buildSaleLine() {} },
    '../../customers/service': { loadTicketInvoice: async () => null },
    '../../fiscal/service': { autoIssueFiscalTicket: async () => ({ fiscal: null }), loadFiscalReceiptData: async () => null },
    '../../local-printing/cashlogy/useCashlogyStore': {
      finishCashlogyPayment: (transaction) => calls.cashlogyFinished.push(transaction),
      getCashlogyPaymentAmounts: (transaction, totalCents) => ({ changeCents: transaction?.changeCents ?? null, receivedCents: transaction?.receivedCents ?? totalCents }),
      settleCashlogyPaymentIfConfigured: async (amountCents) => { calls.cashlogySettlements.push(amountCents); return cashlogyTransaction },
    },
    '../../local-printing/store/usePrintAgentStore': { usePrintAgentStore: { getState: () => ({ cashlogyConfigured }) } },
    '../../platform/tenantFeatureAccess': { hasTenantFeature: () => false },
    '../../production/service': { loadOrderProductionState() {}, sendProductionBatch() {}, subscribeToOrderProduction() {} },
    '../../tables/layout-service': { applySessionLayout() {}, saveSessionTableLayout() {} },
    '../../tables/service': tableService,
    '../../tables/service-status': { canDecreaseLineQuantity: () => true },
    '../draft-policy': { isRestaurantRevisionConflict: () => false, requiresConfirmedRestaurantLineRemoval: () => false, shouldSaveBeforeLeavingOrder: () => false },
    '../services/restaurantPrintPayload': {
      buildRestaurantPrintPayload: (payload) => payload,
      getEqualSplitPrintLines: () => [],
      getMovedRestaurantPrintLines: () => [],
      getRestaurantPrintSubtotal: () => 600,
    },
    '../services/validateCashClosure': { getRestaurantCashClosureError: async () => null },
    './useRestaurantDraft': { useRestaurantDraft: () => draft },
    './useRestaurantRealtime': { useRestaurantRealtime: () => realtime },
  }
  const runner = createCompiledHookRunner(source, 'useRestaurantController', modules, {
    console,
    window: { confirm: () => true, setTimeout() { return 1 } },
  })
  const options = {
    appliedDiscount: null,
    cashSession: { id: 'session' },
    catalog: null,
    context: { canTakeOrders: true, canTakePayments: true, deviceId: 'device', tenantId: 'tenant', venueId: 'venue' },
    enabled: true,
    isBusy: false,
    isOnline: true,
    onAddFeedback() {},
    onError: (error) => calls.errors.push(error),
    onPaidFeedback: (method) => calls.paid.push(method),
    printSale: async () => { calls.prints += 1; await print.promise },
    refreshCashSales: async () => undefined,
    refreshProductSalesStats: async () => undefined,
    setAppliedDiscount() {},
    setBusy: (value) => calls.busy.push(value),
    setMobileTicketOpen() {},
    syncPendingEvents: () => queueSync.promise,
  }

  return {
    calls,
    draft,
    get order() { return currentOrder },
    mapRefresh,
    options,
    print,
    queueSync,
    realtime,
    render: () => runner.render(options),
  }
}
