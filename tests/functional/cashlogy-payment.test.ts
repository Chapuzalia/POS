import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPrintAgentClient } from '../../src/features/local-printing/api/printAgentClient'
import { usePrintAgentStore } from '../../src/features/local-printing/store/usePrintAgentStore'
import { useCashlogyStore } from '../../src/features/local-printing/cashlogy/useCashlogyStore'
import { loadCashlogyIntent } from '../../src/features/local-printing/cashlogy/cashlogyStorage'
import type { CashlogyTransaction, PrintAgentScope } from '../../src/features/local-printing/types'

// External persistence and telemetry boundaries only. Zustand, HTTP mapping,
// polling, errors, acknowledgements and local intent storage run unchanged.
vi.mock('../../src/lib/durableSales.ts', () => ({ updateCashlogyPaymentAttempt: async () => {} }))
vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError() {}, operationBreadcrumb() {} }))

const scope: PrintAgentScope = { tenantId: 'tenant-1', establishmentId: 'venue-1', terminalId: 'device-1' }
const requestId = 'cashlogy:sale:payment-1'
const chargePath = '/api/v1/cashlogy/transactions/charge'
const lookupPath = `/api/v1/cashlogy/transactions/by-request/${encodeURIComponent(requestId)}`
const transactionPath = '/api/v1/cashlogy/transactions/tx-1'
const ready = { ok: true, enabled: true, sessionState: 'ready', activeTransaction: null }

function transaction(patch: Partial<CashlogyTransaction> = {}): CashlogyTransaction {
  return {
    id: 'tx-1', requestId, saleId: 'sale-1', connectorId: 'connector', terminalCode: 'POS_MAIN',
    status: 'completed', requestedAmountCents: 1250, automaticAcceptedCents: 2000,
    manualAcceptedCents: 0, returnedCents: 750, changeAddedCents: 0, netPaidCents: 1250,
    operationNumber: '1', connectorResultCode: null, normalizedErrorCode: null,
    error: null, warning: null, test: false, cancelRequestedAt: null,
    startedAt: null, completedAt: null, createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
    ...patch,
  }
}

type Reply = (init: RequestInit) => Response | Promise<Response>
let routes: Map<string, Reply>
let calls: { path: string; init: RequestInit }[]

function postCount() { return calls.filter(call => call.path === chargePath).length }
function start() { return useCashlogyStore.getState().startPayment(1250, 'sale-1', undefined, requestId) }
function lookupReply(tx = transaction()) { return Response.json({ transaction: tx }) }
function pendingReply(signal?: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  routes = new Map([
    ['/api/v1/cashlogy/health', () => Response.json(ready)],
    ['/api/v1/cashlogy/accounting/levels', () => Response.json({ levels: [] })],
    [chargePath, () => Response.json({ ok: true, duplicate: false, transaction: transaction() })],
    [lookupPath, () => lookupReply()],
    [transactionPath, () => lookupReply()],
    [`${transactionPath}/acknowledge`, () => Response.json({ ok: true })],
  ])
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    calls.push({ path, init })
    const reply = routes.get(path)
    if (!reply) throw new Error(`Unexpected HTTP request: ${path}`)
    return reply(init)
  })
  usePrintAgentStore.setState({ baseUrl: 'https://agent.test', token: 'test-token', cashlogyConfigured: true, cashlogyTerminalCode: 'POS_MAIN' })
  useCashlogyStore.getState().configureScope(scope)
})

afterEach(() => {
  useCashlogyStore.getState().configureScope({ ...scope, terminalId: 'cleanup' })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('cobro mediante el agente de impresión', () => {
  it('confirma el cobro y conserva el importe, la venta y el requestId enviado una sola vez', async () => {
    const paid = await start()
    expect(paid).toMatchObject({ status: 'completed', netPaidCents: 1250, returnedCents: 750 })
    expect(postCount()).toBe(1)
    const call = calls.find(call => call.path === chargePath)
    expect(call).toBeDefined()
    if (!call) throw new Error('Missing charge request')
    expect(JSON.parse(String(call.init.body))).toEqual({ requestId, saleId: 'sale-1', amountCents: 1250, terminalCode: 'POS_MAIN', test: false })
    expect(call.init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer test-token' } })
    expect(loadCashlogyIntent(scope)).toMatchObject({ requestId, transactionId: 'tx-1' })
    useCashlogyStore.getState().finish('other-request')
    expect(loadCashlogyIntent(scope)).not.toBeNull()
    useCashlogyStore.getState().finish(requestId)
    expect(loadCashlogyIntent(scope)).toBeNull()
  })

  it('espera a la confirmación tras admitir efectivo y entregar cambio', async () => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash', netPaidCents: null })))
    let resolved = false
    const payment = start().then(value => { resolved = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(useCashlogyStore.getState().isPolling).toBe(true)
    routes.set(transactionPath, () => lookupReply(transaction({ status: 'dispensing_change', netPaidCents: null })))
    await vi.advanceTimersByTimeAsync(500)
    expect(resolved).toBe(false)
    expect(useCashlogyStore.getState().transaction?.status).toBe('dispensing_change')
    routes.set(transactionPath, () => lookupReply())
    await vi.advanceTimersByTimeAsync(500)
    expect((await payment).status).toBe('completed')
    expect(postCount()).toBe(1)
  })

  it.each([401, 403, 422])('rechaza HTTP %i sin enviar otro cobro', async status => {
    routes.set(chargePath, () => Response.json({ error: { code: 'CASHLOGY_BAD_DATA' } }, { status }))
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BAD_DATA' })
    expect(postCount()).toBe(1)
    expect(calls.some(call => call.path === lookupPath)).toBe(false)
    expect(useCashlogyStore.getState().isStarting).toBe(false)
  })

  it.each([500, 502, 503, 504, 'network'] as const)('recupera la respuesta perdida (%s) por el requestId original sin reenviar el POST', async failure => {
    routes.set(chargePath, () => {
      if (failure === 'network') throw new TypeError('connection lost after accepting cash')
      return Response.json({ error: { code: 'AGENT_UNAVAILABLE' } }, { status: failure })
    })
    expect((await start()).id).toBe('tx-1')
    expect(postCount()).toBe(1)
    expect(calls.filter(call => call.path === lookupPath)).toHaveLength(1)
  })

  it('conserva un cobro incierto durante una caída y lo recupera después de recargar', async () => {
    routes.set(chargePath, () => { throw new TypeError('offline') })
    routes.set(lookupPath, () => Response.json({ error: {} }, { status: 503 }))
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_NETWORK_ERROR' })
    await useCashlogyStore.getState().discardForRetry()
    expect(loadCashlogyIntent(scope)).toMatchObject({ requestId, amountCents: 1250 })
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    useCashlogyStore.getState().configureScope(scope)
    routes.set(lookupPath, () => lookupReply())
    expect((await useCashlogyStore.getState().recover())?.id).toBe('tx-1')
    expect(postCount()).toBe(1)
  })

  it('una respuesta lenta dentro del plazo termina sin timeout ni segundo POST', async () => {
    routes.set(chargePath, () => new Promise(resolve => setTimeout(() => resolve(lookupReply()), 4000)))
    const payment = start()
    await vi.advanceTimersByTimeAsync(3999)
    expect(useCashlogyStore.getState().isStarting).toBe(true)
    expect(useCashlogyStore.getState().transaction).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect((await payment).id).toBe('tx-1')
    await vi.advanceTimersByTimeAsync(10000)
    expect(postCount()).toBe(1)
    expect(useCashlogyStore.getState().error).toBeNull()
  })

  it('el timeout del POST consulta el cobro original y no lo vuelve a enviar', async () => {
    routes.set(chargePath, init => pendingReply(init.signal))
    const payment = start()
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls.some(call => call.path === lookupPath)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await payment).status).toBe('completed')
    expect(postCount()).toBe(1)
  })

  it('el timeout consultando el estado reintenta solo GET y mantiene bloqueado el cobro', async () => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    routes.set(transactionPath, init => pendingReply(init.signal))
    const rejected = expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_NETWORK_ERROR' })
    await vi.advanceTimersByTimeAsync(10750)
    await rejected
    expect(calls.filter(call => call.path === transactionPath)).toHaveLength(2)
    expect(loadCashlogyIntent(scope)?.requestId).toBe(requestId)
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    expect(postCount()).toBe(1)
  })

  it.each([
    ['failed', 'CASHLOGY_INVALID_STATE'], ['cancelled', 'CASHLOGY_OPERATION_CANCELLED'],
    ['unknown', 'CASHLOGY_STATUS_UNKNOWN'], ['needs_attention', 'CASHLOGY_RECONCILIATION_MISMATCH'],
  ] as const)('un resultado %s nunca confirma la venta', async (status, code) => {
    routes.set(chargePath, () => lookupReply(transaction({ status })))
    await expect(start()).rejects.toMatchObject({ code })
    expect(useCashlogyStore.getState().transaction?.status).toBe(status)
    expect(loadCashlogyIntent(scope)?.requestId).toBe(requestId)
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    expect(postCount()).toBe(1)
  })

  it.each([null, {}, { transaction: null }, { transaction: { status: 'completed' } },
    { transaction: { ...transaction(), status: 'invalid' } },
    { ok: false, transaction: transaction() }, { duplicate: 'yes', transaction: transaction() },
  ])('no acepta una respuesta 200 malformada: %j', async body => {
    routes.set(chargePath, () => Response.json(body))
    routes.set(lookupPath, () => Response.json(body))
    await expect(start()).rejects.toMatchObject({ cause: { code: 'INVALID_RESPONSE' } })
    await useCashlogyStore.getState().discardForRetry()
    expect(loadCashlogyIntent(scope)?.requestId).toBe(requestId)
    expect(postCount()).toBe(1)
  })

  it.each([
    { requestId: 'another-payment' }, { saleId: 'another-sale' }, { terminalCode: 'OTHER_TERMINAL' },
    { requestedAmountCents: 1249 }, { requestedAmountCents: 12.5 }, { requestedAmountCents: -1 },
    { test: true }, { netPaidCents: 1249 }, { netPaidCents: 1251 },
    { automaticAcceptedCents: -1 }, { returnedCents: 0.5 }, { netPaidCents: Number.MAX_SAFE_INTEGER + 1 },
    { automaticAcceptedCents: 1900 }, { returnedCents: 700 },
    { automaticAcceptedCents: Number.MAX_SAFE_INTEGER, manualAcceptedCents: 1 },
  ])('rechaza un cobro incoherente sin perder el intento: %j', async patch => {
    routes.set(chargePath, () => lookupReply(transaction(patch)))
    routes.set(lookupPath, () => lookupReply(transaction(patch)))
    await expect(start()).rejects.toHaveProperty('code')
    expect(useCashlogyStore.getState().transaction).toBeNull()
    expect(loadCashlogyIntent(scope)).toMatchObject({ requestId, amountCents: 1250, saleId: 'sale-1' })
    expect(postCount()).toBe(1)
  })

  it.each(['', '<html>Bad Gateway</html>', '{broken'])('recupera una respuesta vacía o no JSON sin duplicar el movimiento: %j', async body => {
    routes.set(chargePath, () => new Response(body))
    expect((await start()).id).toBe('tx-1')
    expect(postCount()).toBe(1)
  })

  it('no sustituye la operación por otro cobro durante el polling', async () => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    routes.set(transactionPath, () => lookupReply(transaction({ id: 'another-transaction' })))
    const rejected = expect(start()).rejects.toHaveProperty('code')
    await vi.advanceTimersByTimeAsync(500)
    await rejected
    expect(useCashlogyStore.getState().transaction?.id).toBe('tx-1')
    expect(loadCashlogyIntent(scope)?.transactionId).toBe('tx-1')
  })

  it.each([{ requestId: 'other-request' }, { saleId: 'other-sale' }, { requestedAmountCents: 1300, netPaidCents: 1300 }, { terminalCode: 'OTHER' }, { test: true }])('el polling mantiene la identidad económica inicial: %j', async patch => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    routes.set(transactionPath, () => lookupReply(transaction(patch)))
    const outcome = start().catch(error => error)
    await vi.advanceTimersByTimeAsync(500)
    expect(await outcome).toMatchObject({ cause: { code: 'INVALID_RESPONSE' } })
    expect(useCashlogyStore.getState().transaction?.status).toBe('waiting_for_cash')
    expect(postCount()).toBe(1)
  })

  it('recupera un agente antiguo que omite saleId sin perder la venta original', async () => {
    routes.set(chargePath, () => { throw new TypeError('lost reply') })
    routes.set(lookupPath, () => {
      const { saleId: _saleId, ...oldTransaction } = transaction()
      return Response.json({ transaction: oldTransaction })
    })
    expect((await start()).status).toBe('completed')
    expect(loadCashlogyIntent(scope)?.saleId).toBe('sale-1')
    expect(postCount()).toBe(1)
  })

  it('una recuperación simultánea comparte la consulta pendiente', async () => {
    routes.set(chargePath, () => { throw new TypeError('lost reply') })
    routes.set(lookupPath, () => Response.json({}, { status: 503 }))
    await expect(start()).rejects.toHaveProperty('code')
    let respond: ((response: Response) => void) | undefined
    routes.set(lookupPath, () => new Promise(resolve => { respond = resolve }))
    const before = calls.filter(call => call.path === lookupPath).length
    const first = useCashlogyStore.getState().recover()
    const second = useCashlogyStore.getState().recover()
    expect(calls.filter(call => call.path === lookupPath)).toHaveLength(before + 1)
    respond?.(lookupReply())
    expect((await first)?.id).toBe('tx-1')
    expect((await second)?.id).toBe('tx-1')
    expect(postCount()).toBe(1)
  })

  it('un 404 al recuperar no confirma ni reenvía el cobro', async () => {
    routes.set(chargePath, () => { throw new TypeError('lost reply') })
    routes.set(lookupPath, () => Response.json({}, { status: 404 }))
    await expect(start()).rejects.toHaveProperty('code')
    useCashlogyStore.getState().configureScope(scope)
    await expect(useCashlogyStore.getState().recover()).rejects.toMatchObject({ code: 'CASHLOGY_TRANSACTION_NOT_FOUND' })
    expect(useCashlogyStore.getState().missingTransaction).toBe(true)
    expect(useCashlogyStore.getState().isRecovering).toBe(false)
    expect(loadCashlogyIntent(scope)?.requestId).toBe(requestId)
    expect(postCount()).toBe(1)
  })

  it('cancela la admisión y conserva la cancelación aunque llegue tarde la respuesta del POST', async () => {
    let respond: ((response: Response) => void) | undefined
    routes.set(chargePath, () => new Promise(resolve => { respond = resolve }))
    routes.set(lookupPath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    routes.set(`${transactionPath}/cancel`, () => lookupReply(transaction({ status: 'cancelled' })))
    const payment = start().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    expect((await useCashlogyStore.getState().cancel())?.status).toBe('cancelled')
    respond?.(lookupReply())
    expect(await payment).toMatchObject({ code: 'CASHLOGY_OPERATION_CANCELLED' })
    expect(loadCashlogyIntent(scope)).toBeNull()
    expect(useCashlogyStore.getState().transaction).toBeNull()
    expect(useCashlogyStore.getState().modalOpen).toBe(false)
    expect(postCount()).toBe(1)
  })

  it('un error del agente al cancelar conserva el intento para revisar el efectivo', async () => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    const payment = start().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    routes.set(`${transactionPath}/cancel`, () => Response.json({}, { status: 503 }))
    await expect(useCashlogyStore.getState().cancel()).rejects.toHaveProperty('code')
    expect(await payment).toMatchObject({ code: 'CASHLOGY_OPERATION_CANCELLED' })
    expect(loadCashlogyIntent(scope)?.transactionId).toBe('tx-1')
    expect(useCashlogyStore.getState().isCancelling).toBe(false)
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    expect(postCount()).toBe(1)
  })

  it('el timeout de cancelación libera los controles sin borrar el intento', async () => {
    routes.set(chargePath, () => lookupReply(transaction({ status: 'waiting_for_cash' })))
    const payment = start().catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    routes.set(`${transactionPath}/cancel`, init => pendingReply(init.signal))
    const cancellation = useCashlogyStore.getState().cancel().catch(error => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await cancellation).toMatchObject({ cause: { code: 'TIMEOUT' } })
    expect(await payment).toMatchObject({ code: 'CASHLOGY_OPERATION_CANCELLED' })
    expect(loadCashlogyIntent(scope)?.transactionId).toBe('tx-1')
    expect(useCashlogyStore.getState().isCancelling).toBe(false)
    expect(calls.filter(call => call.path === `${transactionPath}/cancel`)).toHaveLength(1)
  })

  it('un conflicto del agente recupera el bloqueo anterior sin aplicarlo a la nueva venta', async () => {
    const blocker = transaction({ id: 'old-tx', requestId: 'old-request', saleId: 'old-sale' })
    routes.set(chargePath, () => Response.json({ error: { code: 'CASHLOGY_BUSY', details: { transactionId: 'old-tx' } } }, { status: 409 }))
    routes.set('/api/v1/cashlogy/transactions/old-tx', () => lookupReply(blocker))
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    expect(useCashlogyStore.getState().transaction?.saleId).toBe('old-sale')
    expect(loadCashlogyIntent(scope)).toMatchObject({ requestId: 'old-request', recoveredFromConflict: true })
    expect(postCount()).toBe(1)
  })

  it.each(['recover', 'cancel', 'retryPayment'] as const)('un bloqueo cuyo primer GET se pierde sigue resolviéndose tras recargar mediante %s', async action => {
    const blockerPath = '/api/v1/cashlogy/transactions/old-tx'
    const blocker = transaction({ id: 'old-tx', requestId: 'old-request', saleId: 'old-sale', requestedAmountCents: 600, netPaidCents: 600, automaticAcceptedCents: 600, returnedCents: 0 })
    routes.set(chargePath, () => Response.json({ error: { code: 'CASHLOGY_BUSY', details: { transactionId: 'old-tx' } } }, { status: 409 }))
    routes.set(blockerPath, () => Response.json({}, { status: 503 }))
    await expect(start()).rejects.toHaveProperty('code')
    expect(loadCashlogyIntent(scope)).toMatchObject({ requestId, transactionId: 'old-tx', recoveredFromConflict: true })
    useCashlogyStore.getState().configureScope(scope)
    routes.set(blockerPath, () => lookupReply({ ...blocker, status: action === 'cancel' ? 'waiting_for_cash' : 'completed' }))
    routes.set(`${blockerPath}/recover`, () => lookupReply(blocker))
    routes.set(`${blockerPath}/cancel`, () => lookupReply({ ...blocker, status: 'cancelled' }))
    routes.set(`${blockerPath}/acknowledge`, () => Response.json({ ok: true }))
    if (action === 'retryPayment') {
      await expect(useCashlogyStore.getState().retryPayment()).rejects.toMatchObject({ code: 'CASHLOGY_INVALID_STATE' })
      expect(loadCashlogyIntent(scope)).toMatchObject({ requestId: 'old-request', saleId: 'old-sale', amountCents: 600 })
    } else {
      const result = await useCashlogyStore.getState()[action]()
      expect(result).toMatchObject({ id: 'old-tx', saleId: 'old-sale', status: action === 'cancel' ? 'cancelled' : 'completed' })
      if (action === 'cancel') expect(loadCashlogyIntent(scope)).toBeNull()
      else expect(loadCashlogyIntent(scope)).toMatchObject({ requestId: 'old-request', saleId: 'old-sale', amountCents: 600 })
    }
    expect(postCount()).toBe(1)
  })

  it('dos pulsaciones simultáneas generan un solo cobro', async () => {
    const first = start()
    await expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_BUSY' })
    expect((await first).id).toBe('tx-1')
    expect(postCount()).toBe(1)
  })

  it.each([{ enabled: false }, { ok: false }, { sessionState: 'busy' }])('no cobra si la máquina no está preparada: %j', async patch => {
    routes.set('/api/v1/cashlogy/health', () => Response.json({ ...ready, ...patch }))
    await expect(start()).rejects.toHaveProperty('code')
    expect(postCount()).toBe(0)
    expect(loadCashlogyIntent(scope)?.chargeRequestedAt).toBeNull()
  })

  it.each([{ enabled: 'false' }, { ok: 'false' }])('rechaza indicadores de salud con tipos incoherentes: %j', async patch => {
    routes.set('/api/v1/cashlogy/health', () => Response.json({ ...ready, ...patch }))
    await expect(start()).rejects.toHaveProperty('code')
    expect(postCount()).toBe(0)
  })

  it('un fallo de lectura de niveles no impide completar un cobro válido', async () => {
    routes.set('/api/v1/cashlogy/accounting/levels', () => Response.json({}, { status: 503 }))
    expect((await start()).status).toBe('completed')
    expect(useCashlogyStore.getState().levels).toEqual([])
    expect(postCount()).toBe(1)
  })

  it('si health no responde, reintenta solo la consulta y no envía el cobro', async () => {
    routes.set('/api/v1/cashlogy/health', init => pendingReply(init.signal))
    const payment = start().catch(error => error)
    await vi.advanceTimersByTimeAsync(10250)
    expect(await payment).toMatchObject({ cause: { code: 'TIMEOUT' } })
    expect(postCount()).toBe(0)
    expect(loadCashlogyIntent(scope)?.chargeRequestedAt).toBeNull()
  })

  it.each(['tenantId', 'establishmentId', 'terminalId'] as const)('una respuesta tardía tras cambiar %s no contamina el nuevo ámbito', async key => {
    let respond!: (value: Response) => void
    routes.set(chargePath, () => new Promise(resolve => { respond = resolve }))
    const rejected = expect(start()).rejects.toMatchObject({ code: 'CASHLOGY_OPERATION_CANCELLED' })
    await vi.advanceTimersByTimeAsync(0)
    const nextScope = { ...scope, [key]: 'another' }
    useCashlogyStore.getState().configureScope(nextScope)
    respond(lookupReply())
    await rejected
    expect(useCashlogyStore.getState().intent).toBeNull()
    expect(useCashlogyStore.getState().transaction).toBeNull()
    expect(loadCashlogyIntent(scope)?.requestId).toBe(requestId)
    expect(loadCashlogyIntent(nextScope)).toBeNull()
  })
})

describe('cancelación HTTP', () => {
  it('un signal cancelado antes de iniciar impide enviar el POST', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createPrintAgentClient({ baseUrl: 'https://agent.test', token: 'test-token' })
    await expect(client.createCashlogyCharge({ requestId, amountCents: 1250, terminalCode: 'POS_MAIN' }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(postCount()).toBe(0)
  })

  it('abortar durante el backoff de GET impide cualquier reintento', async () => {
    routes.set(lookupPath, () => { throw new TypeError('offline') })
    const controller = new AbortController()
    const client = createPrintAgentClient({ baseUrl: 'https://agent.test', token: 'test-token' })
    const result = client.getCashlogyTransactionByRequestId(requestId, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(250)
    expect(await result).toMatchObject({ code: 'ABORTED' })
    expect(calls.filter(call => call.path === lookupPath)).toHaveLength(1)
  })
})
