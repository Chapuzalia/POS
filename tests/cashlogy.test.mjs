import assert from 'node:assert/strict'

import test from 'node:test'
import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'

import { denominationTotalCents, getDispensableDenominations, selectedDenominations } from '../src/features/local-printing/cashlogy/cashlogyManagement.ts'
import { pollCashlogyOperation } from '../src/features/local-printing/cashlogy/cashlogyPolling.ts'

import { cashlogyAcknowledgements } from '../src/features/local-printing/cashlogy/cashlogyAcknowledgements.ts'

import { getCompletedStackerCollection } from '../src/features/local-printing/cashlogy/stackerCollection.ts'

import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'
import { createCashTicketActionsHarness } from './helpers/cash-ticket-actions-harness.mjs'
import { deferred, flush } from './helpers/restaurant-controller-harness.mjs'

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
  await client.recoverCashlogyTransaction(tx.id)
  await client.acknowledgeCashlogyTransaction(tx.id, true)
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
  assert.ok(calls.some((call) => call.path.endsWith(`/transactions/${tx.id}/recover`) && call.init.method === 'POST'))
  assert.deepEqual(calls.find((call) => call.path.endsWith(`/transactions/${tx.id}/acknowledge`)).body, { reviewed: true })
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
})

test('la gestión de efectivo espera durante la selección y entrega de cambio antes de terminar', async () => {
  const operationSequence = ['accepting', 'awaiting_dispense', 'dispensing', 'completed']
  let operationCalls = 0
  const result = await pollCashlogyOperation(
    async () => ({ operation: operation('refill', operationSequence[operationCalls++]) }),
    operation('refill', 'starting'),
    { intervalMs: 1 },
  )
  assert.equal(result.status, 'completed')
})

test('solo una retirada de stacker completada produce el importe real que debe registrarse', () => {
  const intent = {
    requestId: 'cashlogy:stacker:intent-1',
    type: 'remove_stacker',
    operationId: null,
    cashSessionId: 'cash-session-1',
    createdAt: '2026-08-27T10:00:00Z',
  }
  const completed = operation('remove_stacker', 'completed', {
    requestId: intent.requestId,
    dispensedCents: 12345,
  })

  assert.deepEqual(getCompletedStackerCollection(completed, intent), {
    cashSessionId: 'cash-session-1',
    requestId: intent.requestId,
    operationId: completed.id,
    amountCents: 12345,
  })
  for (const status of ['failed', 'cancelled', 'unknown', 'needs_attention']) {
    assert.equal(getCompletedStackerCollection({ ...completed, status }, intent), null)
  }
  assert.equal(getCompletedStackerCollection(operation('withdraw', 'completed', { dispensedCents: 12345 }), intent), null)
})

test('el cierre sobrevive a errores y recargas, aislado por backend, sin perder cierres concurrentes', async () => {
  const values = new Map()
  const originalWindow = globalThis.window
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } }
  try {
    const scope = { tenantId: 'tenant', establishmentId: 'venue', terminalId: 'terminal' }
    const queue = cashlogyAcknowledgements(scope, 'https://agent-one')
    queue.add('cltx-1', false)
    assert.equal(cashlogyAcknowledgements(scope, 'https://agent-one').contains('cltx-1'), true)
    await assert.rejects(queue.flush(async () => { throw new Error('Backend reiniciando') }))
    await cashlogyAcknowledgements(scope, 'https://agent-two').flush(async () => assert.fail('Otro backend'))
    const calls = []
    await cashlogyAcknowledgements(scope, 'https://agent-one').flush(async (id, reviewed) => {
      calls.push([id, reviewed])
      queue.add('cltx-2', true)
    })
    assert.deepEqual(calls, [['cltx-1', false]])
    await queue.flush(async (id, reviewed) => calls.push([id, reviewed]))
    assert.deepEqual(calls, [['cltx-1', false], ['cltx-2', true]])
    assert.equal(values.size, 0)
    assert.equal(queue.contains('cltx-1'), false)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
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

test('el histórico confirma en Cashlogy antes de cambiar un ticket de tarjeta a efectivo', async () => {
  const settlement = deferred()
  let attempts = 0
  const confirmed = transaction('completed', {
    changeCents: 100, id: 'tx-confirmed', receivedCents: 700, requestId: 'request-confirmed', requestedAmountCents: 600, saleId: 'sale-1',
  })
  const harness = createCashTicketActionsHarness({
    settleCashlogyPaymentIfConfigured: async () => { attempts += 1; return settlement.promise },
  })

  const change = harness.render().changePayment(harness.ticket, 'cash')
  await flush()
  assert.equal(attempts, 1)
  assert.equal(harness.calls.tickets.length, 0)

  await harness.render().changePayment(harness.ticket, 'cash')
  assert.equal(attempts, 1)
  settlement.resolve(confirmed)
  await change

  const updated = harness.calls.tickets[0][0]
  assert.equal(updated.paymentMethod, 'cash')
  assert.equal(updated.payload.payment.cashlogyTransactionId, 'tx-confirmed')
  assert.equal(updated.payload.payment.receivedCents, 700)
  assert.equal(updated.payload.payment.changeCents, 100)
  assert.equal(harness.calls.enqueued[0].payload.cashlogyRequestId, 'request-confirmed')
  assert.equal(harness.calls.enqueued[0].payload.cashlogyTransactionId, 'tx-confirmed')
  assert.equal(harness.calls.sync, 1)
  assert.equal(harness.calls.finished.length, 1)
  assert.deepEqual(harness.calls.busy, [true, false])
})
