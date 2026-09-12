import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { jsx, jsxs } from 'react/jsx-runtime'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const paymentSource = await read('src/features/quick-sale/hooks/useQuickSalePayment.ts')
const modalSource = await read('src/features/local-printing/components/CashlogyPaymentModal.tsx')
const storeSource = await read('src/features/local-printing/cashlogy/useCashlogyStore.ts')
const identitySource = storeSource.match(/export function getCashlogyPaymentSaleId[\s\S]*?\n}/)[0]

function compile(source, modules, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  vm.runInNewContext(code, { exports, Error, require: (name) => {
    assert.ok(name in modules, `Missing dependency: ${name}`)
    return modules[name]
  }, ...globals })
  return exports
}

function harness({ saleId = null, lines = [{ quantity: 1 }], intentPatch = {}, busySync = false } = {}) {
  const transaction = { id: 'tx', requestId: 'req', saleId, requestedAmountCents: 600, status: 'completed' }
  const state = { modalOpen: true, intent: { requestId: 'req', transactionId: 'tx', saleId: 'sale', amountCents: 600, ...intentPatch }, transaction }
  const calls = { events: [], errors: [], charges: 0, finishes: 0, prints: 0 }
  const store = { getState: () => state }
  const { getCashlogyPaymentSaleId } = compile(identitySource, {}, { useCashlogyStore: store })
  let releaseSync
  const sync = busySync ? new Promise((resolve) => { releaseSync = resolve }) : Promise.resolve()
  const cashlogy = {
    getCashlogyPaymentSaleId,
    getCashlogyPaymentAmounts: () => ({ receivedCents: 600, changeCents: 0 }),
    settleCashlogyPaymentIfConfigured: async () => { calls.charges++; throw new Error('Must not charge twice') },
    finishCashlogyPayment: () => { calls.finishes++; state.intent = null; state.modalOpen = false },
  }
  const { useQuickSalePayment: createPayment } = compile(paymentSource, {
    react: { useRef: (current) => ({ current }), useCallback: (callback) => callback },
    '../../../lib/observability.ts': { reportOperationError() {}, operationBreadcrumb() {} },
    '../../../utils/errors.ts': { getReadableError: (error) => error.message },
    '../../../lib/format': { createId: () => 'event' },
    '../../../lib/offlineStore': { enqueueOfflineEvent: (event) => calls.events.push(event) },
    '../services/salePayload': { buildSalePayload: (_context, _session, _lines, _method, _received, _discount, _customer, identity) => ({
      sale: { id: identity?.saleId ?? 'new-sale', totalCents: 600, createdAt: 'now' }, ticket: { id: 'ticket' }, payment: {},
    }) },
    '../../fiscal/service': { loadFiscalReceiptData: async () => null },
    '../../customers/service': { loadTicketInvoice: async () => null },
    '../../local-printing/cashlogy/useCashlogyStore': cashlogy,
  })
  const pay = createPayment({ context: { tenantId: 'tenant' }, cashSession: { id: 'session' }, lines,
    ledger: [], tickets: [], isOnline: true, persistLedger() {}, persistTickets() {}, persistLines() {},
    mergeProductStats() {}, resetUi() {}, refreshPendingCount() {}, syncPendingEvents: () => sync,
    printSale: async () => { calls.prints++ }, onError: (error) => calls.errors.push(error),
  })
  return { state, calls, pay, transaction, releaseSync, getCashlogyPaymentSaleId }
}

test('aplica el cobro recuperado sin saleId remoto usando la identidad persistida y sin volver a cobrar', async () => {
  const h = harness()
  await h.pay('cash', null, h.transaction)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.events[0].payload.sale.id, 'sale')
  assert.equal(h.calls.events[0].payload.payment.cashlogyTransactionId, 'tx')
  assert.equal(h.calls.charges, 0)
  assert.equal(h.calls.finishes, 1)
  assert.equal(h.calls.prints, 1)
  assert.equal(h.state.intent, null)
  assert.equal(h.state.modalOpen, false)
})

test('no reutiliza la identidad de otro intento ni pierde el cobro cuando falta el ticket', async () => {
  for (const config of [{ lines: [] }, { intentPatch: { requestId: 'other' } },
    { intentPatch: { amountCents: 700 } }, { intentPatch: { transactionId: 'other' } },
    { intentPatch: { recoveredFromConflict: true } }]) {
    const h = harness(config)
    await assert.rejects(h.pay('cash', null, h.transaction), /ticket|identificable/)
    assert.equal(h.calls.events.length, 0)
    assert.equal(h.calls.charges, 0)
    assert.equal(h.calls.finishes, 0)
    assert.ok(h.state.intent)
  }
})

test('dos aplicaciones simultáneas no duplican la venta y el segundo intento explica el bloqueo', async () => {
  const h = harness({ busySync: true })
  const first = h.pay('cash', null, h.transaction)
  await assert.rejects(h.pay('cash', null, h.transaction), /sigue en curso/)
  h.releaseSync()
  await first
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.charges, 0)
})

function modalHarness(state, onFinalizeRecovered) {
  const slots = []
  let cursor = 0
  const { CashlogyPaymentModal } = compile(modalSource, {
    'react/jsx-runtime': { jsx, jsxs },
    react: { useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => { slots[index] = value }]
    } },
    'lucide-react': { AlertTriangle: 'icon', Ban: 'icon', CheckCircle2: 'icon', LoaderCircle: 'icon' },
    'zustand/react/shallow': { useShallow: (selector) => selector },
    '../../../components/ui': { AppModal: 'modal', Button: 'button', Metric: 'metric' },
    '../../../lib/format': { formatMoney: String },
    '../cashlogy/cashlogyPresentation': { shouldShowCashlogyOperationDetails: () => false },
    '../cashlogy/cashlogyError': { isUncertainCashlogyError: () => false },
    '../cashlogy/cashlogyPolling': { cashlogyActiveStatuses: new Set(), cashlogyCancellableStatuses: new Set() },
    '../cashlogy/useCashlogyStore': { useCashlogyStore: (selector) => selector(state) },
    './CashlogyLevelCards': { CashlogyLevelCards: 'levels' },
  })
  return () => { cursor = 0; return CashlogyPaymentModal({ onFinalizeRecovered }) }
}
function nodes(tree) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('el modal muestra el fallo al aplicar y permite volver al TPV conservando el cobro', async () => {
  const h = harness({ lines: [] })
  h.state.hide = () => { h.state.modalOpen = false }
  const render = modalHarness(h.state, (transaction) => h.pay('cash', null, transaction))
  const apply = nodes(render()).find((node) => node.type === 'button' && node.props.variant === 'primary')
  apply.props.onClick()
  await flush()
  const after = nodes(render())
  const alert = after.find((node) => node.props?.role === 'alert')
  assert.ok(alert)
  assert.match(alert.props.children.props.children, /No hay productos/)
  const back = after.find((node) => node.type === 'button' && node.props.children === 'Volver al TPV')
  assert.equal(back.props.disabled, false)
  back.props.onClick()
  assert.equal(h.state.modalOpen, false)
  assert.ok(h.state.intent)
  assert.equal(h.calls.finishes, 0)
  assert.equal(h.calls.charges, 0)
})

test('el botón Aplicar registra la venta recuperada y cierra el modal', async () => {
  const h = harness()
  h.state.hide = () => { h.state.modalOpen = false }
  const render = modalHarness(h.state, (transaction) => h.pay('cash', null, transaction))
  const apply = nodes(render()).find((node) => node.type === 'button' && node.props.variant === 'primary')
  assert.equal(Boolean(apply.props.disabled), false)
  apply.props.onClick()
  await flush()
  assert.equal(render(), null)
  assert.equal(h.calls.events.length, 1)
  assert.equal(h.calls.charges, 0)
  assert.equal(h.calls.finishes, 1)
})

test('un estado incierto solo permite aplicar o repetir después de revisión manual', async () => {
  const h = harness()
  h.state.transaction.status = 'unknown'
  const calls = { closed: 0, finalized: 0, retries: [] }
  h.state.closeReviewed = () => { calls.closed += 1 }
  h.state.startPayment = async (...args) => {
    calls.retries.push(args)
    return { ...h.transaction, id: 'retry', status: 'completed' }
  }
  const render = modalHarness(h.state, async () => { calls.finalized += 1 })

  let rendered = nodes(render())
  const checkbox = rendered.find((node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(rendered.find((node) => node.type === 'button' && node.props.variant === 'primary').props.disabled, true)
  assert.equal(rendered.find((node) => node.type === 'button' && node.props.variant === 'danger').props.disabled, true)

  checkbox.props.onChange({ target: { checked: true } })
  rendered = nodes(render())
  const retry = rendered.find((node) => node.type === 'button' && node.props.variant === 'danger')
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  await flush()

  assert.equal(calls.closed, 1)
  assert.deepEqual(calls.retries, [[600, 'sale']])
  assert.equal(calls.finalized, 1)
})
