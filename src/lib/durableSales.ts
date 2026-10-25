import { openLedger, request, transactionDone } from '../features/fiscal/local/localLedger.ts'
import type { OfflineEvent, SaleCreatedPayload, SessionTicketRecord, TenantContext } from '../types/index.ts'
import type { CashlogyIntent, CashlogyTransaction, PrintAgentScope } from '../features/local-printing/types.ts'
import { getAppRoute, type AppRoute } from '../app/app-routes.ts'

export type PaymentOperation = {
  key: string
  scope: string
  fingerprint: string
  payload: SaleCreatedPayload
  state: 'prepared' | 'charging' | 'accepted' | 'committed'
  cashlogy: CashlogyTransaction | null
  cashlogyRequestId?: string
  checkoutReserved?: boolean
  eventId: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}
type DurableSale = { id: string; scope: string; payload: SaleCreatedPayload }
type DurableEvent = OfflineEvent & { route: AppRoute }
let events: DurableEvent[] = []
export const cachedDurableEvents = () => events.filter(event => event.route === getAppRoute())
export function paymentScope(context: Pick<TenantContext, 'tenantId' | 'venueId' | 'deviceId' | 'userId'>, cashSessionId: string) {
  return `${getAppRoute()}:${context.tenantId}:${context.venueId}:${context.deviceId}:${context.userId}:${cashSessionId}`
}

/** Serializes the whole payment, including hardware and recovery, across tabs. */
export async function withPaymentLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new Error('El navegador no permite bloquear el cobro de forma segura. Actualiza el TPV antes de cobrar.')
  return navigator.locks.request(`tickit-payment:${key}`, { mode: 'exclusive' }, work)
}

export async function loadPaymentOperation(key: string): Promise<PaymentOperation | undefined> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readonly')
    const done = transactionDone(tx)
    const operation = await request(tx.objectStore('paymentOperations').get(key)) as PaymentOperation | undefined
    await done
    return operation
  } finally { db.close() }
}

export async function loadPaymentOperations(context: TenantContext, cashSessionId: string): Promise<PaymentOperation[]> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readonly')
    const done = transactionDone(tx)
    const stored = await request(tx.objectStore('paymentOperations').index('scope').getAll(paymentScope(context, cashSessionId))) as PaymentOperation[]
    await done
    return stored
  } finally { db.close() }
}

export async function loadPendingPaymentOperations(context: TenantContext, cashSessionId: string): Promise<PaymentOperation[]> {
  return (await loadPaymentOperations(context, cashSessionId)).filter(operation => operation.state === 'accepted' || operation.state === 'charging'
    || (operation.state === 'prepared' && operation.checkoutReserved))
}

export async function preparePaymentOperation(key: string, fingerprint: string, payload: SaleCreatedPayload, params?: Record<string, unknown>): Promise<PaymentOperation> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const scope = key.split('|')[0]
    const operations = await request(store.index('scope').getAll(scope)) as PaymentOperation[]
    // Pending work belongs to its ticket, not to the entire register. Different
    // tickets can proceed while their predecessors remain available for recovery.
    // Preserve duplicate protection when another caller supplies a different key.
    const sourceIds = params?.sourceLineIds
    const quickSale = key.startsWith(`${scope}|quick-sale:`) || key === `${scope}|quick-sale`
    const overlapping = quickSale && Array.isArray(sourceIds) ? operations.find(operation => {
      const previousIds = operation.params?.sourceLineIds
      return operation.key !== key
        && (operation.key.startsWith(`${scope}|quick-sale:`) || operation.key === `${scope}|quick-sale`)
        && Array.isArray(previousIds) && sourceIds.some(id => previousIds.includes(id))
    }) : undefined
    if (overlapping) { await done; return overlapping }
    if (operations.some(operation => operation.key !== key
      && (operation.payload.sale.id === payload.sale.id || operation.payload.ticket.id === payload.ticket.id))) {
      tx.abort()
      throw new Error('Este ticket ya tiene una operación de cobro. Recupera su resultado original para evitar cobrarlo dos veces.')
    }
    const previous = await request(store.get(key)) as PaymentOperation | undefined
    // A reload may interrupt preparation before any external side effect. Such a
    // draft can follow ticket edits; reservations and collection evidence must
    // retain their original identity even if an older journal says prepared.
    const replaceablePreparation = previous?.state === 'prepared'
      && !previous.checkoutReserved && !previous.cashlogyRequestId && !previous.cashlogy
      && !previous.payload.payment?.cashlogyRequestId && !previous.payload.payment?.cashlogyTransactionId
      && !previous.payload.localFiscal && !previous.result
    if (previous && previous.fingerprint !== fingerprint && previous.state !== 'committed' && !replaceablePreparation) {
      tx.abort()
      throw new Error('Hay un cobro pendiente de registrar. Recupera la operación original antes de cambiar el ticket o volver a cobrar.')
    }
    const previousIds = previous?.params?.sourceLineIds
    const containsPaidLines = previous?.state === 'committed' && Array.isArray(sourceIds) && Array.isArray(previousIds)
      && sourceIds.some(id => previousIds.includes(id))
    if (previous && (previous.fingerprint === fingerprint || containsPaidLines)) { await done; return previous }
    const operation: PaymentOperation = { key, scope, fingerprint, payload: structuredClone(payload), params: params ? structuredClone(params) : undefined, state: 'prepared', cashlogy: null, eventId: crypto.randomUUID() }
    store.put(operation)
    await done
    return operation
  } finally { db.close() }
}

export async function acceptPaymentOperation(operation: PaymentOperation, payload: SaleCreatedPayload, cashlogy: CashlogyTransaction | null): Promise<PaymentOperation> {
  const accepted: PaymentOperation = { ...operation, payload: structuredClone(payload), cashlogy, state: 'accepted' }
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('paymentOperations').put(accepted)
    await done
    return accepted
  } finally { db.close() }
}

export async function markPaymentCharging(operation: PaymentOperation): Promise<PaymentOperation> {
  const charging: PaymentOperation = { ...operation, state: 'charging', cashlogyRequestId: operation.cashlogyRequestId ?? `cashlogy:sale:${operation.payload.sale.id}` }
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('paymentOperations').put(charging)
    await done
    return charging
  } finally { db.close() }
}

/** Additive metadata: a prepared restaurant payment may own a server reservation
 * even if the response was lost, before any hardware collection was started. */
export async function markRestaurantCheckoutReserved(operation: PaymentOperation): Promise<PaymentOperation> {
  const reserved = { ...operation, checkoutReserved: true }
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('paymentOperations').put(reserved)
    await done
    return reserved
  } finally { db.close() }
}

/** The hardware buttons own explicit cancellation/restart of an attempt. Keep
 * their request identity in the same journal used by economic recovery. */
export async function updateCashlogyPaymentAttempt(intent: CashlogyIntent, scope: PrintAgentScope | null,
  action: { type: 'start' } | { type: 'close'; transaction: CashlogyTransaction | null; receivedCents: number | null; changeCents: number | null }): Promise<void> {
  if (!intent.paymentOperationKey) return // Older clients and payment-method changes have no sale journal.
  if (action.type === 'close' && action.transaction?.status !== 'completed') {
    const pending = await loadPaymentOperation(intent.paymentOperationKey)
    if (pending?.checkoutReserved && pending.state !== 'accepted' && pending.state !== 'committed') {
      const prefix = scope ? `${getAppRoute()}:${scope.tenantId}:${scope.establishmentId}:${scope.terminalId}:` : null
      if (!scope || !prefix || !pending.scope.startsWith(prefix)
        || (pending.cashlogyRequestId ?? `cashlogy:sale:${pending.payload.sale.id}`) !== intent.requestId) {
        throw new Error('El intento cancelado no coincide con el cobro pendiente.')
      }
      // Do network work before opening an IndexedDB transaction. If cancellation
      // cannot be confirmed remotely, retain the journal and hardware identity.
      const { cancelRestaurantCheckout } = await import('../features/restaurant/services/checkout.ts')
      await cancelRestaurantCheckout(pending.eventId, scope.terminalId)
    }
  }
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const operation = await request(store.get(intent.paymentOperationKey)) as PaymentOperation | undefined
    const scopePrefix = scope ? `${getAppRoute()}:${scope.tenantId}:${scope.establishmentId}:${scope.terminalId}:` : null
    if (!scopePrefix || !intent.paymentOperationKey.startsWith(scopePrefix)
      || (operation && ((operation.state !== 'committed' && operation.payload.sale.id !== intent.saleId) || !operation.scope.startsWith(scopePrefix)))) {
      tx.abort()
      throw new Error('No se ha podido identificar el registro local del cobro original.')
    }
    // Retrying a close after localStorage/acknowledgement failure is harmless.
    if (!operation && action.type === 'close') { await done; return }
    if (!operation) {
      tx.abort()
      throw new Error('Falta el registro local del cobro original.')
    }
    if (action.type === 'start') {
      if (operation.state === 'accepted' || operation.state === 'committed') {
        tx.abort()
        throw new Error('Este cobro ya está aceptado. Recupera la venta antes de iniciar otro cobro.')
      }
      store.put({ ...operation, state: 'charging', cashlogyRequestId: intent.requestId } satisfies PaymentOperation)
    } else if (operation.state !== 'accepted' && operation.state !== 'committed') {
      if ((operation.cashlogyRequestId ?? `cashlogy:sale:${operation.payload.sale.id}`) !== intent.requestId
        && intent.chargeRequestedAt !== null) {
        tx.abort()
        throw new Error('El intento cancelado no coincide con el cobro pendiente.')
      }
      if (action.transaction?.status === 'completed') {
        if (action.transaction.requestId !== intent.requestId || action.transaction.requestedAmountCents !== operation.payload.sale.totalCents
          || (action.transaction.saleId && action.transaction.saleId !== intent.saleId)) {
          tx.abort()
          throw new Error('El cobro confirmado no coincide con la venta original.')
        }
        // Closing the modal is not a refund: retain the confirmed money before
        // acknowledging/deleting the agent's transaction.
        const payment = operation.payload.payment
        store.put({ ...operation, state: 'accepted', cashlogy: action.transaction,
          payload: { ...operation.payload, payment: payment ? { ...payment,
            receivedCents: action.receivedCents, changeCents: action.changeCents ?? 0,
            cashlogyRequestId: action.transaction.requestId, cashlogyTransactionId: action.transaction.id } : null } } satisfies PaymentOperation)
      } else store.delete(operation.key)
    }
    await done
  } finally { db.close() }
}

/** Only call before starting hardware or submitting a payment RPC. */
export async function discardPreparedPaymentOperation(key: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const operation = await request(store.get(key)) as PaymentOperation | undefined
    if (operation?.state === 'prepared') store.delete(key)
    await done
  } finally { db.close() }
}

/** Sale, payment, stable identity and pending event commit together. Fiscal sales
 * already commit the economic snapshot and immutable invoice in the SIF ledger. */
export async function commitPaymentOperation(operation: PaymentOperation, payload: SaleCreatedPayload, enqueue: boolean, result?: Record<string, unknown>): Promise<void> {
  const intermediateSplit = result?.singleTicket === true && result.completed === false
  if (enqueue && intermediateSplit) throw new Error('Un subpago pendiente no puede encolar una venta.')
  const route = operation.scope.split(':')[0]
  if (route !== 'pos' && route !== 'crm' && route !== 'superadmin') throw new Error('Falta el ámbito de aplicación del cobro original.')
  const db = await openLedger()
  try {
    const tx = db.transaction(['paymentOperations', 'durableSales', 'durableEvents'], 'readwrite')
    const done = transactionDone(tx)
    if (!intermediateSplit) tx.objectStore('durableSales').put({ id: payload.sale.id, scope: operation.key.split('|')[0], payload: structuredClone(payload) } satisfies DurableSale)
    tx.objectStore('paymentOperations').put({ ...operation, payload, result, state: 'committed' } satisfies PaymentOperation)
    if (enqueue) tx.objectStore('durableEvents').put({ id: operation.eventId, kind: 'sale_created', tenantId: payload.sale.tenantId,
      route, createdAt: payload.sale.createdAt, schemaVersion: 1, attempts: 0, payload: structuredClone(payload) } satisfies DurableEvent)
    await done
  } finally { db.close() }
  if (enqueue) events = [...events.filter(event => event.id !== operation.eventId), { id: operation.eventId, kind: 'sale_created',
    route, tenantId: payload.sale.tenantId, createdAt: payload.sale.createdAt, schemaVersion: 1, attempts: 0, payload: structuredClone(payload) }]
}

export async function loadDurableEvents(): Promise<OfflineEvent[]> {
  const db = await openLedger()
  try {
    const tx = db.transaction('durableEvents', 'readonly')
    const done = transactionDone(tx)
    const stored = await request(tx.objectStore('durableEvents').index('route').getAll(getAppRoute())) as DurableEvent[]
    await done
    events = stored
    return stored
  } finally { db.close() }
}

export async function updateDurableEvent(id: string, error?: string): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('durableEvents', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('durableEvents')
    const event = await request(store.get(id)) as DurableEvent | undefined
    if (event && event.route !== getAppRoute()) throw new Error('La operación pendiente pertenece a otra aplicación.')
    if (event) {
      if (error !== undefined) store.put({ ...event, attempts: event.attempts + 1, lastError: error })
      else store.delete(id)
    }
    await done
    events = error !== undefined ? events.map(e => e.id === id && event ? { ...event, attempts: event.attempts + 1, lastError: error } : e)
      : events.filter(e => e.id !== id)
  } finally { db.close() }
}

export async function loadDurableSessionTickets(context: TenantContext, cashSessionId: string): Promise<SessionTicketRecord[]> {
  const db = await openLedger()
  try {
    const tx = db.transaction('durableSales', 'readonly')
    const done = transactionDone(tx)
    const sales = await request(tx.objectStore('durableSales').index('scope').getAll(paymentScope(context, cashSessionId))) as DurableSale[]
    await done
    return sales.map(({ payload }) => ({ id: payload.sale.id, cashSessionId, ticketNumber: payload.ticket.ticketNumber,
      paymentMethod: payload.sale.paymentMethod, totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt,
      status: 'active', payload, printStatus: 'not_requested', printAttempts: 0 }))
  } finally { db.close() }
}
