import { create } from 'zustand'
import { createPrintAgentClient } from '../api/printAgentClient'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { CashlogyHealth, CashlogyIntent, CashlogyTransaction, PrintAgentScope } from '../types'
import { CashlogyError, isUncertainCashlogyError, toCashlogyError } from './cashlogyError'
import { createCashlogyRequestId } from './cashlogyRequestId'
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
  error: CashlogyError | null
  modalOpen: boolean
  isCheckingHealth: boolean
  isStarting: boolean
  isPolling: boolean
  isCancelling: boolean
  configureScope: (scope: PrintAgentScope) => void
  checkHealth: (signal?: AbortSignal) => Promise<CashlogyHealth>
  startPayment: (amountCents: number, saleId?: string | null, signal?: AbortSignal) => Promise<CashlogyTransaction>
  recover: (signal?: AbortSignal) => Promise<CashlogyTransaction | null>
  cancel: (signal?: AbortSignal) => Promise<CashlogyTransaction>
  finish: (requestId: string) => void
  discardForRetry: () => void
  hide: () => void
  clearError: () => void
}

let settlementPromise: Promise<CashlogyTransaction> | null = null
let recoveryPromise: Promise<CashlogyTransaction | null> | null = null
let transactionPollingPromise: Promise<CashlogyTransaction> | null = null
let transactionPollingController: AbortController | null = null

function client() {
  const print = usePrintAgentStore.getState()
  return createPrintAgentClient({ baseUrl: print.baseUrl, token: print.token })
}

function persistIntent(intent: CashlogyIntent | null) {
  const scope = useCashlogyStore.getState().scope
  if (scope) saveCashlogyIntent(scope, intent)
}

function pollTransaction(transaction: CashlogyTransaction, signal?: AbortSignal) {
  if (!cashlogyActiveStatuses.has(transaction.status)) return Promise.resolve(transaction)
  if (transactionPollingPromise) return transactionPollingPromise
  transactionPollingController = new AbortController()
  const pollingSignal = signal
    ? AbortSignal.any([signal, transactionPollingController.signal])
    : transactionPollingController.signal
  transactionPollingPromise = pollCashlogyTransaction(client().getCashlogyTransaction, transaction, {
    signal: pollingSignal,
    onUpdate: (next) => useCashlogyStore.setState({ transaction: next }),
  }).finally(() => {
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
    message: transaction.error?.message || 'Cashlogy ha confirmado que el cobro ha fallado.',
    originalCode: transaction.normalizedErrorCode ?? transaction.error?.code,
    details: transaction,
  })
}

async function resolveTransaction(transaction: CashlogyTransaction, signal?: AbortSignal) {
  useCashlogyStore.setState({ transaction, isPolling: cashlogyActiveStatuses.has(transaction.status), modalOpen: true })
  try {
    const terminal = await pollTransaction(transaction, signal)
    useCashlogyStore.setState({ transaction: terminal, isPolling: false })
    if (terminal.status !== 'completed') {
      const error = terminalError(terminal)
      useCashlogyStore.setState({ error })
      throw error
    }
    return terminal
  } catch (error) {
    const mapped = toCashlogyError(error)
    useCashlogyStore.setState({ error: mapped, isPolling: false })
    throw mapped
  }
}

export const useCashlogyStore = create<CashlogyState>((set, get) => ({
  scope: null,
  intent: null,
  transaction: null,
  error: null,
  modalOpen: false,
  isCheckingHealth: false,
  isStarting: false,
  isPolling: false,
  isCancelling: false,

  configureScope(scope) {
    transactionPollingController?.abort()
    settlementPromise = null
    recoveryPromise = null
    transactionPollingPromise = null
    const intent = loadCashlogyIntent(scope)
    set({ scope, intent, transaction: null, error: null, modalOpen: Boolean(intent), isPolling: false })
  },

  async checkHealth(signal) {
    set({ isCheckingHealth: true, error: null })
    try {
      const health = await usePrintAgentStore.getState().checkCashlogyHealth(signal)
      return health
    } catch (error) {
      const mapped = toCashlogyError(error)
      set({ error: mapped })
      throw mapped
    } finally {
      set({ isCheckingHealth: false })
    }
  },

  async startPayment(amountCents, saleId = null, signal) {
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
      if (existing.amountCents !== amountCents) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
      if (settlementPromise) return settlementPromise
      settlementPromise = get().recover(signal).then((transaction) => {
        if (!transaction) throw new CashlogyError({ code: 'CASHLOGY_STATUS_UNKNOWN' })
        return transaction
      }).finally(() => { settlementPromise = null })
      return settlementPromise
    }

    if (get().isStarting || get().isPolling) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    set({ isStarting: true })
    let health: CashlogyHealth
    try {
      health = await get().checkHealth(signal)
    } catch (error) {
      set({ isStarting: false })
      throw error
    }
    if (!(health.enabled && health.ok && health.sessionState === 'ready')) {
      const error = new CashlogyError({
        code: health.enabled ? 'CASHLOGY_NOT_READY' : 'CASHLOGY_DISABLED',
        message: health.lastError?.message || undefined,
        originalCode: health.lastError?.code,
        details: health,
      })
      set({ error, modalOpen: true, isStarting: false })
      throw error
    }

    const intent: CashlogyIntent = {
      requestId: createCashlogyRequestId('payment'),
      saleId,
      amountCents,
      terminalCode: print.cashlogyTerminalCode,
      transactionId: null,
      createdAt: new Date().toISOString(),
    }
    persistIntent(intent)
    set({ intent, transaction: null, error: null, modalOpen: true, isStarting: true })
    settlementPromise = (async () => {
      try {
        let transaction: CashlogyTransaction
        try {
          transaction = (await client().createCashlogyCharge({
            requestId: intent.requestId,
            saleId: intent.saleId,
            amountCents: intent.amountCents,
            terminalCode: intent.terminalCode,
            test: false,
          }, signal)).transaction
        } catch (chargeError) {
          if (!isUncertainCashlogyError(chargeError)) {
            persistIntent(null)
            set({ intent: null, modalOpen: false })
            throw chargeError
          }
          try {
            transaction = (await client().getCashlogyTransactionByRequestId(intent.requestId, signal)).transaction
          } catch {
            throw chargeError
          }
        }
        const identified = { ...intent, transactionId: transaction.id }
        persistIntent(identified)
        set({ intent: identified, transaction })
        return await resolveTransaction(transaction, signal)
      } catch (error) {
        const mapped = toCashlogyError(error)
        set({ error: mapped })
        throw mapped
      } finally {
        set({ isStarting: false })
      }
    })().finally(() => { settlementPromise = null })
    return settlementPromise
  },

  async recover(signal) {
    if (recoveryPromise) return recoveryPromise
    const intent = get().intent
    if (!intent) return null
    set({ modalOpen: true, error: null })
    recoveryPromise = (async () => {
      try {
        const transaction = (await client().getCashlogyTransactionByRequestId(intent.requestId, signal)).transaction
        if (intent.transactionId !== transaction.id) {
          const identified = { ...intent, transactionId: transaction.id }
          persistIntent(identified)
          set({ intent: identified })
        }
        return await resolveTransaction(transaction, signal)
      } catch (error) {
        const mapped = toCashlogyError(error)
        set({ error: mapped, modalOpen: true })
        throw mapped
      }
    })().finally(() => { recoveryPromise = null })
    return recoveryPromise
  },

  async cancel(signal) {
    if (get().isCancelling) throw new CashlogyError({ code: 'CASHLOGY_BUSY' })
    const transaction = get().transaction
    if (!transaction || !cashlogyCancellableStatuses.has(transaction.status)) {
      throw new CashlogyError({ code: 'CASHLOGY_INVALID_STATE', message: 'Cashlogy ya no admite cancelar esta fase del cobro.' })
    }
    set({ isCancelling: true, error: null })
    try {
      const next = (await client().cancelCashlogyTransaction(transaction.id, signal)).transaction
      set({ transaction: next, isPolling: cashlogyActiveStatuses.has(next.status) })
      const terminal = await pollTransaction(next, signal)
      set({ transaction: terminal, isPolling: false })
      if (terminal.status !== 'cancelled') throw terminalError(terminal)
      return terminal
    } catch (error) {
      const mapped = toCashlogyError(error)
      set({ error: mapped })
      throw mapped
    } finally {
      set({ isCancelling: false })
    }
  },

  finish(requestId) {
    if (get().intent?.requestId !== requestId) return
    persistIntent(null)
    set({ intent: null, transaction: null, error: null, modalOpen: false, isPolling: false })
  },

  discardForRetry() {
    const status = get().transaction?.status
    if (status !== 'cancelled' && status !== 'failed') return
    persistIntent(null)
    set({ intent: null, transaction: null, error: null, modalOpen: false, isPolling: false })
  },

  hide() {
    set({ modalOpen: false })
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

export function getCashlogyPaymentAmounts(transaction: CashlogyTransaction | null, requestedAmountCents: number) {
  if (!transaction) return { receivedCents: null, changeCents: null }
  const acceptedCents = (transaction.automaticAcceptedCents ?? 0) + (transaction.manualAcceptedCents ?? 0)
  return {
    receivedCents: acceptedCents || transaction.netPaidCents || requestedAmountCents,
    changeCents: transaction.returnedCents ?? Math.max(0, (transaction.netPaidCents ?? requestedAmountCents) - requestedAmountCents),
  }
}
