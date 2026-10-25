import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createCompiledHookRunner, jsxRuntime } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8')
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
  : [tree, ...nodes(tree.props?.children)]

function harness(modalOpen = false, originalKind = 'quick-sale:pending-sale') {
  const modules = {}
  // Shallow UI boundaries retain the real PosPage state, guards and handlers.
  for (const node of ts.createSourceFile('PosPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements) {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) continue
    const dependency = node.moduleSpecifier.text
    modules[dependency] = {}
    for (const element of node.importClause?.namedBindings?.elements ?? []) {
      if (!element.isTypeOnly) modules[dependency][element.propertyName?.text ?? element.name.text] = element.name.text
    }
  }
  const calls = { card: 0, reopen: 0, clear: 0, quickRecovery: 0, restaurantRecovery: 0, targetedRecovery: 0, acknowledged: 0 }
  const intent = { requestId: 'pending-request', saleId: 'pending-sale', amountCents: 600 }
  const store = { intent, modalOpen, show: () => calls.reopen++ }
  const quickSale = { lines: [{ id: 'new-line' }], completePayment: async method => {
    if (method === 'card') calls.card++
    else calls.quickRecovery++
  }, clear: () => calls.clear++ }
  Object.assign(modules, {
    'react/jsx-runtime': jsxRuntime,
    '../utils/notifications.ts': { notifyOperationalError() {} },
    '../lib/offlineStore': { getOfflineQueue: () => [] },
    '../lib/durableSales.ts': { loadPaymentOperations: async () => [{ key: `scope|${originalKind}`, payload: { sale: { id: 'pending-sale' } } }] },
    '../features/restaurant/services/payment.ts': { recoverRestaurantPayments: async (_context, _session, transaction) => {
      calls.targetedRecovery++
      assert.equal(transaction.saleId, 'pending-sale')
      return [{ result: { ticketId: 'old-ticket' }, transaction }]
    } },
    '../features/offline/services/pendingSync': { pendingSync: () => ({ pendingCount: 0 }) },
    '../features/assist/engine': { isAssistEnabled: () => false },
    '../features/tables/useMobileTableMapLayout': { useMobileTableMapLayout: () => 'desktop' },
    '../features/cash-registers/services/sessionTicketHistoryModel.ts': { createCachedSessionTicketHistoryPage: () => ({}) },
    '../features/platform/tenantFeatureAccess': { hasTenantCapability: (_context, capability) => capability === 'cashlogy' },
    '../lib/discounts': { calculateDiscountForLines: () => ({ totalCents: 900, lineAllocations: [] }) },
    '../lib/format': { formatMoney: String, getLineTotal: () => 900, getTicketTotal: () => 900 },
    '../lib/diagnostics': { addDiagnosticBreadcrumb() {} },
    '../features/local-printing/cashlogy/useCashlogyStore': { useCashlogyStore: select => select(store), getCashlogyPaymentSaleId: tx => tx.saleId,
      finishCashlogyPayment: () => calls.acknowledged++ },
    '../features/local-printing/cashlogy/useCashlogyManagementStore': { useCashlogyManagementStore: select => select({ modalOpen: false }) },
    '../features/local-printing/store/usePrintAgentStore': { usePrintAgentStore: select => select({ cashlogyConfigured: true }) },
    './pos-error-lifecycle': { isActiveCashlogyError: () => false },
  })
  const runner = createCompiledHookRunner(source, 'PosPage', modules)
  const props = { context: { canTakePayments: true }, cash: { session: { id: 'session' }, tickets: [], ticketActions: {}, refreshConfirmedSale: async () => {} },
    quickSale, restaurant: { posView: { type: 'quick_sale' }, map: {}, completePayment: async () => calls.restaurantRecovery++, reloadMap: async () => {} },
    reservations: {}, addFeedback: {}, themes: [], fiscalPendingTicketIds: [], isBusy: false, isOnline: true,
    onUpdateBlockingOperationChange() {} }
  return { calls, props, render: () => nodes(runner.render(props)) }
}

test('a hidden pending Cashlogy operation leaves the catalogue, new ticket and card payment available', async () => {
  const h = harness()
  const tree = h.render()
  assert.equal(tree.find(node => node.type === 'CatalogPanel').props.disabled, false)
  const ticket = tree.find(node => node.type === 'TicketPanel')
  assert.equal(ticket.props.isBusy, false)
  ticket.props.onClear()
  assert.equal(h.calls.clear, 1)
  const payment = tree.find(node => node.type === 'PaymentPanel')
  assert.equal(payment.props.disabled, false)
  payment.props.onPayment('card')
  await new Promise(setImmediate)
  assert.equal(h.calls.card, 1)
  assert.equal(h.calls.reopen, 0)
  payment.props.onPayment('cash')
  assert.equal(h.calls.reopen, 1, 'a busy physical machine reopens its existing operation')
})

test('an open Cashlogy modal keeps its interaction guard until the operator continues', () => {
  const h = harness(true)
  assert.equal(h.render().find(node => node.type === 'PaymentPanel').props.disabled, true)
})

test('applying a pending quick payment after changing to a table still recovers the original quick sale', async () => {
  const h = harness()
  h.props.restaurant.posView = { type: 'table_order' }
  await h.render().find(node => node.type === 'CashlogyPaymentModal').props.onFinalizeRecovered({ saleId: 'pending-sale' })
  assert.equal(h.calls.quickRecovery, 1)
  assert.equal(h.calls.restaurantRecovery, 0)
})

test('applying a pending table payment after changing ticket recovers its saved order instead of the visible ticket', async () => {
  const h = harness(false, 'restaurant:close:old-order')
  await h.render().find(node => node.type === 'CashlogyPaymentModal').props.onFinalizeRecovered({ saleId: 'pending-sale' })
  assert.equal(h.calls.targetedRecovery, 1)
  assert.equal(h.calls.quickRecovery, 0)
  assert.equal(h.calls.restaurantRecovery, 0)
  assert.equal(h.calls.acknowledged, 1)
})
