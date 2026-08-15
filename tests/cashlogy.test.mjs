import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'
import { PrintAgentError } from '../src/features/local-printing/api/PrintAgentError.ts'
import { CashlogyError, toCashlogyError } from '../src/features/local-printing/cashlogy/cashlogyError.ts'
import {
  cashlogyDangerousManagementActions,
  cashlogyManagementPresets,
} from '../src/features/local-printing/cashlogy/cashlogyManagement.ts'
import {
  cashlogyActiveStatuses,
  cashlogyCancellableStatuses,
  cashlogyTerminalStatuses,
  pollCashlogyTransaction,
} from '../src/features/local-printing/cashlogy/cashlogyPolling.ts'
import {
  getCashlogyIntentStorageKey,
  loadCashlogyIntent,
  saveCashlogyIntent,
} from '../src/features/local-printing/cashlogy/cashlogyStorage.ts'
import { getDefaultPrintAgentConfig } from '../src/features/local-printing/services/printAgentStorage.ts'
import { getAutomaticSaleHardwareAction, shouldOpenCashDrawer } from '../src/features/local-printing/services/cashDrawerRules.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

const root = new URL('../', import.meta.url)

function transaction(status, patch = {}) {
  return {
    id: 'cashlogy-transaction-1', requestId: 'cashlogy:payment:intent-1', saleId: null,
    connectorId: 'connector', status, operationNumber: '1', terminalCode: 'POS_MAIN',
    requestedAmountCents: 1250, automaticAcceptedCents: null, manualAcceptedCents: null,
    returnedCents: null, changeAddedCents: null, netPaidCents: null,
    connectorResultCode: null, normalizedErrorCode: null, error: null, warning: null,
    test: false, cancelRequestedAt: null, startedAt: null, completedAt: null,
    createdAt: '2026-08-14T10:00:00Z', updatedAt: '2026-08-14T10:00:00Z',
    ...patch,
  }
}

test('la configuracion predeterminada conserva el modo de solo impresora', () => {
  const config = getDefaultPrintAgentConfig()
  assert.equal(config.cashlogyConfigured, false)
  assert.equal(config.cashlogyTerminalCode, 'POS_MAIN')
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings: { autoOpenCashDrawer: true, cashlogyConfigured: false } }), true)
})

test('Cashlogy configurado bloquea el cajon aunque este desconectado y fuerza la impresion', () => {
  const settings = { alwaysPrintTicket: false, autoOpenCashDrawer: true, cashlogyConfigured: true }
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings }), false)
  assert.equal(getAutomaticSaleHardwareAction({ payments: [{ method: 'cash', amountCents: 1250 }], settings }), 'print')
  assert.equal(shouldOpenCashDrawer({ payments: [{ method: 'cash', amountCents: 1250 }], settings: { ...settings, healthOk: false } }), false)
})

test('el cliente usa las rutas Cashlogy, Bearer y acepta respuestas duplicadas', async () => {
  const calls = []
  const duplicate = transaction('waiting_for_cash')
  const client = createPrintAgentClient({
    baseUrl: 'https://pos-local.test:8443', token: 'secret',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, duplicate: true, transaction: duplicate }), { status: 200 })
    },
  })
  const result = await client.chargeCashlogy({ requestId: duplicate.requestId, saleId: null, amountCents: 1250, terminalCode: 'POS_MAIN', test: false })
  assert.equal(result.duplicate, true)
  assert.match(calls[0].url, /\/api\/v1\/cashlogy\/transactions\/charge$/)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')

  await client.getCashlogyTransactionByRequest(duplicate.requestId)
  assert.match(calls[1].url, /\/transactions\/by-request\/cashlogy%3Apayment%3Aintent-1$/)
  await client.cancelCashlogyTransaction(duplicate.id)
  assert.equal(calls[2].init.method, 'POST')
  assert.match(calls[2].url, /\/cashlogy-transaction-1\/cancel$/)
})

test('la gestión de efectivo usa contabilidad y perfiles de backoffice acotados', async () => {
  const calls = []
  const client = createPrintAgentClient({
    baseUrl: 'https://pos-local.test:8443', token: 'secret',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/accounting/total')) return new Response(JSON.stringify({ resultCode: '0', recyclerTotalCents: 5000, stackerTotalCents: 12000, totalCents: 17000, queriedAt: '2026-08-14T10:00:00Z' }))
      if (String(url).endsWith('/accounting/denominations')) return new Response(JSON.stringify({ resultCode: '0', coins: [], notes: [], queriedAt: '2026-08-14T10:00:00Z' }))
      return new Response(JSON.stringify({ resultCode: '0', amountAtEntry: 17000, amountAtExit: 16000, amountIntroduced: 0, amountWithdrawn: 1000, pendingRefund: 0, accountingAdjustment: 0 }))
    },
  })

  const [total, denominations] = await Promise.all([
    client.getCashlogyTotal(),
    client.getCashlogyDenominations(),
  ])
  assert.equal(total.recyclerTotalCents, 5000)
  assert.deepEqual(denominations.coins, [])
  await client.openCashlogyBackoffice(cashlogyManagementPresets.withdraw, true)

  assert.match(calls[0].url, /\/api\/v1\/cashlogy\/accounting\/total$/)
  assert.match(calls[1].url, /\/api\/v1\/cashlogy\/accounting\/denominations$/)
  assert.match(calls[2].url, /\/api\/v1\/cashlogy\/backoffice\/open$/)
  const body = JSON.parse(calls[2].init.body)
  assert.equal(body.preset.withdrawCash, true)
  assert.equal(body.preset.completeEmptying, false)
  assert.equal(body.preset.resetCoins, false)
  assert.equal(body.confirmDangerousOperations, true)
  assert.equal(cashlogyDangerousManagementActions.has('withdraw'), true)
})

test('el menú de máquina depende de una conexión Cashlogy real', async () => {
  const [page, header, modal] = await Promise.all([
    readFile(new URL('src/app/PosPage.tsx', root), 'utf8'),
    readFile(new URL('src/components/layout/AppHeader.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/CashlogyMachineModal.tsx', root), 'utf8'),
  ])
  assert.match(page, /cashlogyHealth\.connector\?\.connected/)
  assert.match(header, /if \(cashlogyConnected\).*cashlogy-machine/)
  assert.match(modal, /Cajón de recaudación/)
  assert.match(modal, /Reciclador · cambio disponible/)
  assert.match(modal, /Promise\.all/)
})

test('el polling acepta cualquier secuencia activa y termina solo en un estado terminal', async () => {
  const sequence = ['processing', 'connecting', 'dispensing_change', 'completed']
  let calls = 0
  const result = await pollCashlogyTransaction(
    async () => ({ transaction: transaction(sequence[calls++]) }),
    transaction('queued'),
    { intervalMs: 1 },
  )
  assert.equal(result.status, 'completed')
  assert.equal(calls, 4)
  assert.ok(cashlogyActiveStatuses.has('waiting_for_cash'))
  assert.ok(cashlogyTerminalStatuses.has('unknown'))
  assert.ok(cashlogyTerminalStatuses.has('needs_attention'))
  assert.ok(cashlogyCancellableStatuses.has('waiting_for_cash'))
  assert.equal(cashlogyCancellableStatuses.has('dispensing_change'), false)
})

test('la intencion se persiste por terminal y conserva requestId para recuperar tras recarga', () => {
  const values = new Map()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } }
  const scope = { tenantId: 'tenant', establishmentId: 'venue', terminalId: 'terminal' }
  const intent = { requestId: 'cashlogy:payment:stable', saleId: null, amountCents: 1250, terminalCode: 'POS_MAIN', transactionId: null, createdAt: '2026-08-14T10:00:00Z' }
  saveCashlogyIntent(scope, intent)
  assert.deepEqual(loadCashlogyIntent(scope), intent)
  assert.match(getCashlogyIntentStorageKey(scope), /cashlogy-intent$/)
  saveCashlogyIntent(scope, null)
  assert.equal(loadCashlogyIntent(scope), null)
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

test('los errores remotos se traducen a mensajes comprensibles conservando el codigo tecnico', () => {
  const mapped = toCashlogyError({})
  assert.ok(mapped instanceof CashlogyError)
  const remote = toCashlogyError(new PrintAgentError({
    code: 'HTTP_ERROR',
    details: { error: { code: 'CASHLOGY_CANCEL_ON_CONNECTOR_SCREEN', message: 'Cancel on connector', originalCode: 'LEGACY_42' } },
  }))
  assert.equal(remote.code, 'CASHLOGY_CANCEL_ON_CONNECTOR_SCREEN')
  assert.equal(remote.message, 'Cancel on connector')
  assert.equal(remote.originalCode, 'LEGACY_42')
})

test('el ticket Cashlogy nunca abre el cajon de la impresora', () => {
  const sale = {
    ticket: { id: 'ticket', tenantId: 'tenant', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', subtotalCents: 1250, discount: null, discountAmountCents: 0, totalCents: 1250, createdAt: '2026-08-14T10:00:00Z' },
    lines: [],
    sale: { id: 'sale', tenantId: 'tenant', ticketId: 'ticket', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', totalCents: 1250, paymentMethod: 'cash', createdAt: '2026-08-14T10:00:00Z' },
    payment: { id: 'payment', tenantId: 'tenant', saleId: 'sale', method: 'cash', amountCents: 1250, receivedCents: 1250, changeCents: 0 },
  }
  const request = mapSaleToPrintRequest({ sale, establishment: { name: 'Venue' }, printerId: 'printer', autoOpenCashDrawer: true, cashlogyConfigured: true })
  assert.equal(request.options.openCashDrawer, false)
  assert.equal(request.requestId, 'print:sale:original')
})

test('los flujos solo invocan Cashlogy para efectivo y consumen el cobro antes de imprimir', async () => {
  const [quickSale, restaurant, printTicket, drawerButton, settings, wizard] = await Promise.all([
    readFile(new URL('src/features/quick-sale/hooks/useQuickSalePayment.ts', root), 'utf8'),
    readFile(new URL('src/features/restaurant/hooks/useRestaurantController.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/services/printTicket.ts', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/ManualCashDrawerButton.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/PrintAgentSettings.tsx', root), 'utf8'),
    readFile(new URL('src/features/local-printing/components/PrintAgentSetupWizard.tsx', root), 'utf8'),
  ])
  assert.match(quickSale, /if \(paymentMethod === 'cash'\)[\s\S]*settleCashlogyPaymentIfConfigured/)
  assert.match(restaurant, /if \(method !== 'cash'\) return/)
  assert.match(quickSale, /finishCashlogyPayment\(cashlogyTransaction\)[\s\S]*options\.printSale/)
  assert.match(printTicket, /cashlogyConfigured/)
  assert.match(drawerButton, /agent\.cashlogyConfigured/)
  assert.match(settings, /!agent\.cashlogyConfigured \? <Button[\s\S]*Abrir cajón/)
  assert.match(wizard, /step === 8 && canOpenDrawer/)
})

test('cancelled, unknown y needs_attention no pueden confirmar ni imprimir una venta', async () => {
  const store = await readFile(new URL('src/features/local-printing/cashlogy/useCashlogyStore.ts', root), 'utf8')
  assert.match(store, /terminal\.status !== 'completed'/)
  assert.match(store, /transaction\.status === 'cancelled'/)
  assert.match(store, /transaction\.status === 'unknown'/)
  assert.match(store, /transaction\.status === 'needs_attention'/)
  assert.match(store, /status !== 'cancelled' && status !== 'failed'/)
})

test('el coordinador impide iniciar dos cobros simultaneos', async () => {
  const store = await readFile(new URL('src/features/local-printing/cashlogy/useCashlogyStore.ts', root), 'utf8')
  assert.match(store, /if \(get\(\)\.isStarting \|\| get\(\)\.isPolling\) throw new CashlogyError\(\{ code: 'CASHLOGY_BUSY' \}\)/)
  assert.match(store, /if \(settlementPromise\) return settlementPromise/)
  assert.match(store, /persistIntent\(intent\)[\s\S]*chargeCashlogy/)
})
