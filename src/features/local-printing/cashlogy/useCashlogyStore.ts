import { reportOperationError, operationBreadcrumb } from '../../../lib/observability.ts'
import { create } from 'zustand'
import { createPrintAgentClient } from '../api/printAgentClient'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { CashlogyHealth, CashlogyIntent, CashlogyLevel, CashlogyTransaction, PrintAgentScope } from '../types'
import { CashlogyError, getBlockingCashlogyTransactionId, isMissingCashlogyTransaction, isUncertainCashlogyError, toCashlogyError } from './cashlogyError'
import { createCashlogyRequestId } from './cashlogyRequestId'
import { cashlogyAcknowledgements } from './cashlogyAcknowledgements'
import {
  cashlogyActiveStatuses,
  cashlogyCancellableStatuses,
  pollCashlogyTransaction,
} from './cashlogyPolling'
import { loadCashlogyIntent, loadCashlogyManagementIntent, saveCashlogyIntent } from './cashlogyStorage'

type CashlogyState = {
  scope: PrintAgentScope | null
  intent: CashlogyIntent | null
  transaction: CashlogyTransaction | null
  levels: CashlogyLevel[]
  error: CashlogyError | null
  modalOpen: boolean
  isCheckingHealth: boolean
  isStarting: boolean
  isPolling: boolean
  isCancelling: boolean
  isRecovering: boolean
  missingTransaction: boolean
  configureScope: (scope: PrintAgentScope) => void
  checkHealth: (signal?: AbortSignal) => Promise<CashlogyHealth>
  startPayment: (amountCents: number, saleId?: string | null, signal?: AbortSignal) => Promise<CashlogyTransaction>
  recover: (signal?: AbortSignal) => Promise<CashlogyTransaction | null>
  cancel: (reviewed?: boolean) => Promise<CashlogyTransaction | null>
  retryPayment: (reviewed?: boolean) => Promise<CashlogyTransaction>
  finish: (requestId: string) => void
  discardForRetry: () => void
  closeReviewed: () => void
  hide: () => void
  show: () => void
  clearError: () => void
}

let settlementPromise: Promise<CashlogyTransaction> | null = null
let recoveryPromise: Promise<CashlogyTransaction | null> | null = null
let transactionPollingPromise: Promise<CashlogyTransaction> | null = null
let transactionPollingController: AbortController | null = null
let paymentController: AbortController | null = null
let paymentGeneration = 0

function assertCurrentPayment(generation: number) {
  if (generation !== paymentGeneration) throw new CashlogyError({ code: 'CASHLOGY_OPERATION_CANCELLED' })
}

function stopPaymentRequests() {
  paymentGeneration += 1
  paymentController?.abort()
  transactionPollingController?.abort()
  settlementPromise = null
  recoveryPromise = null
  transactionPollingPromise = null
  transactionPollingController = null
}

async function findPaymentTransaction(intent: CashlogyIntent, signal?: AbortSignal) {
  try {
    return (intent.recoveredFromConflict && intent.transactionId
      ? await client().getCashlogyTransaction(intent.transactionId, signal)
      : await client().getCashlogyTransactionByRequestId(intent.requestId, signal)).transaction
  } catch (error) {
    if (!isMissingCashlogyTransaction(error)) throw error
    return null
  }
}

function releasePayment(reviewed = false) {
  const flush = acknowledgeClosed(useCashlogyStore.getState().transaction, reviewed)
  persistIntent(null)
  useCashlogyStore.setState({ intent: null, transaction: null, levels: [], error: null, modalOpen: false,
    isStarting: false, isPolling: false, isCheckingHealth: false, isRecovering: false, missingTransaction: false })
  flush?.()
}

function client() {
  const print = usePrintAgentStore.getState()
  return createPrintAgentClient({ baseUrl: print.baseUrl, token: print.token })
}

function persistIntent(intent: CashlogyIntent | null) {
  const scope = useCashlogyStore.getState().scope
  if (scope) saveCashlogyIntent(scope, intent)
}

function adoptBlockingTransaction(transaction: CashlogyTransaction) {
  const intent: CashlogyIntent = {
    requestId: transaction.requestId, transactionId: transaction.id,
    saleId: transaction.saleId, amountCents: transaction.requestedAmountCents,
    terminalCode: transaction.terminalCode, createdAt: transaction.createdAt,
    chargeRequestedAt: transaction.startedAt ?? transaction.createdAt,
    recoveredFromConflict: true,
  }
  persistIntent(intent)
  useCashlogyStore.setState({ intent, transaction, modalOpen: true, error: null })
}

async function openBlockingTransaction(id: string, signal?: AbortSignal) {
  const generation = paymentGeneration
  const intent = useCashlogyStore.getState().intent
  if (intent) {
    // Save the blocker before the GET: another outage must not lose its identity.
    const pending = { ...intent, transactionId: id, recoveredFromConflict: true }
    persistIntent(pending)
    useCashlogyStore.setState({ intent: pending })
  }
  const { transaction } = await client().getCashlogyTransaction(id, signal)
  assertCurrentPayment(generation)
  adoptBlockingTransaction(transaction)
}

function acknowledgeClosed(transaction: CashlogyTransaction | null, reviewed = false) {
  const scope = useCashlogyStore.getState().scope
  if (!scope || !transaction) return
  const queue = cashlogyAcknowledgements(scope, usePrintAgentStore.getState().baseUrl)
  queue.add(transaction.id, reviewed)
  const acknowledge = client().acknowledgeCashlogyTransaction
  return () => { void queue.flush(acknowledge).catch(() => undefined) }
}

async function getRecoverableTransaction(id: string, signal?: AbortSignal) {
  const response = await client().getCashlogyTransaction(id, signal)
  return response.transaction.warning?.code === 'CASHLOGY_RECOVERY_PENDING'
    ? client().recoverCashlogyTransaction(id, signal)
    : response
}

function pollTransaction(transaction: CashlogyTransaction, signal?: AbortSignal, timeoutMs?: number) {
  if (!cashlogyActiveStatuses.has(transaction.status)) return Promise.resolve(transaction)
  if (transactionPollingPromise) return transactionPollingPromise
  const generation = paymentGeneration
  transactionPollingController = new AbortController()
  const pollingSignal = signal
    ? AbortSignal.any([signal, transactionPollingController.signal])
    : transactionPollingController.signal
  transactionPollingPromise = pollCashlogyTransaction(getRecoverableTransaction, transaction, {
    signal: pollingSignal,
    timeoutMs,
    onUpdate: (next) => {
      assertCurrentPayment(generation)
      useCashlogyStore.setState({ transaction: next })
    },
  }).finally(() => {
    if (generation !== paymentGeneration) return
    transactionPollingPromise = null
    transactionPollingController = null
  })
  return transactionPollingPromise
}

function terminalError(transaction: CashlogyTransaction) {
  if (transaction.status === 'cancelled') return new CashlogyError({ code: 'CASHLOGY_OPERATION_CANCELLED' })
  if (transaction.status === 'unknown') return new CashlogyError({
    code: 'CASHLOGY_STATUS_UNKNOWN',
    originalCode: transaction.normalizedErrorCode ?? transaction.error?.code,
    details: transaction,
  })
  if (transaction.status === 'needs_attention') return new CashlogyError({
    code: 'CASHLOGY_RECONCILIATION_MISMATCH',
    originalCode: transaction.normalizedErrorCode ?? transaction.error?.code,
    details: transaction,
  })
  return new CashlogyError({
    code: 'CASHLOGY_INVALID_STATE',
    message: 'Cashlogy ha confirmado que el cobro ha fallado.',
    originalCode: transaction.normalizedErrorCode ?? transaction.error?.code,
    details: transaction,
  })
}

async function resolveTransaction(transaction: CashlogyTransaction, signal?: AbortSignal) {
  const generation = paymentGeneration
  useCashlogyStore.setState({ transaction, isPolling: cashlogyActiveStatuses.has(transaction.status), modalOpen: true })
  try {
    const terminal = await pollTransaction(transaction, signal)
    assertCurrentPayment(generation)
    useCashlogyStore.setState({ transaction: terminal, isPolling: false })
    if (terminal.status !== 'completed') {
      const error = terminalError(terminal)
      useCashlogyStore.setState({ error })
      throw error
    }
    return terminal
  } catch (error) {
    assertCurrentPayment(generation)
    const state = useCashlogyStore.getState()
    reportOperationError(error, { operation: 'cashlogy.payment', integration: 'cashlogy', operationId: state.intent?.requestId, saleId: state.intent?.saleId, step: state.transaction?.status ?? (state.intent?.chargeRequestedAt ? 'charge_requested' : 'health') })
    const mapped = toCashlogyError(error)
    useCashlogyStore.setState({ error: mapped, isPolling: false })
    throw mapped
  }
}

export const useCashlogyStore = create<CashlogyState>((set, get) => ({
  scope: null,
  intent: null,
  transaction: null,
  levels: [],
  error: null,
  modalOpen: false,
  isCheckingHealth: false,
  isStarting: false,
  isPolling: false,
  isCancelling: false,
  isRecovering: false,
  missingTransaction: false,

  configureScope(scope) {
    stopPaymentRequests()
    transactionPollingController?.abort()
    settlementPromise = null
    recoveryPromise = null
    transactionPollingPromise = null
    let intent = loadCashlogyIntent(scope)
    const acknowledgements = cashlogyAcknowledgements(scope, usePrintAgentStore.getState().baseUrl)
    // A crash after enqueuing the close but before clearing the intent must not
    // resurrect a settled payment while its backend record is being deleted.
    if (intent?.transactionId && acknowledgements.contains(intent.transactionId)) {
      saveCashlogyIntent(scope, null)
      intent = null
    }
    void acknowledgements.flush(client().acknowledgeCashlogyTransaction).catch(() => undefined)
    const interruptedBeforeRequest = intent?.chargeRequestedAt === null
    set({
      scope,
      intent,
      transaction: null,
      levels: [],
      error: interruptedBeforeRequest
        ? new CashlogyError({
            code: 'CASHLOGY_INVALID_STATE',
            message: 'El inicio anterior se interrumpió antes de enviar el cobro a Cashlogy. Puedes volver al pago con seguridad.',
          })
        : null,
      // Pending charges recover in the background until the backend answers.
      modalOpen: Boolean(interruptedBeforeRequest),
      isCheckingHealth: false,
      isStarting: false,
      isPolling: false,
      isCancelling: false,
      isRecovering: false,
      missingTransaction: false,
    })
  },

  async checkHealth(signal) {
    const generation = paymentGeneration
    set({ isCheckingHealth: true })
    try {
      const health = await usePrintAgentStore.getState().checkCashlogyHealth(signal)
      return health
    } catch (error) {
      assertCurrentPayment(generation)
      const state = useCashlogyStore.getState()
      reportOperationError(error, { operation: 'cashlogy.payment', integration: 'cashlogy', operationId: state.intent?.requestId, saleId: state.intent?.saleId, step: state.transaction?.status ?? (state.intent?.chargeRequestedAt ? 'charge_requested' : 'health') })
      const mapped = toCashlogyError(error)
      set({ error: mapped })
      throw mapped
    } finally {
      if (generation === paymentGeneration) set({ isCheckingHealth: false })
    }
  },

  async startPayment(amountCents, saleId = null, signal) {
    const scope = get().scope
    if (scope) await cashlogyAcknowledgements(scope, usePrintAgentStore.getState().baseUrl)
      .flush(client().acknowledgeCashlogyTransaction).catch(() => undefined)
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'El importe del cobro Cashlogy no es válido.' })
    }
    const print = usePrintAgentStore.getState()
    if (!print.cashlogyConfigured) {
      throw new CashlogyError({ code: 'CASHLOGY_NOT_CONFIGURED' })
    }
    if (get().scope && loadCashlogyManagementIntent(get().scope!)) {
      throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'Hay una operación de efectivo Cashlogy pendiente de resolución.' })
    }
    const existing = get().intent
    if (existing) {
      set({ modalOpen: true })
      throw new CashlogyError({
        code: 'CASHLOGY_BUSY',
        message: existing.amountCents === amountCents
          ? 'Este cobro Cashlogy ya está en curso. Revisa la operación abierta.'
          : 'Hay otro cobro Cashlogy pendiente de resolución.',
      })
    }

    if (get().isStarting || get().isPolling || get().isCancelling) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    const generation = ++paymentGeneration
    paymentController = new AbortController()
    signal = signal ? AbortSignal.any([signal, paymentController.signal]) : paymentController.signal
    const intent: CashlogyIntent = {
      requestId: createCashlogyRequestId('payment'),
      saleId,
      amountCents,
      terminalCode: print.cashlogyTerminalCode,
      transactionId: null,
      chargeRequestedAt: null,
      createdAt: new Date().toISOString(),
    }
    operationBreadcrumb({ operation: 'cashlogy.payment', operationId: intent.requestId, saleId, step: 'intent' })
    persistIntent(intent)
    set({ intent, transaction: null, levels: [], error: null, modalOpen: true, isStarting: true, missingTransaction: false })
    settlementPromise = (async () => {
      try {
        const health: CashlogyHealth = await get().checkHealth(signal)
        assertCurrentPayment(generation)
        if (health.activeTransaction) {
          await openBlockingTransaction(health.activeTransaction.id, signal)
          throw new CashlogyError({ code: 'CASHLOGY_BUSY', message: 'Se ha recuperado una operación anterior. Resuélvela antes de iniciar este cobro.' })
        }
        if (!(health.enabled && health.ok && health.sessionState === 'ready')) {
          throw new CashlogyError({
            code: health.enabled ? 'CASHLOGY_NOT_READY' : 'CASHLOGY_DISABLED',
            originalCode: health.lastError?.code,
            details: health,
          })
        }

        try {
          const result = await client().getCashlogyLevels(signal)
          assertCurrentPayment(generation)
          set({ levels: result.levels })
        } catch {
          assertCurrentPayment(generation)
          set({ levels: [] })
        }

        let transaction: CashlogyTransaction
        const requestedIntent = { ...intent, chargeRequestedAt: new Date().toISOString() }
        persistIntent(requestedIntent)
        set({ intent: requestedIntent })
        try {
          transaction = (await client().createCashlogyCharge({
            requestId: requestedIntent.requestId,
            saleId: requestedIntent.saleId,
            amountCents: requestedIntent.amountCents,
            terminalCode: requestedIntent.terminalCode,
            test: false,
          }, signal)).transaction
        } catch (chargeError) {
          assertCurrentPayment(generation)
          const blockingId = getBlockingCashlogyTransactionId(chargeError)
          if (blockingId) {
            await openBlockingTransaction(blockingId, signal)
            // Never return an older payment as settlement of the new sale.
            throw new CashlogyError({ code: 'CASHLOGY_BUSY', message: 'Se ha recuperado una operación anterior. Resuélvela antes de iniciar este cobro.' })
          }
          if (!isUncertainCashlogyError(chargeError)) throw chargeError
          try {
            transaction = (await client().getCashlogyTransactionByRequestId(requestedIntent.requestId, signal)).transaction
          } catch {
            throw chargeError
          }
        }
        const identified = { ...requestedIntent, transactionId: transaction.id }
        assertCurrentPayment(generation)
        persistIntent(identified)
        set({ intent: identified, transaction })
        return await resolveTransaction(transaction, signal)
      } catch (error) {
        assertCurrentPayment(generation)
        const state = useCashlogyStore.getState()
        reportOperationError(error, { operation: 'cashlogy.payment', integration: 'cashlogy', operationId: state.intent?.requestId, saleId: state.intent?.saleId, step: state.transaction?.status ?? (state.intent?.chargeRequestedAt ? 'charge_requested' : 'health') })
        const mapped = toCashlogyError(error)
        set({ error: mapped })
        throw mapped
      } finally {
        if (generation === paymentGeneration) set({ isStarting: false })
      }
    })().finally(() => { if (generation === paymentGeneration) settlementPromise = null })
    return settlementPromise
  },

  async recover(signal) {
    if (recoveryPromise) return recoveryPromise
    let intent = get().intent
    if (!intent) return null
    if (get().isStarting || get().isCancelling) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    const generation = paymentGeneration
    paymentController = new AbortController()
    signal = signal ? AbortSignal.any([signal, paymentController.signal]) : paymentController.signal
    const blockingId = getBlockingCashlogyTransactionId(get().error)
    set({ error: null, isRecovering: true })
    recoveryPromise = (async () => {
      try {
        if (blockingId) {
          await openBlockingTransaction(blockingId, signal)
          intent = get().intent!
        }
        let transaction = await findPaymentTransaction(intent, signal)
        assertCurrentPayment(generation)
        if (!transaction) {
          set({ transaction: null, missingTransaction: true })
          throw new CashlogyError({ code: 'CASHLOGY_TRANSACTION_NOT_FOUND' })
        }
        set({ missingTransaction: false })
        if (intent.recoveredFromConflict) adoptBlockingTransaction(transaction)
        if (transaction.warning?.code === 'CASHLOGY_RECOVERY_PENDING')
          transaction = (await client().recoverCashlogyTransaction(transaction.id, signal)).transaction
        assertCurrentPayment(generation)
        if (!intent.recoveredFromConflict && intent.transactionId !== transaction.id) {
          const identified = { ...intent, transactionId: transaction.id }
          persistIntent(identified)
          set({ intent: identified })
        }
        return await resolveTransaction(transaction, signal)
      } catch (error) {
        assertCurrentPayment(generation)
        const state = useCashlogyStore.getState()
        reportOperationError(error, { operation: 'cashlogy.payment', integration: 'cashlogy', operationId: state.intent?.requestId, saleId: state.intent?.saleId, step: state.transaction?.status ?? (state.intent?.chargeRequestedAt ? 'charge_requested' : 'health') })
        const mapped = toCashlogyError(error)
        // Keep background retries silent; resolveTransaction opens confirmed results.
        set({ error: mapped })
        throw mapped
      }
    })().finally(() => {
      if (generation !== paymentGeneration) return
      recoveryPromise = null
      set({ isRecovering: false })
    })
    return recoveryPromise
  },

  async cancel(reviewed = false) {
    if (get().isCancelling) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    const intent = get().intent
    if (!intent) return null
    stopPaymentRequests()
    const generation = paymentGeneration
    let transaction = get().transaction
    set({ isCancelling: true, error: null })
    try {
      // Before the charge request there is no physical operation to cancel.
      if (!transaction && intent.chargeRequestedAt === null && !intent.recoveredFromConflict) {
        releasePayment()
        return null
      }
      transaction ??= await findPaymentTransaction(intent)
      assertCurrentPayment(generation)
      if (!transaction) {
        // A 404 is different from a timeout. Check that the agent has not
        // identified this request as active before releasing its local intent.
        const health = await client().getCashlogyHealth()
        assertCurrentPayment(generation)
        if (health.activeTransaction?.requestId === intent.requestId) {
          transaction = (await client().getCashlogyTransaction(health.activeTransaction.id)).transaction
          assertCurrentPayment(generation)
        } else {
          releasePayment()
          return null
        }
      }
      set({ transaction })
      if (cashlogyActiveStatuses.has(transaction.status)) {
        if (!cashlogyCancellableStatuses.has(transaction.status)) {
          if (!reviewed) throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'Cashlogy está cerrando la admisión o entregando efectivo. Revisa el efectivo y confirma que quieres esperar al resultado antes de cancelar este intento.' })
          set({ isPolling: true })
          transaction = await pollTransaction(transaction, undefined, 30_000)
        } else {
          const next = (await client().cancelCashlogyTransaction(transaction.id)).transaction
          assertCurrentPayment(generation)
          set({ transaction: next, isPolling: cashlogyActiveStatuses.has(next.status) })
          transaction = await pollTransaction(next, undefined, 30_000)
        }
        assertCurrentPayment(generation)
        set({ transaction, isPolling: false })
      }
      if (['unknown', 'needs_attention', 'completed'].includes(transaction.status) && !reviewed) {
        throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'La operación pudo aceptar efectivo o ya está cobrada. Revisa la máquina antes de cancelar el registro de este intento; cancelar no devuelve ese efectivo.' })
      }
      releasePayment(reviewed)
      return transaction
    } catch (error) {
      assertCurrentPayment(generation)
      const state = useCashlogyStore.getState()
      reportOperationError(error, { operation: 'cashlogy.payment', integration: 'cashlogy', operationId: state.intent?.requestId, saleId: state.intent?.saleId, step: state.transaction?.status ?? (state.intent?.chargeRequestedAt ? 'charge_requested' : 'health') })
      const mapped = toCashlogyError(error)
      set({ error: mapped })
      throw mapped
    } finally {
      if (generation === paymentGeneration) set({ isCancelling: false, isStarting: false, isRecovering: false, isPolling: false })
    }
  },

  async retryPayment(reviewed = false) {
    const intent = get().intent
    if (!intent || get().isStarting || get().isCancelling || get().isRecovering || get().isPolling) {
      throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    }
    stopPaymentRequests()
    const generation = paymentGeneration
    set({ isRecovering: true, error: null })
    try {
      let transaction = await findPaymentTransaction(intent)
      assertCurrentPayment(generation)
      if (transaction) {
        // Never recover an absent transaction. For an existing one, consult
        // the agent before deciding whether another physical charge is needed.
        transaction = (await client().recoverCashlogyTransaction(transaction.id)).transaction
        assertCurrentPayment(generation)
        set({ transaction, missingTransaction: false })
        if (cashlogyActiveStatuses.has(transaction.status)) return await resolveTransaction(transaction)
        if (transaction.status === 'completed' && !intent.recoveredFromConflict) return transaction
        if (['unknown', 'needs_attention', 'completed'].includes(transaction.status) && !reviewed) {
          throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'Revisa el efectivo antes de iniciar otro cobro.' })
        }
        // Await the close: the agent must release the previous operation before
        // accepting a new requestId. Its event history retains the old result.
        const scope = get().scope
        const queue = scope ? cashlogyAcknowledgements(scope, usePrintAgentStore.getState().baseUrl) : null
        if (queue) queue.add(transaction.id, reviewed)
        if (queue) await queue.flush(client().acknowledgeCashlogyTransaction)
        else await client().acknowledgeCashlogyTransaction(transaction.id, reviewed)
        assertCurrentPayment(generation)
      }
      persistIntent(null)
      set({ intent: null, transaction: null, error: null, isRecovering: false, missingTransaction: false })
      return await get().startPayment(intent.amountCents, intent.saleId)
    } catch (error) {
      const mapped = toCashlogyError(error)
      if (generation === paymentGeneration) set({ error: mapped })
      throw mapped
    } finally {
      if (generation === paymentGeneration) set({ isRecovering: false })
    }
  },

  finish(requestId) {
    if (get().intent?.requestId !== requestId) return
    const flush = acknowledgeClosed(get().transaction)
    persistIntent(null)
    set({ intent: null, transaction: null, levels: [], error: null, modalOpen: false, isPolling: false })
    flush?.()
  },

  discardForRetry() {
    const status = get().transaction?.status
    const failedBeforeTransaction = !get().transaction && Boolean(get().error) && !get().isStarting && !get().isPolling
    if (status !== 'cancelled' && status !== 'failed' && !failedBeforeTransaction) return
    if (failedBeforeTransaction && get().intent?.recoveredFromConflict) return
    if (failedBeforeTransaction && get().intent?.chargeRequestedAt && isUncertainCashlogyError(get().error)) return
    const flush = acknowledgeClosed(get().transaction)
    persistIntent(null)
    set({ intent: null, transaction: null, levels: [], error: null, modalOpen: false, isPolling: false })
    flush?.()
  },

  closeReviewed() {
    const status = get().transaction?.status
    if (!['unknown', 'needs_attention'].includes(status ?? '') && !(status === 'completed' && get().intent?.recoveredFromConflict)) return
    const flush = acknowledgeClosed(get().transaction, true)
    persistIntent(null)
    set({ intent: null, transaction: null, levels: [], error: null, modalOpen: false, isPolling: false })
    flush?.()
  },

  hide() {
    set({ modalOpen: false })
  },

  show() {
    if (get().intent) set({ modalOpen: true })
  },

  clearError() { set({ error: null }) },
}))

export async function settleCashlogyPaymentIfConfigured(amountCents: number, saleId: string | null = null) {
  if (!usePrintAgentStore.getState().cashlogyConfigured) return null
  return useCashlogyStore.getState().startPayment(amountCents, saleId)
}

export function finishCashlogyPayment(transaction: CashlogyTransaction | null) {
  if (transaction) useCashlogyStore.getState().finish(transaction.requestId)
}

export function getCashlogyPaymentSaleId(transaction: CashlogyTransaction) {
  if (transaction.saleId) return transaction.saleId
  const intent = useCashlogyStore.getState().intent
  // Some recovered backend responses omit the optional saleId. Only reuse the
  // locally persisted identity for this exact charge, never for a blocker.
  if (!intent || intent.recoveredFromConflict
    || intent.requestId !== transaction.requestId
    || intent.amountCents !== transaction.requestedAmountCents
    || (intent.transactionId && intent.transactionId !== transaction.id)) return null
  return intent.saleId
}

export function getCashlogyPaymentAmounts(transaction: CashlogyTransaction | null, requestedAmountCents: number) {
  if (!transaction) return { receivedCents: null, changeCents: null }
  const acceptedCents = (transaction.automaticAcceptedCents ?? 0) + (transaction.manualAcceptedCents ?? 0)
  return {
    receivedCents: acceptedCents || transaction.netPaidCents || requestedAmountCents,
    changeCents: transaction.returnedCents ?? Math.max(0, (transaction.netPaidCents ?? requestedAmountCents) - requestedAmountCents),
  }
}
