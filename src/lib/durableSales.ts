import { openLedger, request, transactionDone } from './localDatabase.ts'
import type { OfflineEvent, PaymentMethod, SaleCreatedPayload, SessionTicketRecord, TenantContext } from '../types/index.ts'
import type { CashlogyIntent, CashlogyTransaction, PrintAgentScope } from '../features/local-printing/types.ts'
import { getAppRoute, type AppRoute } from '../app/app-routes.ts'

export type PaymentOperation = {
  key: string
  scope: string
  fingerprint: string
  payload: SaleCreatedPayload
  state: 'prepared' | 'charging' | 'accepted' | 'committed' | 'cancelled'
  originalKey?: string
  cancelledAt?: string
  checkoutCancellationPending?: boolean
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

export async function finishPaymentOperationCancellation(operation: PaymentOperation): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const current = await request(store.get(operation.key)) as PaymentOperation | undefined
    if (current?.eventId === operation.eventId && current.state === 'cancelled') store.put({ ...current, checkoutCancellationPending: false })
    await done
  } finally { db.close() }
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
      return operation.state !== 'cancelled' && operation.key !== key
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
    await assertPaymentOperationActive(tx.objectStore('paymentOperations'), operation)
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
    await assertPaymentOperationActive(tx.objectStore('paymentOperations'), operation)
    tx.objectStore('paymentOperations').put(charging)
    await done
    return charging
  } finally { db.close() }
}

async function assertPaymentOperationActive(store: IDBObjectStore, operation: PaymentOperation) {
  // Reconciliation may restore a server-committed sale from its cancellation
  // archive. Late completions still carry the original live operation key.
  if (operation.state === 'cancelled' && operation.key === `${operation.scope}|cancelled:${operation.eventId}`) return
  if (await request(store.get(`${operation.scope}|cancelled:${operation.eventId}`))) {
    store.transaction.abort()
    throw new Error('Este intento de cobro se ha cancelado.')
  }
}

function hasIssuedEconomicSale(store: IDBObjectStore, saleId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const cursor = store.openCursor()
    cursor.onerror = () => reject(cursor.error)
    cursor.onsuccess = () => {
      const row = cursor.result
      if (!row) { resolve(false); return }
      const sale = row.value as { payload: SaleCreatedPayload }
      if (sale.payload.sale.id === saleId) resolve(true)
      else row.continue()
    }
  })
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
  action: { type: 'start' } | { type: 'cancel' } | { type: 'close'; transaction: CashlogyTransaction | null; receivedCents: number | null; changeCents: number | null }): Promise<void> {
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
    const tx = db.transaction(['paymentOperations', 'economicSales'], 'readwrite')
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
    if (action.type === 'cancel') {
      if (operation.state === 'committed') {
        tx.abort()
        throw new Error('La venta ya está registrada. Reintenta para completar el cobro.')
      }
      if (operation.params?.paymentChange !== true && await hasIssuedEconomicSale(tx.objectStore('economicSales'), operation.payload.sale.id)) {
        tx.abort()
        throw new Error('La venta ya está registrada. Reintenta para completar el cobro.')
      }
      if ((operation.cashlogyRequestId ?? `cashlogy:sale:${operation.payload.sale.id}`) !== intent.requestId
        && intent.chargeRequestedAt !== null) {
        tx.abort()
        throw new Error('El intento cancelado no coincide con el cobro pendiente.')
      }
      store.put({ ...operation, key: `${operation.scope}|cancelled:${operation.eventId}`, originalKey: operation.key,
        state: 'cancelled', cancelledAt: new Date().toISOString(), checkoutCancellationPending: operation.checkoutReserved === true } satisfies PaymentOperation)
      store.delete(operation.key)
    } else if (action.type === 'start') {
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
        const cashAmountCents = (operation.payload.payments ?? (operation.payload.payment ? [operation.payload.payment] : []))
          .find(payment => payment.method === 'cash')?.amountCents ?? Number(operation.params?.amountCents ?? operation.payload.sale.totalCents)
        if (action.transaction.requestId !== intent.requestId || action.transaction.requestedAmountCents !== cashAmountCents
          || (action.transaction.saleId && action.transaction.saleId !== intent.saleId)) {
          tx.abort()
          throw new Error('El cobro confirmado no coincide con la venta original.')
        }
        // Closing the modal is not a refund: retain the confirmed money before
        // acknowledging/deleting the agent's transaction.
        const payment = operation.payload.payment
        const confirmed = action.transaction
        const withCashlogy = (value: NonNullable<SaleCreatedPayload['payment']>) => ({ ...value,
          receivedCents: action.receivedCents, changeCents: action.changeCents ?? 0,
          cashlogyRequestId: confirmed.requestId, cashlogyTransactionId: confirmed.id })
        store.put({ ...operation, state: 'accepted', cashlogy: action.transaction,
          payload: { ...operation.payload, payment: payment ? withCashlogy(payment) : null,
            ...(operation.payload.payments ? { payments: operation.payload.payments.map(value => value.method === 'cash' ? withCashlogy(value) : value) } : {}) } } satisfies PaymentOperation)
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
    await assertPaymentOperationActive(tx.objectStore('paymentOperations'), operation)
    if (!intermediateSplit) tx.objectStore('durableSales').put({ id: payload.sale.id, scope: operation.key.split('|')[0], payload: structuredClone(payload) } satisfies DurableSale)
    tx.objectStore('paymentOperations').put({ ...operation, payload, result, state: 'committed' } satisfies PaymentOperation)
    if (enqueue) tx.objectStore('durableEvents').put({ id: operation.eventId, kind: 'sale_created', tenantId: payload.sale.tenantId,
      route, createdAt: payload.sale.createdAt, schemaVersion: 1, attempts: 0, payload: structuredClone(payload) } satisfies DurableEvent)
    await done
  } finally { db.close() }
  if (enqueue) events = [...events.filter(event => event.id !== operation.eventId), { id: operation.eventId, kind: 'sale_created',
    route, tenantId: payload.sale.tenantId, createdAt: payload.sale.createdAt, schemaVersion: 1, attempts: 0, payload: structuredClone(payload) }]
}

/** Payment changes reuse the existing journal/stores, retaining their own event
 * identity independently from the immutable original sale-created event. */
export async function preparePaymentChangeOperation(context: TenantContext, ticket: SessionTicketRecord, method: PaymentMethod): Promise<PaymentOperation> {
  if (ticket.payload.ticket.tenantId !== context.tenantId || ticket.payload.sale.tenantId !== context.tenantId
    || ticket.payload.ticket.venueId !== context.venueId || ticket.payload.ticket.cashSessionId !== ticket.cashSessionId
    || ticket.payload.sale.id !== ticket.id || ticket.payload.payment?.saleId !== ticket.id) {
    throw new Error('El ticket no pertenece al ámbito del cambio de cobro.')
  }
  const scope = paymentScope(context, ticket.cashSessionId)
  const key = `${scope}|payment-change:${ticket.id}`
  const fingerprint = JSON.stringify({ payment: ticket.payload.payment, method })
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const previous = await request(store.get(key)) as PaymentOperation | undefined
    if (previous && (previous.state !== 'committed' || previous.result?.paymentProjectionPending
      || (previous.fingerprint === fingerprint && !previous.result?.remotePaymentObserved))) {
      if (previous.payload.sale.paymentMethod !== method) {
        tx.abort()
        throw new Error('Recupera el cambio de cobro pendiente antes de cambiar otra vez su forma de pago.')
      }
      await done
      return previous
    }
    const eventId = crypto.randomUUID()
    const payload = structuredClone(ticket.payload)
    payload.sale.paymentMethod = method
    if (payload.payment) payload.payment.method = method
    const operation: PaymentOperation = { key, scope, fingerprint, payload, state: 'prepared', cashlogy: null, eventId,
      cashlogyRequestId: `cashlogy:payment-change:${eventId}`,
      params: { paymentChange: true, changedAt: new Date().toISOString(), sourceMethod: ticket.paymentMethod } }
    store.put(operation)
    await done
    return operation
  } finally { db.close() }
}

export async function commitPaymentChangeOperation(operation: PaymentOperation): Promise<void> {
  const payload = operation.payload
  if (!payload.payment || operation.params?.paymentChange !== true) throw new Error('Falta el pago original del cambio de cobro.')
  const route = operation.scope.split(':')[0]
  if (route !== 'pos' && route !== 'crm' && route !== 'superadmin') throw new Error('Falta el ámbito original del cambio de cobro.')
  const event: DurableEvent = { id: operation.eventId, kind: 'sale_payment_changed', route,
    tenantId: payload.sale.tenantId, createdAt: String(operation.params.changedAt), attempts: 0, schemaVersion: 1,
    payload: { saleId: payload.sale.id, paymentId: payload.payment.id, paymentMethod: payload.payment.method,
      receivedCents: payload.payment.receivedCents, changeCents: payload.payment.changeCents,
      cashlogyRequestId: payload.payment.cashlogyRequestId ?? null, cashlogyTransactionId: payload.payment.cashlogyTransactionId ?? null } }
  const db = await openLedger()
  try {
    const tx = db.transaction(['paymentOperations', 'durableSales', 'durableEvents'], 'readwrite')
    const done = transactionDone(tx)
    await assertPaymentOperationActive(tx.objectStore('paymentOperations'), operation)
    tx.objectStore('durableSales').put({ id: payload.sale.id, scope: operation.scope, payload } satisfies DurableSale)
    tx.objectStore('durableEvents').put(event)
    tx.objectStore('paymentOperations').put({ ...operation, state: 'committed', result: { paymentProjectionPending: true } } satisfies PaymentOperation)
    await done
  } finally { db.close() }
  events = [...events.filter(existing => existing.id !== event.id), event]
}

export async function completePaymentChangeProjection(operation: PaymentOperation): Promise<void> {
  const db = await openLedger()
  try {
    const tx = db.transaction('paymentOperations', 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    const current = await request(store.get(operation.key)) as PaymentOperation | undefined
    if (current?.eventId === operation.eventId && current.state === 'committed') {
      store.put({ ...current, result: { ...current.result, paymentProjectionPending: false } } satisfies PaymentOperation)
    }
    await done
  } finally { db.close() }
}

/** Only observations whose request began after this mutation was acknowledged
 * can release its stale-click protection for a later change made elsewhere. */
export async function observeRemotePaymentChanges(settledAtRead: PaymentOperation[], tickets: SessionTicketRecord[]): Promise<void> {
  if (!settledAtRead.length) return
  const bySale = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const db = await openLedger()
  try {
    const tx = db.transaction(['paymentOperations', 'durableEvents'], 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore('paymentOperations')
    for (const original of settledAtRead) {
      const remote = bySale.get(original.payload.sale.id)
      if (!remote || remote.payload.ticket.tenantId !== original.payload.ticket.tenantId
        || remote.payload.ticket.venueId !== original.payload.ticket.venueId || remote.cashSessionId !== original.payload.ticket.cashSessionId
        || remote.paymentMethod === original.payload.sale.paymentMethod) continue
      const current = await request(store.get(original.key)) as PaymentOperation | undefined
      if (current?.eventId !== original.eventId || current.state !== 'committed' || current.result?.paymentProjectionPending) continue
      if (await request(tx.objectStore('durableEvents').get(current.eventId))) continue
      store.put({ ...current, result: { ...current.result, remotePaymentObserved: true } } satisfies PaymentOperation)
    }
    await done
  } finally { db.close() }
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
