import { readFile } from 'node:fs/promises'

import { compileComponent, createCompiledHookRunner } from './component-harness.mjs'
import { getOrderPendingUnits } from '../../src/features/tables/service-status.ts'
import { withConfirmedRestaurantPayments } from '../../src/features/restaurant/services/paymentPayload.ts'
import { requiresConfirmedRestaurantLineRemoval } from '../../src/features/restaurant/draft-policy.ts'
import * as restaurantPrintPayload from '../../src/features/restaurant/services/restaurantPrintPayload.ts'
import { calculateDiscountForLines } from '../../src/lib/discounts.ts'
import { isMenuOrderLine } from '../../src/features/tables/menu-service-model.ts'

const source = await readFile(new URL('../../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')
const paymentSource = await readFile(new URL('../../src/features/restaurant/services/payment.ts', import.meta.url), 'utf8')

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
  fiscalMode = 'disabled',
  fiscalIssue = null,
  pendingUnits = 0,
  realPayloads = false,
  tableService: tableServiceOverrides = {},
  productionService: productionServiceOverrides = {},
} = {}) {
  const mapRefresh = deferred()
  const queueSync = deferred()
  const print = deferred()
  const calls = {
    busy: [],
    cashlogyFinished: [],
    cashlogySettlements: [],
    close: 0,
    fiscalIssues: [],
    fiscalPreflights: [],
    drafts: [],
    errors: [],
    paid: [],
    pendingChecks: 0,
    prints: 0,
    printed: [],
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
    '../../../lib/discounts': { calculateDiscountForLines: realPayloads ? calculateDiscountForLines : () => ({ totalCents: 600 }) },
    '../../../lib/format': { createId: () => 'id', getLineSignature: () => 'signature', isValidQuantity: (value) => Number.isFinite(value) && value > 0, roundQuantity: (value) => value },
    '../../../lib/observability.ts': { reportOperationError() {} },
    '../../../utils/UserFacingError.ts': { UserFacingError: Error },
    '../../../utils/dates': { nowIso: () => '2026-09-12T00:00:00Z' },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../../../services/posService': { loadSessionTicketFromSupabase: async () => null },
    '../../catalog/services/saleLineBuilder': { buildSaleLine() {} },
    '../services/menuCourses': { reconcileMenuEdit() {} },
    '../../customers/service': { loadTicketInvoice: async () => null },
    '../../customers/customerValidation.ts': { customerFiscalSnapshot: (customer) => customer },
    '../../fiscal/service': { autoIssueFiscalTicket: async () => ({ fiscal: null }), loadFiscalReceiptData: async () => null },
    '../../local-printing/cashlogy/useCashlogyStore': {
      isCashlogyPaymentConfigured: () => cashlogyConfigured,
      finishCashlogyPayment: (transaction) => calls.cashlogyFinished.push(transaction),
      getCashlogyPaymentAmounts: (transaction, totalCents) => ({ changeCents: transaction?.changeCents ?? null, receivedCents: transaction?.receivedCents ?? totalCents }),
      settleCashlogyPaymentIfConfigured: async (amountCents) => { calls.cashlogySettlements.push(amountCents); return cashlogyTransaction },
    },
    '../../local-printing/store/usePrintAgentStore': { usePrintAgentStore: { getState: () => ({ cashlogyConfigured }) } },
    '../../local-printing/services/earlyCashDrawer': { requestEarlyCashDrawer: () => false },
    '../../platform/tenantFeatureAccess': { hasTenantFeature: () => false, hasTenantCapability: () => false },
    '../../production/service': { loadOrderProductionState: async () => null, sendProductionBatch() {}, subscribeToOrderProduction() {}, ...productionServiceOverrides },
    '../../tables/layout-service': { applySessionLayout() {}, saveSessionTableLayout() {} },
    '../../tables/service': tableService,
    '../../tables/menu-service-model': { isMenuOrderLine },
    '../../tables/service-status': { canDecreaseLineQuantity: () => true, getOrderPendingUnits },
    '../draft-policy': { isRestaurantRevisionConflict: () => false, requiresConfirmedRestaurantLineRemoval, shouldSaveBeforeLeavingOrder: () => false },
    '../services/restaurantPrintPayload': realPayloads ? restaurantPrintPayload : {
      buildRestaurantPrintPayload: (input) => ({ ...input,
        ticket: { id: input.ticketId, totalCents: input.totalCents, invoice: input.invoice },
        sale: { id: input.saleId, totalCents: input.totalCents, paymentMethod: input.paymentMethod },
        payment: input.paymentMethod ? { id: input.paymentId, receivedCents: input.receivedCents, changeCents: input.changeCents } : null,
      }),
      getEqualSplitPrintLines: () => [],
      getMovedRestaurantPrintLines: () => [],
      getRestaurantPrintSubtotal: () => 600,
    },
    '../services/validateCashClosure': { getRestaurantCashClosureError: async () => null },
    '../../fiscal/local/mode.ts': { assertRealSaleAllowed() {} },
    '../../fiscal/local/tenantMode.ts': { assertRealSaleAllowed() {}, resolveLocalFiscalMode: async () => fiscalMode },
    '../../fiscal/local/restaurantInvoice.ts': { preflightRestaurantInvoice: async (_context, _session, saleId) => { calls.fiscalPreflights.push(saleId); return { saleId } }, issueRestaurantInvoice: async (...args) => {
      calls.fiscalIssues.push(args)
      if (!fiscalIssue) throw new Error('Unexpected production fiscal issue')
      return fiscalIssue(...args)
    } },
    '../../local-printing/constants/config': { PRINT_AGENT_ENABLED: true },
    './useRestaurantDraft': { useRestaurantDraft: () => draft },
    './useRestaurantRealtime': { useRestaurantRealtime: () => realtime },
  }
  const operations = new Map()
  const paymentService = compileComponent(paymentSource, {
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': {
      paymentScope: () => 'scope', withPaymentLock: (_key, work) => work(),
      loadPaymentOperation: async key => operations.get(key),
      loadPendingPaymentOperations: async () => [],
      preparePaymentOperation: async (key, fingerprint, payload, params) => {
        const existing = operations.get(key)
        if (existing && existing.fingerprint !== fingerprint && existing.state !== 'committed') throw new Error('Pending payment')
        if (existing?.fingerprint === fingerprint) return existing
        const operation = { key, fingerprint, payload, params, state: 'prepared', cashlogy: null, eventId: 'event' }
        operations.set(key, operation); return operation
      },
      acceptPaymentOperation: async (operation, payload, cashlogy) => {
        const next = { ...operation, payload, cashlogy, state: 'accepted' }; operations.set(next.key, next); return next
      },
      markPaymentCharging: async operation => ({ ...operation, state: 'charging' }),
      discardPreparedPaymentOperation: async key => operations.delete(key),
      commitPaymentOperation: async (operation, payload, _enqueue, result) => operations.set(operation.key, { ...operation, payload, result, state: 'committed' }),
    },
    '../../local-printing/cashlogy/useCashlogyStore.ts': modules['../../local-printing/cashlogy/useCashlogyStore'],
    '../../fiscal/local/tenantMode.ts': modules['../../fiscal/local/tenantMode.ts'],
    '../../fiscal/local/posInvoice.ts': { preflightPosInvoice: async (_context, _session, payload) => { calls.fiscalPreflights.push(payload.sale.id); return {} } },
    '../../fiscal/local/restaurantInvoice.ts': modules['../../fiscal/local/restaurantInvoice.ts'],
    '../../tables/service.ts': { payRestaurantIdempotent: async (_context, _id, action, params) => {
      if (action === 'close') return tableService.closeRestaurantOrder(params.orderId, params.method, params.receivedCents, params.allowPending)
      if (action === 'selected_items') return tableService.payRestaurantOrderItems(params.orderId, params.expectedRevision, params.moves, params.method, params.receivedCents, params.allowPending, params.discount, cashlogyTransaction)
      if (action === 'equal_part') return tableService.payRestaurantEqualPart(params.splitId, params.method, params.receivedCents, params.allowPending, params.discount, params.useDefaultDiscount, cashlogyTransaction)
      throw new Error('Unexpected payment action')
    } },
  }, { JSON })
  modules['../services/payment.ts'] = paymentService
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
    printSale: async (payload) => { calls.prints += 1; calls.printed.push(payload); await print.promise },
    refreshCashSales: async () => undefined,
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
