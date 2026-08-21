import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'
import { PrintAgentError } from '../src/features/local-printing/api/PrintAgentError.ts'
import { CashlogyError, isUncertainCashlogyError, toCashlogyError } from '../src/features/local-printing/cashlogy/cashlogyError.ts'
import {
  denominationTotalCents,
  getDispensableDenominations,
  selectedDenominations,
  suggestCashlogyDenominations,
} from '../src/features/local-printing/cashlogy/cashlogyManagement.ts'
import {
  cashlogyActiveStatuses,
  cashlogyCancellableStatuses,
  cashlogyManagementActiveStatuses,
  cashlogyManagementCancellableStatuses,
  cashlogyManagementTerminalStatuses,
  cashlogyTerminalStatuses,
  pollCashlogyOperation,
  pollCashlogyTransaction,
} from '../src/features/local-printing/cashlogy/cashlogyPolling.ts'
import { createCashlogyRequestId } from '../src/features/local-printing/cashlogy/cashlogyRequestId.ts'
import {
  getCashlogyIntentStorageKey,
  getCashlogyManagementIntentStorageKey,
  loadCashlogyIntent,
  loadCashlogyManagementIntent,
  saveCashlogyIntent,
  saveCashlogyManagementIntent,
} from '../src/features/local-printing/cashlogy/cashlogyStorage.ts'
import { getDefaultPrintAgentConfig } from '../src/features/local-printing/services/printAgentStorage.ts'
import { getAutomaticSaleHardwareAction, shouldOpenCashDrawer } from '../src/features/local-printing/services/cashDrawerRules.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

const root = new URL('../', import.meta.url)

function transaction(status, patch = {}) {
  return {
    id: 'cltx-1', requestId: 'cashlogy:sale:intent-1', saleId: 'sale-1',
    connectorId: 'connector', status, operationNumber: '1', terminalCode: 'POS_MAIN',
    requestedAmountCents: 1250, automaticAcceptedCents: null, manualAcceptedCents: null,
    returnedCents: null, changeAddedCents: null, netPaidCents: null,
    connectorResultCode: null, normalizedErrorCode: null, error: null, warning: null,
    test: false, cancelRequestedAt: null, startedAt: null, completedAt: null,
    createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T10:00:00Z',
    ...patch,
  }
}

function operation(type, status, patch = {}) {
  return {
    id: `clcm-${type}`, requestId: `cashlogy:${type}:intent-1`, connectorId: 'connector', type, status,
    requestedAmountCents: null, acceptedCents: null, dispensedCents: null,
    denominationsRequested: null, denominationsDispensed: null, changeAddedCents: null,
    resultCode: null, normalizedErrorCode: null, error: null,
    startedAt: null, completedAt: null, createdAt: '2026-08-18T10:00:00Z', updatedAt: '2026-08-18T10:00:00Z',
    ...patch,
  }
}

const accounting = {
  total: { recyclerTotalCents: 5000, stackerTotalCents: 12000, totalCents: 17000, queriedAt: '2026-08-18T10:00:00Z' },
  denominations: {
    coins: [{ valueCents: 200, recyclerCount: 4, stackerCount: 1 }],
    notes: [{ valueCents: 2000, recyclerCount: 2, stackerCount: 3 }],
    queriedAt: '2026-08-18T10:00:00Z',
  },
  levels: { levels: [], queriedAt: '2026-08-18T10:00:00Z' },
  capabilities: {
    currency: 'EUR',
    capabilities: [
      { valueCents: 200, capabilityCode: 3, depositable: true, dispensable: true },
      { valueCents: 2000, capabilityCode: 1, depositable: true, dispensable: false },
    ],
    queriedAt: '2026-08-18T10:00:00Z',
  },
  queriedAt: '2026-08-18T10:00:00Z',
}

test('la configuración predeterminada conserva el modo de solo impresora', () => {
  const config = getDefaultPrintAgentConfig()
  assert.equal(config.cashlogyConfigured, false)
  assert.equal(config.cashlogyTerminalCode, 'POS_MAIN')
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings: { autoOpenCashDrawer: true, cashlogyConfigured: false } }), true)
})

test('Cashlogy bloquea el cajón convencional y respeta la preferencia de impresión', () => {
  const settings = { alwaysPrintTicket: false, autoOpenCashDrawer: true, cashlogyConfigured: true }
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings }), false)
  assert.equal(getAutomaticSaleHardwareAction({ payments: [{ method: 'cash', amountCents: 1250 }], settings }), 'none')
  assert.equal(getAutomaticSaleHardwareAction({ payments: [{ method: 'cash', amountCents: 1250 }], settings: { ...settings, alwaysPrintTicket: true } }), 'print')
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings: { ...settings, healthOk: false } }), false)
})

test('el cliente tipado usa todas las rutas HTTP headless de api.md', async () => {
  const calls = []
  const tx = transaction('waiting_for_cash')
  const refill = operation('refill', 'accepting', { acceptedCents: 500 })
  const giveChange = operation('give_change', 'awaiting_dispense', { acceptedCents: 2000 })
  const generic = operation('withdraw', 'completed', { dispensedCents: 2000 })
  const recovery = {
    ok: true, ready: true,
    previousErrors: { ok: true, resultCode: '0', errors: [], error: null },
    cancelResult: null,
    resetResult: { ok: true, resultCode: '0', error: null },
    initializationResult: { ok: true, resultCode: '0', protocolVersion: '2.01', error: null },
    currentErrors: { ok: true, resultCode: '0', errors: [], error: null },
    accountingCheck: {
      ok: true,
      total: { ok: true, resultCode: '0', totalCents: 17000, error: null },
      denominations: { ok: true, resultCode: '0', coinDenominationCount: 1, noteDenominationCount: 1, error: null },
    },
    affectedOperation: null,
  }
  const connector = { id: 'cashlogy-127.0.0.1-8092', host: '127.0.0.1', port: 8092, reachable: true, processRunning: true, initialized: false, selected: false, protocolVersion: null, lastConnectedAt: null }
  const client = createPrintAgentClient({
    baseUrl: 'https://pos-local.test:8443', token: 'secret',
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push({ path, init, body: init?.body ? JSON.parse(init.body) : null })
      if (path.endsWith('/health')) return Response.json({ ok: true, enabled: true })
      if (path.endsWith('/connectors/discover') || path.endsWith('/connectors')) return Response.json({ connectors: [connector] })
      if (path.endsWith(`/${connector.id}/select`)) return Response.json({ ok: true, connector: { ...connector, selected: true }, device: null })
      if (path.endsWith(`/${connector.id}/initialize`)) return Response.json({ ok: true, connector: { ...connector, selected: true, initialized: true }, device: { model: 'Cashlogy', serialNumber: 'CL-1', ready: true } })
      if (path.endsWith('/device/errors')) return Response.json({ response: {}, errors: [] })
      if (path.endsWith('/device')) return Response.json({ device: null })
      if (path.endsWith('/accounting')) return Response.json(accounting)
      if (path.endsWith('/accounting/total')) return Response.json(accounting.total)
      if (path.endsWith('/accounting/denominations')) return Response.json(accounting.denominations)
      if (path.endsWith('/accounting/levels')) return Response.json(accounting.levels)
      if (path.endsWith('/accounting/capabilities')) return Response.json(accounting.capabilities)
      if (path === '/api/v1/cashlogy/cancel') return Response.json({ ok: true, cancelled: true, pending: false, duplicate: false, target: { kind: 'cash_management', id: refill.id }, operation: { status: 'cancelled', resultCode: '0' } })
      if (path === '/api/v1/cashlogy/admin/recover') return Response.json(recovery)
      if (path.endsWith('/transactions/charge') || path.endsWith('/cancel')) return Response.json({ ok: true, duplicate: false, transaction: tx }, { status: 202 })
      if (path.includes('/transactions/')) return Response.json({ transaction: tx })
      if (path.includes('/refill/')) return Response.json(path.endsWith('/finalize') ? { ok: true, duplicate: false, operation: { ...refill, status: 'completed' } } : { operation: refill })
      if (path.endsWith('/refill/start')) return Response.json({ ok: true, duplicate: false, operation: refill }, { status: 202 })
      if (path.includes('/give-change/') && !path.endsWith('/start')) return Response.json(path.endsWith(`/give-change/${giveChange.id}`) ? { operation: giveChange } : { ok: true, duplicate: false, operation: giveChange })
      if (path.endsWith('/give-change/start')) return Response.json({ ok: true, duplicate: false, operation: giveChange }, { status: 202 })
      return Response.json({ ok: true, duplicate: false, operation: generic }, { status: 202 })
    },
  })

  await client.getCashlogyHealth()
  await client.discoverCashlogyConnectors()
  await client.getCashlogyConnectors()
  await client.selectCashlogyConnector(connector.id)
  await client.initializeCashlogyConnector(connector.id)
  await client.getCashlogyDevice()
  await client.getCashlogyErrors()
  await client.getCashlogyAccounting()
  await client.getCashlogyTotal()
  await client.getCashlogyDenominations()
  await client.getCashlogyLevels()
  await client.getCashlogyCapabilities()
  await client.createCashlogyCharge({ requestId: tx.requestId, saleId: tx.saleId, amountCents: 1250, terminalCode: 'POS_MAIN' })
  await client.getCashlogyTransaction(tx.id)
  await client.getCashlogyTransactionByRequestId(tx.requestId)
  await client.cancelCashlogyTransaction(tx.id)
  await client.cancelActiveCashlogyOperation()
  await client.startCashlogyRefill(refill.requestId)
  await client.getCashlogyRefill(refill.id)
  await client.finalizeCashlogyRefill(refill.id)
  await client.startCashlogyGiveChange(giveChange.requestId)
  await client.getCashlogyGiveChange(giveChange.id)
  await client.finalizeCashlogyGiveChangeAdmission(giveChange.id)
  await client.dispenseCashlogyGiveChange(giveChange.id, [{ valueCents: 2000, quantity: 1 }])
  await client.withdrawCashlogyCash(generic.requestId, [{ valueCents: 2000, quantity: 1 }])
  await client.emptyCashlogy('cashlogy:empty:intent-1')
  await client.collectCashlogyStacker('cashlogy:stacker:intent-1')
  await client.getCashlogyCashManagementOperationByRequestId(generic.requestId)
  await client.recoverCashlogy()

  assert.equal(calls.every((call) => call.init.headers.Authorization === 'Bearer secret'), true)
  assert.ok(calls.some((call) => call.path === '/api/v1/cashlogy/accounting'))
  assert.ok(calls.some((call) => call.path === '/api/v1/cashlogy/connectors/discover' && call.init.method === 'POST'))
  assert.ok(calls.some((call) => call.path.endsWith(`/${connector.id}/select`) && call.init.method === 'POST'))
  assert.ok(calls.some((call) => call.path.endsWith(`/${connector.id}/initialize`) && call.init.method === 'POST'))
  assert.ok(calls.some((call) => call.path.endsWith('/cash-management/refill/start')))
  assert.ok(calls.some((call) => call.path.endsWith('/cash-management/give-change/clcm-give_change/dispense')))
  assert.ok(calls.some((call) => call.path.endsWith('/cash-management/withdraw')))
  assert.ok(calls.some((call) => call.path.endsWith('/cash-management/empty')))
  assert.ok(calls.some((call) => call.path.endsWith('/cash-management/stacker/collect')))
  assert.ok(calls.some((call) => call.path.includes('/cash-management/operations/by-request/')))
  assert.ok(calls.some((call) => call.path === '/api/v1/cashlogy/cancel' && call.init.method === 'POST'))
  assert.ok(calls.some((call) => call.path === '/api/v1/cashlogy/admin/recover' && call.init.method === 'POST'))
  assert.deepEqual(calls.find((call) => call.path.endsWith('/cash-management/withdraw')).body.denominations, [{ valueCents: 2000, quantity: 1 }])
})

test('el selector usa céntimos, capacidades y límites fiables del reciclador', () => {
  const options = getDispensableDenominations(accounting)
  assert.deepEqual(options, [{ valueCents: 200, availableQuantity: 4, kind: 'coin' }])
  const selected = selectedDenominations({ 200: 3, 500: 0, 1000: -1, 2000: 1 })
  assert.deepEqual(selected, [{ valueCents: 2000, quantity: 1 }, { valueCents: 200, quantity: 3 }])
  assert.equal(denominationTotalCents(selected), 2600)
  assert.deepEqual(suggestCashlogyDenominations([
    { valueCents: 500, availableQuantity: 1, kind: 'note' },
    { valueCents: 200, availableQuantity: 4, kind: 'coin' },
    { valueCents: 100, availableQuantity: 2, kind: 'coin' },
  ], 700), [{ valueCents: 500, quantity: 1 }, { valueCents: 200, quantity: 1 }])
  assert.deepEqual(suggestCashlogyDenominations([
    { valueCents: 500, availableQuantity: 1, kind: 'note' },
  ], 700), [])
})

test('el cálculo auxiliar de combinaciones admite denominaciones menores y capacidades parciales', () => {
  const partialCapabilities = {
    ...accounting,
    denominations: {
      ...accounting.denominations,
      coins: [
        ...accounting.denominations.coins,
        { valueCents: 100, recyclerCount: 10, stackerCount: 0 },
      ],
    },
  }
  assert.deepEqual(getDispensableDenominations(partialCapabilities), [
    { valueCents: 200, availableQuantity: 4, kind: 'coin' },
    { valueCents: 100, availableQuantity: 10, kind: 'coin' },
  ])
  assert.deepEqual(suggestCashlogyDenominations([
    { valueCents: 2000, availableQuantity: 1, kind: 'note' },
    { valueCents: 1000, availableQuantity: 2, kind: 'note' },
    { valueCents: 500, availableQuantity: 4, kind: 'note' },
  ], 2000), [{ valueCents: 1000, quantity: 2 }])
})

test('dar cambio Cashlogy empieza a 0 y exige elegir las denominaciones manualmente', async () => {
  const [modal, selector] = await Promise.all([
    readFile(new URL('src/features/local-printing/components/CashlogyMachineModal.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyDenominationSelector.tsx', root), 'utf8'),
  ])

  assert.match(modal, /useState<Record<number, number>>\(\{\}\)/)
  assert.match(modal, /setQuantities\(\{\}\)[\s\S]*managementRequestId/)
  assert.doesNotMatch(modal, /suggestCashlogyDenominations/)
  assert.doesNotMatch(modal, /suggestedOperationId/)
  assert.match(selector, /quantities\[option\.valueCents\] \?\? 0/)
  assert.match(selector, /Elige manualmente la combinación/)
  assert.match(selector, /Poner todo a 0/)
})

test('los pollings terminan solo en estados terminales y permiten la fase awaiting_dispense', async () => {
  const transactionSequence = ['processing', 'dispensing_change', 'completed']
  let transactionCalls = 0
  const tx = await pollCashlogyTransaction(
    async () => ({ transaction: transaction(transactionSequence[transactionCalls++]) }),
    transaction('queued'),
    { intervalMs: 1 },
  )
  assert.equal(tx.status, 'completed')

  const operationSequence = ['accepting', 'processing', 'completed']
  let operationCalls = 0
  const result = await pollCashlogyOperation(
    async () => ({ operation: operation('refill', operationSequence[operationCalls++]) }),
    operation('refill', 'starting'),
    { intervalMs: 1 },
  )
  assert.equal(result.status, 'completed')
  assert.ok(cashlogyActiveStatuses.has('waiting_for_cash'))
  assert.ok(cashlogyTerminalStatuses.has('unknown'))
  assert.ok(cashlogyCancellableStatuses.has('waiting_for_cash'))
  assert.ok(cashlogyManagementActiveStatuses.has('awaiting_dispense'))
  assert.ok(cashlogyManagementCancellableStatuses.has('accepting'))
  assert.equal(cashlogyManagementCancellableStatuses.has('awaiting_dispense'), false)
  assert.ok(cashlogyManagementTerminalStatuses.has('needs_attention'))
})

test('requestId e intenciones de venta y gestión sobreviven a una recarga por terminal', () => {
  const values = new Map()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } }
  const scope = { tenantId: 'tenant', establishmentId: 'venue', terminalId: 'terminal' }
  const paymentIntent = { requestId: 'cashlogy:sale:stable', saleId: 'sale', amountCents: 1250, terminalCode: 'POS_MAIN', transactionId: null, createdAt: '2026-08-18T10:00:00Z' }
  const managementIntent = { requestId: 'cashlogy:refill:stable', type: 'refill', operationId: null, createdAt: '2026-08-18T10:00:00Z' }
  saveCashlogyIntent(scope, paymentIntent)
  saveCashlogyManagementIntent(scope, managementIntent)
  assert.deepEqual(loadCashlogyIntent(scope), paymentIntent)
  assert.deepEqual(loadCashlogyManagementIntent(scope), managementIntent)
  assert.match(getCashlogyIntentStorageKey(scope), /cashlogy-intent$/)
  assert.match(getCashlogyManagementIntentStorageKey(scope), /cashlogy-management-intent$/)
  assert.match(createCashlogyRequestId('give_change'), /^cashlogy:give-change:[A-Za-z0-9_.:-]+$/)
  saveCashlogyIntent(scope, null)
  saveCashlogyManagementIntent(scope, null)
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

test('los errores se traducen y los resultados HTTP inciertos se distinguen', () => {
  const remote = toCashlogyError(new PrintAgentError({
    code: 'HTTP_ERROR', status: 409,
    details: { error: { code: 'CASHLOGY_BUSY', message: 'technical text', originalCode: 'LEGACY_42' } },
  }))
  assert.ok(remote instanceof CashlogyError)
  assert.equal(remote.code, 'CASHLOGY_BUSY')
  assert.match(remote.message, /otra operación/)
  assert.equal(remote.originalCode, 'LEGACY_42')
  assert.equal(isUncertainCashlogyError(new PrintAgentError({ code: 'TIMEOUT' })), true)
  assert.equal(isUncertainCashlogyError(new PrintAgentError({ code: 'HTTP_ERROR', status: 502 })), true)
  assert.equal(isUncertainCashlogyError(new PrintAgentError({ code: 'HTTP_ERROR', status: 409 })), false)
})

test('el ticket Cashlogy nunca abre el cajón de la impresora', () => {
  const sale = {
    ticket: { id: 'ticket', tenantId: 'tenant', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', subtotalCents: 1250, discount: null, discountAmountCents: 0, totalCents: 1250, createdAt: '2026-08-18T10:00:00Z' },
    lines: [],
    sale: { id: 'sale', tenantId: 'tenant', ticketId: 'ticket', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', totalCents: 1250, paymentMethod: 'cash', createdAt: '2026-08-18T10:00:00Z' },
    payment: { id: 'payment', tenantId: 'tenant', saleId: 'sale', method: 'cash', amountCents: 1250, receivedCents: 1250, changeCents: 0 },
  }
  const request = mapSaleToPrintRequest({ sale, establishment: { name: 'Venue' }, printerId: 'printer', printerLayout: { columns: 48, paperWidth: 80, characterSet: 'CP858' }, autoOpenCashDrawer: true, cashlogyConfigured: true })
  assert.equal(request.options.openCashDrawer, false)
})

test('el POS usa cobro headless antes de persistir e imprimir, también sin impresora', async () => {
  const [quickSale, restaurant, printTicket, drawerButton, page] = await Promise.all([
    readFile(new URL('src/features/quick-sale/hooks/useQuickSalePayment.ts', root), 'utf8'),
    readFile(new URL('src/features/restaurant/hooks/useRestaurantController.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/services/printTicket.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/ManualCashDrawerButton.tsx', root), 'utf8'),
    readFile(new URL('src/app/PosPage.tsx', root), 'utf8'),
  ])
  assert.match(quickSale, /settleCashlogyPaymentIfConfigured\(preview\.sale\.totalCents, preview\.sale\.id\)/)
  assert.match(restaurant, /if \(method !== 'cash'\) return/)
  assert.match(quickSale, /finishCashlogyPayment\(cashlogyTransaction\)[\s\S]*options\.printSale/)
  assert.match(printTicket, /cashlogyConfigured/)
  assert.match(drawerButton, /agent\.cashlogyConfigured/)
  assert.match(page, /if \(cashlogyConfigured\)[\s\S]*completePayment\('cash', null\)/)
})

test('el histórico confirma en Cashlogy antes de cambiar un ticket de tarjeta a efectivo', async () => {
  const [ticketActions, ticketHistory, paymentModal, page] = await Promise.all([
    readFile(new URL('src/features/cash-registers/hooks/useCashTicketActions.ts', root), 'utf8'),
    readFile(new URL('src/components/modals/SessionTicketsModal.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyPaymentModal.tsx', root), 'utf8'),
    readFile(new URL('src/app/PosPage.tsx', root), 'utf8'),
  ])

  assert.match(ticketActions, /ticket\.paymentMethod === 'card' && paymentMethod === 'cash'/)
  assert.match(ticketActions, /await settleCashlogyPaymentIfConfigured\(ticket\.totalCents, ticket\.payload\.sale\.id\)/)
  assert.ok(
    ticketActions.indexOf('await settleCashlogyPaymentIfConfigured') < ticketActions.indexOf('options.persistTickets(nextTickets)'),
    'Cashlogy debe confirmar el cobro antes de persistir el cambio de método',
  )
  assert.match(ticketActions, /getCashlogyPaymentAmounts\(cashlogyTransaction, ticket\.totalCents\)/)
  assert.match(ticketActions, /finishCashlogyPayment\(cashlogyTransaction\)/)
  assert.match(ticketActions, /El ticket continúa pagado con tarjeta/)
  assert.match(ticketActions, /El cobro está confirmado en Cashlogy, pero no se pudo guardar el cambio del ticket/)
  assert.match(ticketHistory, /value=\{ticket\.paymentMethod \?\? ''\}/)
  assert.match(ticketHistory, /void onChangePayment\(ticket, event\.target\.value as PaymentMethod\)/)
  assert.match(paymentModal, /onFinalizeRecovered\(state\.transaction!\)/)
  assert.match(page, /cash\.tickets\.find[\s\S]*ticket\.payload\.sale\.id === transaction\.saleId[\s\S]*ticketActions\.changePayment\(historicalTicket, 'cash'\)/)
})

test('unknown y needs_attention nunca completan una venta y solo se consultan por requestId', async () => {
  const [paymentStore, managementStore, paymentModal, operationStatus] = await Promise.all([
    readFile(new URL('src/features/local-printing/cashlogy/useCashlogyStore.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/cashlogy/useCashlogyManagementStore.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyPaymentModal.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyOperationStatus.tsx', root), 'utf8'),
  ])
  assert.match(paymentStore, /terminal\.status !== 'completed'/)
  assert.match(paymentStore, /transaction\.status === 'unknown'/)
  assert.match(paymentStore, /transaction\.status === 'needs_attention'/)
  assert.match(paymentStore, /hide\(\)\s*{\s*set\(\{ modalOpen: false \}\)/)
  assert.match(managementStore, /getCashlogyCashManagementOperationByRequestId/)
  assert.match(managementStore, /if \(operation\.status === 'unknown' \|\| operation\.status === 'needs_attention'\) return/)
  assert.match(managementStore, /hide\(\)\s*{\s*set\(\{ modalOpen: false \}\)/)
  assert.match(paymentModal, /Consultar estado de nuevo/)
  assert.match(paymentModal, /Volver al TPV/)
  assert.match(operationStatus, /No repitas la operación/)
})

test('la gestión es headless, cubre los cinco flujos y no contiene fallback externo', async () => {
  const [client, modal, managementStore, selector] = await Promise.all([
    readFile(new URL('src/features/local-printing/api/printAgentClient.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyMachineModal.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/cashlogy/useCashlogyManagementStore.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyDenominationSelector.tsx', root), 'utf8'),
  ])
  for (const source of [client, modal, managementStore]) {
    assert.doesNotMatch(source, /cashlogy\/backoffice\/open/i)
    assert.doesNotMatch(source, /openCashlogyBackoffice/)
  }
  assert.match(modal, /Rellenar/)
  assert.match(modal, /Dar cambio/)
  assert.match(modal, /Retirar efectivo/)
  assert.match(modal, /Vaciar Cashlogy/)
  assert.match(modal, /Retirar stacker/)
  assert.match(modal, /finalizeGiveChangeAdmission/)
  assert.match(modal, /Cancelar operación/)
  assert.match(modal, /management\.cancel\(\)/)
  assert.match(modal, /Volver al TPV/)
  assert.doesNotMatch(modal, /suggestCashlogyDenominations/)
  assert.doesNotMatch(modal, /suggestedOperationId/)
  assert.match(managementStore, /persistIntent\(intent\)[\s\S]*createRequest/)
  assert.match(managementStore, /denominationOptions/)
  assert.match(managementStore, /if \(!startPromise\)/)
  assert.match(managementStore, /cancelActiveCashlogyOperation/)
  assert.match(managementStore, /cashlogyManagementCancellableStatuses/)
  assert.match(selector, /availableQuantity/)
  assert.match(selector, /targetCents/)
  assert.match(selector, /quantities\[option\.valueCents\] \?\? 0/)
  assert.match(selector, /Poner todo a 0/)
})

test('los ajustes permiten configurar y ejecutar la recuperación forzada de Cashlogy', async () => {
  const [settings, connectorList, store] = await Promise.all([
    readFile(new URL('src/features/local-printing/components/PrintAgentSettings.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyConnectorList.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/store/usePrintAgentStore.ts', root), 'utf8'),
  ])
  assert.match(settings, /Buscar máquinas/)
  assert.match(settings, /discoverCashlogyConnectors/)
  assert.match(settings, /selectCashlogyConnector/)
  assert.match(settings, /initializeCashlogyConnector/)
  assert.match(settings, /Ejecutar recuperación forzada/)
  assert.match(settings, /recoverCashlogy/)
  assert.match(settings, /resultado quedará como desconocido/)
  assert.match(connectorList, /Seleccionar/)
  assert.match(connectorList, /Inicializar/)
  assert.match(connectorList, /Lista para usar/)
  assert.match(store, /activeClient\.selectCashlogyConnector/)
  assert.match(store, /activeClient\.initializeCashlogyConnector/)
  assert.match(store, /activeClient\.recoverCashlogy/)
})
